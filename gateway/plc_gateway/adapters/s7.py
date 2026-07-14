"""S7Adapter — reads a Siemens S7-1200/1500 (or a snap7 simulator) via snap7.

READ-ONLY: this adapter calls only ``db_read`` and the ``snap7.util.get_*``
helpers. It defines no write method and must never gain one.

Addresses use S7 data-block notation:
  DB<n>.DBX<byte>.<bit>  -> bool
  DB<n>.DBW<byte>        -> int   (16-bit word, signed)
  DB<n>.DBD<byte>        -> int/real (32-bit dword; 'real' tag => float)

``read_many`` groups tags by DB and issues one ``db_read`` per DB over the
spanning byte range — a true batch read, the networked path the in-process
simulator can't exercise.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Sequence

from ..core.adapter import PLCAdapter, TagSpec, TagValue

log = logging.getLogger(__name__)

_ADDR_RE = re.compile(r"^DB(\d+)\.DB([XWD])(\d+)(?:\.(\d+))?$", re.IGNORECASE)
_WIDTH = {"X": 1, "W": 2, "D": 4}  # bytes touched by each access kind


@dataclass(frozen=True)
class S7Address:
    db: int
    kind: str        # "X" bit | "W" word | "D" dword
    byte: int
    bit: int         # meaningful only for kind == "X"

    @property
    def width(self) -> int:
        return _WIDTH[self.kind]


def parse_s7_address(address: str) -> S7Address:
    """Parse an S7 DB address; raise ValueError with a clear message if malformed."""
    m = _ADDR_RE.match(address.strip())
    if not m:
        raise ValueError(f"bad S7 address {address!r} (expected e.g. DB1.DBX0.0, DB1.DBW2, DB1.DBD4)")
    db, kind, byte, bit = int(m.group(1)), m.group(2).upper(), int(m.group(3)), m.group(4)
    if kind == "X":
        if bit is None or not (0 <= int(bit) <= 7):
            raise ValueError(f"bad S7 bit address {address!r} (bit must be 0-7, e.g. DB1.DBX0.3)")
        return S7Address(db=db, kind="X", byte=byte, bit=int(bit))
    if bit is not None:
        raise ValueError(f"bad S7 address {address!r} ({kind}-access takes no bit index)")
    return S7Address(db=db, kind=kind, byte=byte, bit=0)


def _decode(buf: bytearray, offset: int, addr: S7Address, tag_type: str) -> TagValue:
    from snap7 import util
    if addr.kind == "X":
        return util.get_bool(buf, offset, addr.bit)
    if addr.kind == "W":
        return util.get_int(buf, offset)
    # kind == "D"
    return util.get_real(buf, offset) if tag_type == "real" else util.get_dint(buf, offset)


class S7Adapter(PLCAdapter):
    def __init__(self, machine: str, tags: list[TagSpec], conn: dict) -> None:
        self._machine = machine
        self._tags = tags
        self._host = conn["host"]
        self._rack = int(conn.get("rack", 0))
        self._slot = int(conn.get("slot", 1))
        self._port = int(conn.get("port", 102))
        self._client = None
        # Pre-parse addresses once; a bad address fails fast at construction.
        self._addr: dict[str, S7Address] = {t.name: parse_s7_address(t.address) for t in tags}
        self._type: dict[str, str] = {t.name: t.type for t in tags}

    async def connect(self) -> None:
        try:
            import snap7  # lazy: a missing lib breaks only this adapter
        except ImportError as exc:
            raise ConnectionError("python-snap7 is not installed — run 'pip install python-snap7'") from exc
        self._client = snap7.client.Client()
        try:
            self._client.connect(self._host, self._rack, self._slot, tcp_port=self._port)
        except Exception as exc:
            raise ConnectionError(
                f"[s7 {self._machine}] could not connect to {self._host}:{self._port} "
                f"rack {self._rack} slot {self._slot}: {exc}"
            ) from exc
        log.info("[s7 %s] connected to %s:%d rack %d slot %d",
                 self._machine, self._host, self._port, self._rack, self._slot)

    async def disconnect(self) -> None:
        if self._client is not None:
            try:
                self._client.disconnect()
                self._client.destroy()
            except Exception:
                pass
            self._client = None

    async def list_tags(self) -> list[TagSpec]:
        return list(self._tags)

    async def read(self, tag: TagSpec) -> TagValue:
        a = self._addr[tag.name]
        buf = self._client.db_read(a.db, a.byte, a.width)
        return _decode(buf, 0, a, self._type[tag.name])

    async def read_many(self, tags: Sequence[TagSpec]) -> dict[str, TagValue]:
        # Group by DB; one db_read per DB across the spanning byte range.
        by_db: dict[int, list[TagSpec]] = {}
        for t in tags:
            by_db.setdefault(self._addr[t.name].db, []).append(t)
        out: dict[str, TagValue] = {}
        for db, db_tags in by_db.items():
            addrs = [self._addr[t.name] for t in db_tags]
            start = min(a.byte for a in addrs)
            end = max(a.byte + a.width for a in addrs)
            buf = self._client.db_read(db, start, end - start)
            for t in db_tags:
                a = self._addr[t.name]
                out[t.name] = _decode(buf, a.byte - start, a, self._type[t.name])
        return out

    def is_connected(self) -> bool:
        try:
            return bool(self._client and self._client.get_connected())
        except Exception:
            return False
