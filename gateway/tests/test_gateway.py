"""Gateway integration: pairing, duration, debounce — driven poll by poll."""
import asyncio

from conftest import make_gateway


def run(coro):
    return asyncio.run(coro)


def test_full_stop_cycle_pairs_and_computes_duration():
    async def scenario():
        gw, adapter, sink = make_gateway()
        await adapter.connect()
        await gw.poll_once()                     # primes, no events
        adapter.values.update(running=False, faultCode=4)
        await gw.poll_once()                     # -> stop_started
        await gw.poll_once()                     # steady: nothing new
        adapter.values.update(running=True)      # fault still latched
        await gw.poll_once()                     # -> stop_ended
        return sink

    sink = run(scenario())
    started = sink.of_type("stop_started")
    ended = sink.of_type("stop_ended")
    assert len(started) == 1 and len(ended) == 1
    ev = ended[0]
    assert ev["machine"] == "Line 1 - Station A"
    assert ev["start"] == started[0]["ts"]
    assert ev["duration"] == ev["ts"] - ev["start"] >= 0
    assert ev["reason"] == "Tooling change"
    assert ev["faultCode"] == 4
    assert ev["auto"] is True


def test_steady_state_emits_nothing():
    async def scenario():
        gw, adapter, sink = make_gateway()
        await adapter.connect()
        for _ in range(20):
            await gw.poll_once()
        return sink

    assert run(scenario()).events == []


def test_stop_ended_without_open_stop_is_ignored():
    async def scenario():
        # Machine starts STOPPED; recovering without an observed start must not emit.
        gw, adapter, sink = make_gateway(running=False)
        await adapter.connect()
        await gw.poll_once()                    # primes with running=False
        adapter.values.update(running=True)
        await gw.poll_once()                    # ended-rule fires but no open stop
        return sink

    assert run(scenario()).events == []


def test_micro_stop_below_min_stop_ms_is_fully_suppressed():
    async def scenario():
        gw, adapter, sink = make_gateway(min_stop_ms=10_000)  # nothing survives this
        await adapter.connect()
        await gw.poll_once()
        adapter.values.update(running=False, faultCode=4)
        await gw.poll_once()                    # start held, not emitted
        adapter.values.update(running=True)
        await gw.poll_once()                    # ends early -> both suppressed
        for _ in range(5):
            await gw.poll_once()
        return sink

    assert run(scenario()).events == []


def test_long_stop_survives_debounce_with_original_start_ts():
    async def scenario():
        gw, adapter, sink = make_gateway(min_stop_ms=50)
        await adapter.connect()
        await gw.poll_once()
        adapter.values.update(running=False, faultCode=7)
        await gw.poll_once()                    # held
        assert sink.events == []                # not emitted yet
        await asyncio.sleep(0.08)               # outlive the 50ms debounce
        await gw.poll_once()                    # held start flushes
        adapter.values.update(running=True)
        await gw.poll_once()                    # ended
        return sink

    sink = run(scenario())
    started = sink.of_type("stop_started")
    ended = sink.of_type("stop_ended")
    assert len(started) == 1 and len(ended) == 1
    assert ended[0]["start"] == started[0]["ts"]     # original ts preserved
    assert ended[0]["duration"] >= 50
    assert ended[0]["reason"] == "Material jam"


def test_stop_crossing_threshold_and_ending_same_poll_emits_ordered_pair():
    async def scenario():
        gw, adapter, sink = make_gateway(min_stop_ms=30)
        await adapter.connect()
        await gw.poll_once()
        adapter.values.update(running=False, faultCode=4)
        await gw.poll_once()                    # held
        await asyncio.sleep(0.05)
        adapter.values.update(running=True)
        await gw.poll_once()                    # recovery seen first -> start then end
        return sink

    sink = run(scenario())
    kinds = [e["type"] for e in sink.events]
    assert kinds == ["stop_started", "stop_ended"]
    assert sink.events[1]["duration"] >= 30
