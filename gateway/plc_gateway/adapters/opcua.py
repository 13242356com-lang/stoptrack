"""OPCUAAdapter — reads any OPC UA server (a test server, or a Siemens CPU with
its OPC UA server enabled) via asyncua.

READ-ONLY: calls only ``read_value`` / ``read_values``. No write method exists.

Tag addresses are OPC UA node ids, e.g. ``ns=2;s=Machine_Running``.
``read_many`` uses ``client.read_values`` — a single batched read request.
"""
from __future__ import annotations

import logging
from typing import Sequence

from ..core.adapter import PLCAdapter, TagSpec, TagValue

log = logging.getLogger(__name__)


class OPCUAAdapter(PLCAdapter):
    def __init__(self, machine: str, tags: list[TagSpec], conn: dict) -> None:
        self._machine = machine
        self._tags = tags
        self._endpoint = conn["endpoint"]
        self._client = None
        self._connected = False
        self._nodes: dict[str, object] = {}  # tag name -> asyncua Node (cached)

    async def connect(self) -> None:
        try:
            from asyncua import Client  # lazy: a missing lib breaks only this adapter
        except ImportError as exc:
            raise ConnectionError("asyncua is not installed — run 'pip install asyncua'") from exc
        self._client = Client(url=self._endpoint)
        try:
            await self._client.connect()
        except Exception as exc:
            raise ConnectionError(f"[opcua {self._machine}] could not connect to {self._endpoint}: {exc}") from exc
        self._nodes = {t.name: self._client.get_node(t.address) for t in self._tags}
        self._connected = True
        log.info("[opcua %s] connected to %s (%d nodes)", self._machine, self._endpoint, len(self._nodes))

    async def disconnect(self) -> None:
        self._connected = False
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:
                pass
            self._client = None

    async def list_tags(self) -> list[TagSpec]:
        return list(self._tags)

    async def read(self, tag: TagSpec) -> TagValue:
        return await self._nodes[tag.name].read_value()

    async def read_many(self, tags: Sequence[TagSpec]) -> dict[str, TagValue]:
        names = [t.name for t in tags]
        values = await self._client.read_values([self._nodes[n] for n in names])
        return dict(zip(names, values))

    def is_connected(self) -> bool:
        return self._connected
