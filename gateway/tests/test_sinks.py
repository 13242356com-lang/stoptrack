"""Sinks: FileSink writes valid JSON lines; ConsoleSink formats without crashing."""
import asyncio
import json

from plc_gateway.core.events import stop_ended, stop_started
from plc_gateway.sinks.console import ConsoleSink
from plc_gateway.sinks.file import FileSink


def test_file_sink_appends_json_lines(tmp_path):
    path = tmp_path / "out" / "events.jsonl"  # parent dir must be auto-created

    async def scenario():
        sink = FileSink(path)
        started = stop_started("ASLA 1 - Laser", ts=1_720_000_000_000)
        ended = stop_ended("ASLA 1 - Laser", start=1_720_000_000_000,
                           ts=1_720_000_042_000, reason="Teflon change", fault_code=4)
        await sink.emit(started)
        await sink.emit(ended)
        await sink.close()

    asyncio.run(scenario())
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    first, second = (json.loads(l) for l in lines)
    assert first["type"] == "stop_started"
    assert second == {
        "type": "stop_ended", "machine": "ASLA 1 - Laser",
        "ts": 1_720_000_042_000, "start": 1_720_000_000_000,
        "duration": 42_000, "auto": True,
        "reason": "Teflon change", "faultCode": 4,
    }


def test_file_sink_appends_across_reopens(tmp_path):
    path = tmp_path / "events.jsonl"

    async def one(ts):
        sink = FileSink(path)
        await sink.emit(stop_started("M", ts=ts))
        await sink.close()

    asyncio.run(one(1))
    asyncio.run(one(2))
    assert len(path.read_text(encoding="utf-8").strip().splitlines()) == 2


def test_console_sink_handles_all_event_shapes(capsys):
    async def scenario():
        sink = ConsoleSink()
        await sink.emit(stop_started("M", ts=1_720_000_000_000))
        await sink.emit(stop_ended("M", start=1_720_000_000_000, ts=1_720_000_042_000))
        await sink.emit(stop_ended("M", start=0, ts=500, fault_code=9))  # unmapped fault

    asyncio.run(scenario())
    out = capsys.readouterr().out
    assert "STOP started" in out
    assert "42s" in out
    assert "faultCode: 9" in out
