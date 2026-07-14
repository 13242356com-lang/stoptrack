"""The gateway core: poll -> edge detect -> rules -> emit.

Owns the open-stop state so a ``stop_ended`` is paired with its
``stop_started`` and carries a computed duration (spec §3). Adapters and
sinks are injected; this module knows nothing about protocols.

Debounce (``min_stop_ms``): a stop_started cannot be un-emitted, so to
"ignore stops shorter than N ms" the started event is HELD until the stop
has been open for N ms. If the machine recovers sooner, both events are
suppressed (a micro-pause never happened, as far as StopTrack is told).
When the held event is finally emitted it carries the ORIGINAL start
timestamp, so durations stay truthful.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from .adapter import PLCAdapter, TagSpec
from .edge import EdgeDetector
from .events import EventSink, now_ms, stop_ended, stop_started
from .rules import Firing, RuleEngine

log = logging.getLogger(__name__)


@dataclass
class MachineRuntime:
    """Everything the poll loop needs for one machine."""

    name: str
    adapter: PLCAdapter
    tags: list[TagSpec]
    rules: RuleEngine
    open_stop_ts: int | None = field(default=None)
    started_emitted: bool = field(default=False)


class Gateway:
    def __init__(
        self,
        machines: list[MachineRuntime],
        sinks: list[EventSink],
        poll_interval_ms: int,
        min_stop_ms: int = 0,
    ) -> None:
        self._machines = machines
        self._sinks = sinks
        self._poll_interval = poll_interval_ms / 1000.0
        self._min_stop_ms = max(0, min_stop_ms)
        self._edges = EdgeDetector()
        self._stopping = asyncio.Event()

    def request_stop(self) -> None:
        self._stopping.set()

    async def run(self) -> None:
        for m in self._machines:
            await m.adapter.connect()
            log.info("connected: %s (%s tags)", m.name, len(m.tags))
        try:
            while not self._stopping.is_set():
                await self.poll_once()
                try:
                    await asyncio.wait_for(self._stopping.wait(), timeout=self._poll_interval)
                except asyncio.TimeoutError:
                    pass  # normal tick
        finally:
            for m in self._machines:
                await m.adapter.disconnect()
            for s in self._sinks:
                await s.close()
            log.info("gateway stopped")

    async def poll_once(self) -> None:
        """One full cycle: read, detect edges, apply rules, flush held starts.

        Public so tests can drive the gateway tick by tick without timers.
        """
        for m in self._machines:
            if not m.adapter.is_connected():
                log.warning("adapter for %s not connected; skipping poll", m.name)
                continue
            values = await m.adapter.read_many(m.tags)
            for edge in self._edges.detect(m.name, values):
                for firing in m.rules.evaluate(edge, values):
                    await self._apply_firing(m, firing)
            await self._flush_held_start(m)

    async def _apply_firing(self, m: MachineRuntime, firing: Firing) -> None:
        ts = now_ms()
        if firing.emit == "stop_started":
            if m.open_stop_ts is not None:
                log.warning("%s: stop_started while a stop was already open; restarting", m.name)
            m.open_stop_ts = ts
            m.started_emitted = False
            if self._min_stop_ms == 0:
                m.started_emitted = True
                await self._broadcast(stop_started(m.name, ts))
            # else: held — _flush_held_start emits once the stop survives the debounce
        elif firing.emit == "stop_ended":
            if m.open_stop_ts is None:
                log.warning("%s: stop_ended with no open stop; ignoring", m.name)
                return
            start = m.open_stop_ts
            duration = ts - start
            emitted = m.started_emitted
            m.open_stop_ts = None
            m.started_emitted = False
            if not emitted and duration < self._min_stop_ms:
                log.debug("%s: suppressed micro-stop of %dms (< min_stop_ms %d)",
                          m.name, duration, self._min_stop_ms)
                return
            if not emitted:
                # Ended in the same poll it crossed the threshold — emit the
                # held start first so the pair stays ordered.
                await self._broadcast(stop_started(m.name, start))
            await self._broadcast(
                stop_ended(m.name, start=start, ts=ts, reason=firing.reason, fault_code=firing.fault_code)
            )

    async def _flush_held_start(self, m: MachineRuntime) -> None:
        """Emit a held stop_started once the stop has outlived the debounce."""
        if m.open_stop_ts is None or m.started_emitted:
            return
        if now_ms() - m.open_stop_ts >= self._min_stop_ms:
            m.started_emitted = True
            await self._broadcast(stop_started(m.name, m.open_stop_ts))

    async def _broadcast(self, event: dict) -> None:
        for sink in self._sinks:
            try:
                await sink.emit(event)
            except Exception:  # a sink failure must never kill the poll loop
                log.exception("sink %s failed", type(sink).__name__)
