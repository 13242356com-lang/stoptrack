"""ConsoleSink — prints events for humans. The zero-app test surface.

As a sink it is allowed to print (the rest of the library uses logging).
"""
from __future__ import annotations

import time

from ..core.events import Event, EventSink


def _clock(ts_ms: int) -> str:
    return time.strftime("%H:%M:%S", time.localtime(ts_ms / 1000))


def _dur(ms: int) -> str:
    s = ms // 1000
    if s >= 3600:
        return f"{s // 3600}h {(s % 3600) // 60}m {s % 60}s"
    if s >= 60:
        return f"{s // 60}m {s % 60}s"
    return f"{s}s" if s > 0 else f"{ms}ms"


class ConsoleSink(EventSink):
    async def emit(self, event: Event) -> None:
        kind = event.get("type")
        machine = event.get("machine", "?")
        if kind == "stop_started":
            print(f"[{_clock(event['ts'])}] STOP started   {machine}", flush=True)
        elif kind == "stop_ended":
            reason = event.get("reason")
            fault = event.get("faultCode")
            tail = f", reason: {reason}" if reason else (f", faultCode: {fault}" if fault is not None else "")
            # ASCII only — Windows consoles on legacy codepages mangle em-dashes.
            print(
                f"[{_clock(event['ts'])}] STOP ended     {machine} - {_dur(event['duration'])}{tail}",
                flush=True,
            )
        else:
            print(f"[{_clock(event.get('ts', 0))}] {kind} {event}", flush=True)
