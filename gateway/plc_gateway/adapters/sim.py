"""SimAdapter — an in-process fake PLC, flavored like a Siemens S7-1500.

Runs on a laptop with no hardware and no network. Holds tag values in memory
and can be driven two ways:

- a **scripted timeline** from config: ``[{at_ms: 3000, set: {running: false,
  faultCode: 4}}, ...]`` — used by the automated acceptance demo;
- **interactive stdin commands** while the gateway runs: ``stop [fault]``,
  ``run``, ``status`` — portable on Windows (line input, no raw keypresses).

Optional per-read jitter makes polling realistically imperfect. Like every
adapter, it is read-only: values change only via the timeline/CLI drivers,
never through the PLCAdapter interface.
"""
from __future__ import annotations

import asyncio
import logging
import random
import sys
import time
from typing import Any, Optional, Sequence

from ..core.adapter import PLCAdapter, TagSpec, TagValue

log = logging.getLogger(__name__)


class SimAdapter(PLCAdapter):
    def __init__(
        self,
        machine: str,
        tags: list[TagSpec],
        timeline: Optional[list[dict[str, Any]]] = None,
        jitter_ms: int = 0,
        interactive: bool = False,
    ) -> None:
        self._machine = machine
        self._tags = tags
        self._timeline = sorted(timeline or [], key=lambda e: e.get("at_ms", 0))
        self._jitter_ms = max(0, jitter_ms)
        self._interactive = interactive
        self._connected = False
        self._t0 = 0.0
        self._stdin_task: Optional[asyncio.Task] = None
        # The fake PLC's memory, keyed by logical tag name.
        self._values: dict[str, TagValue] = {"running": True, "faultCode": 0, "cycleCount": 0}

    # --- PLCAdapter contract -------------------------------------------------
    async def connect(self) -> None:
        self._t0 = time.monotonic()
        self._connected = True
        log.info("[sim %s] connected (timeline: %d steps, interactive: %s)",
                 self._machine, len(self._timeline), self._interactive)
        if self._interactive:
            self._stdin_task = asyncio.create_task(self._stdin_loop())

    async def disconnect(self) -> None:
        self._connected = False
        if self._stdin_task:
            self._stdin_task.cancel()
            self._stdin_task = None

    async def list_tags(self) -> list[TagSpec]:
        return list(self._tags)

    async def read(self, tag: TagSpec) -> TagValue:
        if not self._connected:
            raise ConnectionError(f"[sim {self._machine}] read before connect()")
        self._advance()
        if self._jitter_ms:
            await asyncio.sleep(random.uniform(0, self._jitter_ms) / 1000.0)
        if tag.name not in self._values:
            raise KeyError(f"[sim {self._machine}] unknown tag {tag.name!r} ({tag.address})")
        return self._values[tag.name]

    async def read_many(self, tags: Sequence[TagSpec]) -> dict[str, TagValue]:
        # One advance + at most one jitter per batch — closer to a real batch read.
        if not self._connected:
            raise ConnectionError(f"[sim {self._machine}] read before connect()")
        self._advance()
        if self._jitter_ms:
            await asyncio.sleep(random.uniform(0, self._jitter_ms) / 1000.0)
        out: dict[str, TagValue] = {}
        for tag in tags:
            if tag.name not in self._values:
                raise KeyError(f"[sim {self._machine}] unknown tag {tag.name!r} ({tag.address})")
            out[tag.name] = self._values[tag.name]
        return out

    def is_connected(self) -> bool:
        return self._connected

    # --- drivers (not part of the adapter contract) ---------------------------
    def _advance(self) -> None:
        """Apply timeline steps that are due, and tick the cycle counter."""
        elapsed_ms = (time.monotonic() - self._t0) * 1000.0
        while self._timeline and self._timeline[0].get("at_ms", 0) <= elapsed_ms:
            step = self._timeline.pop(0)
            changes = step.get("set", {})
            self._values.update(changes)
            log.info("[sim %s] timeline @%dms -> %s", self._machine, step.get("at_ms", 0), changes)
        if self._values.get("running"):
            self._values["cycleCount"] = int(self._values.get("cycleCount", 0)) + 1

    async def _stdin_loop(self) -> None:
        """Interactive driver: 'stop [faultCode]', 'run', 'status'."""
        loop = asyncio.get_running_loop()
        print(f"[sim {self._machine}] interactive: type 'stop [fault]', 'run', 'status'", flush=True)
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                return
            parts = line.strip().lower().split()
            if not parts:
                continue
            if parts[0] == "stop":
                self._values["running"] = False
                if len(parts) > 1 and parts[1].isdigit():
                    self._values["faultCode"] = int(parts[1])
                print(f"[sim {self._machine}] running=False fault={self._values['faultCode']}", flush=True)
            elif parts[0] == "run":
                self._values["running"] = True
                print(f"[sim {self._machine}] running=True", flush=True)
            elif parts[0] == "status":
                print(f"[sim {self._machine}] {self._values}", flush=True)
