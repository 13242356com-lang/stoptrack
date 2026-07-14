"""Shared test fixtures: a fake adapter, a capture sink, machine builders.

The FakeAdapter drives the gateway synchronously from tests (set values,
call poll_once) — no timers, no sleeping except where debounce is the thing
under test.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Sequence

# Make `plc_gateway` importable when pytest runs from the gateway/ folder.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from plc_gateway.core.adapter import PLCAdapter, TagSpec, TagValue  # noqa: E402
from plc_gateway.core.events import Event, EventSink  # noqa: E402
from plc_gateway.core.gateway import Gateway, MachineRuntime  # noqa: E402
from plc_gateway.core.rules import RuleEngine, parse_rule  # noqa: E402

TAGS = [
    TagSpec(name="running", address="DB1.DBX0.0", type="bool"),
    TagSpec(name="faultCode", address="DB1.DBW2", type="int"),
]

FAULT_MAP = {4: "Teflon change", 7: "Foil / infeed jam"}

RULES_RAW = [
    {"when": "running edge false", "emit": "stop_started"},
    {"when": "running edge true", "emit": "stop_ended", "enrich": {"reason_from": "faultCode"}},
]


class FakeAdapter(PLCAdapter):
    """In-test adapter: values are a plain dict the test mutates directly."""

    def __init__(self, values: dict[str, TagValue]) -> None:
        self.values = dict(values)
        self._connected = False

    async def connect(self) -> None:
        self._connected = True

    async def disconnect(self) -> None:
        self._connected = False

    async def list_tags(self) -> list[TagSpec]:
        return TAGS

    async def read(self, tag: TagSpec) -> TagValue:
        return self.values[tag.name]

    # read_many deliberately NOT overridden — exercises the ABC's default loop.

    def is_connected(self) -> bool:
        return self._connected


class CaptureSink(EventSink):
    def __init__(self) -> None:
        self.events: list[Event] = []

    async def emit(self, event: Event) -> None:
        self.events.append(event)

    def of_type(self, kind: str) -> list[Event]:
        return [e for e in self.events if e["type"] == kind]


def make_gateway(min_stop_ms: int = 0, running: bool = True, fault: int = 0):
    """One fake machine wired into a Gateway; returns (gateway, adapter, sink)."""
    adapter = FakeAdapter({"running": running, "faultCode": fault})
    sink = CaptureSink()
    machine = MachineRuntime(
        name="ASLA 1 - Laser",
        adapter=adapter,
        tags=TAGS,
        rules=RuleEngine([parse_rule(r) for r in RULES_RAW], FAULT_MAP),
    )
    gw = Gateway(machines=[machine], sinks=[sink], poll_interval_ms=10, min_stop_ms=min_stop_ms)
    return gw, adapter, sink
