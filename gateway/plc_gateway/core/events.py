"""Event format (the contract with StopTrack) and the sink base class.

Events are plain dicts shaped exactly as StopTrack expects (see the build
spec §3): timestamps are epoch milliseconds, auto-captured stops carry
``auto: true`` — the counterpart of StopTrack's existing ``manual: true``.
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from typing import Any, Optional

Event = dict[str, Any]


def now_ms() -> int:
    return int(time.time() * 1000)


def stop_started(machine: str, ts: Optional[int] = None) -> Event:
    return {"type": "stop_started", "machine": machine, "ts": ts if ts is not None else now_ms()}


def stop_ended(
    machine: str,
    start: int,
    ts: Optional[int] = None,
    reason: Optional[str] = None,
    fault_code: Optional[int] = None,
) -> Event:
    """A finished stop. The gateway pairs it with its start and computes duration."""
    end = ts if ts is not None else now_ms()
    ev: Event = {
        "type": "stop_ended",
        "machine": machine,
        "ts": end,
        "start": start,
        "duration": max(0, end - start),
        "auto": True,
    }
    if reason is not None:
        ev["reason"] = reason
    if fault_code is not None:
        ev["faultCode"] = fault_code
    return ev


class EventSink(ABC):
    """Where events go. Console first (testable with zero app), file and
    WebSocket later. Sinks must not raise on emit — log and carry on."""

    @abstractmethod
    async def emit(self, event: Event) -> None: ...

    async def close(self) -> None:  # optional override
        return None
