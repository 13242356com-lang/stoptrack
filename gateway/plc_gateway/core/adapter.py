"""The PLC adapter contract.

Every data source — simulator, S7, OPC UA, Modbus — implements this same
interface. Protocol details must never leak past this boundary: the rules
engine and event pipeline only ever see logical tag names and values.

READ-ONLY BY DESIGN. This contract intentionally defines no write method,
and none may be added. The gateway observes machines; it never commands them.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Sequence, Union

TagValue = Union[bool, int, float, str]


@dataclass(frozen=True)
class TagSpec:
    """One watchable tag: logical name + protocol address + declared type."""

    name: str      # logical name used in rules, e.g. "running"
    address: str   # protocol address, e.g. "DB1.DBX0.0"
    type: str      # "bool" | "int" | "real" | "string"


class PLCAdapter(ABC):
    """Abstract base for all protocol adapters (sim / s7 / opcua / modbus)."""

    @abstractmethod
    async def connect(self) -> None:
        """Open the connection. Raise ConnectionError with a clear message on failure."""

    @abstractmethod
    async def disconnect(self) -> None:
        """Close cleanly. Must be safe to call twice."""

    @abstractmethod
    async def list_tags(self) -> list[TagSpec]:
        """Available tags. A real browse for OPC UA; config-derived for S7/sim."""

    @abstractmethod
    async def read(self, tag: TagSpec) -> TagValue:
        """Current value of one tag."""

    async def read_many(self, tags: Sequence[TagSpec]) -> dict[str, TagValue]:
        """Batch read, keyed by logical tag name.

        Default implementation loops read(); adapters with true batch reads
        (S7 multi-var, OPC UA read lists) should override for efficiency.
        """
        return {tag.name: await self.read(tag) for tag in tags}

    @abstractmethod
    def is_connected(self) -> bool:
        """Cheap health check used by the poll loop."""
