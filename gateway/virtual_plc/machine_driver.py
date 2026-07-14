"""Shared driver for the virtual-PLC emulators.

Holds a machine's state (running / faultCode / cycleCount) and drives it two
ways — a scripted timeline and interactive stdin commands — exactly like the
in-process SimAdapter. Each emulator supplies a `push` callback that writes the
current state into its own backing store (a snap7 DB bytearray, or OPC UA nodes).
"""
from __future__ import annotations

import asyncio
import sys
import time
from typing import Any, Awaitable, Callable

State = dict[str, Any]
PushFn = Callable[[State], Any]  # may return an awaitable


async def _maybe_await(result: Any) -> None:
    if asyncio.iscoroutine(result):
        await result


async def run_machine(
    machine: str,
    push: PushFn,
    timeline: list[dict] | None = None,
    interactive: bool = False,
    tick_ms: int = 100,
) -> None:
    """Run the state machine until cancelled, pushing every change via `push`."""
    state: State = {"running": True, "faultCode": 0, "cycleCount": 0}
    steps = sorted(timeline or [], key=lambda e: e.get("at_ms", 0))
    await _maybe_await(push(state))
    print(f"[vplc {machine}] started (timeline: {len(steps)} steps, interactive: {interactive})", flush=True)

    if interactive:
        asyncio.create_task(_stdin_loop(machine, state, push))

    t0 = time.monotonic()
    while True:
        elapsed_ms = (time.monotonic() - t0) * 1000.0
        changed = False
        while steps and steps[0].get("at_ms", 0) <= elapsed_ms:
            step = steps.pop(0)
            state.update(step.get("set", {}))
            changed = True
            print(f"[vplc {machine}] timeline @{step.get('at_ms', 0)}ms -> {step.get('set', {})}", flush=True)
        if state.get("running"):
            state["cycleCount"] = int(state.get("cycleCount", 0)) + 1
            changed = True
        if changed:
            await _maybe_await(push(state))
        await asyncio.sleep(tick_ms / 1000.0)


async def _stdin_loop(machine: str, state: State, push: PushFn) -> None:
    loop = asyncio.get_running_loop()
    print(f"[vplc {machine}] interactive: 'stop [fault]', 'run', 'status'", flush=True)
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            return
        parts = line.strip().lower().split()
        if not parts:
            continue
        if parts[0] == "stop":
            state["running"] = False
            if len(parts) > 1 and parts[1].isdigit():
                state["faultCode"] = int(parts[1])
            await _maybe_await(push(state))
            print(f"[vplc {machine}] running=False fault={state['faultCode']}", flush=True)
        elif parts[0] == "run":
            state["running"] = True
            await _maybe_await(push(state))
            print(f"[vplc {machine}] running=True", flush=True)
        elif parts[0] == "status":
            print(f"[vplc {machine}] {state}", flush=True)
