"""Entry point: ``python -m plc_gateway --config config.yaml``.

Wires config -> adapters -> rules -> gateway -> sinks and runs the poll loop
until Ctrl-C (or --run-for seconds elapse, handy for scripted demos).
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from .adapters.sim import SimAdapter
from .config import REAL_PROTOCOLS, ConfigError, GatewayConfig, MachineConfig, load_config
from .core.adapter import PLCAdapter
from .core.events import EventSink
from .core.gateway import Gateway, MachineRuntime
from .core.rules import RuleEngine
from .sinks.console import ConsoleSink
from .sinks.file import FileSink


def build_sinks(cfg: GatewayConfig) -> list[EventSink]:
    sinks: list[EventSink] = []
    for s in cfg.sinks:
        if s.type == "console":
            sinks.append(ConsoleSink())
        elif s.type == "file":
            sinks.append(FileSink(s.path))
    return sinks


def build_adapter(m: MachineConfig, interactive: bool) -> PLCAdapter:
    if m.protocol == "sim":
        return SimAdapter(
            machine=m.name, tags=m.tags,
            timeline=m.sim.get("timeline"),
            jitter_ms=int(m.sim.get("jitter_ms", 0)),
            interactive=interactive or bool(m.sim.get("interactive", False)),
        )
    if m.protocol == "s7":
        from .adapters.s7 import S7Adapter  # lazy: snap7 only loads when used
        return S7Adapter(machine=m.name, tags=m.tags, conn=m.conn)
    if m.protocol == "opcua":
        from .adapters.opcua import OPCUAAdapter  # lazy: asyncua only loads when used
        return OPCUAAdapter(machine=m.name, tags=m.tags, conn=m.conn)
    raise ConfigError(f"machine {m.name!r}: no adapter for protocol {m.protocol!r}")


def build_gateway(cfg: GatewayConfig, interactive: bool) -> Gateway:
    machines = [
        MachineRuntime(name=m.name, adapter=build_adapter(m, interactive),
                       tags=m.tags, rules=RuleEngine(m.rules, m.fault_map))
        for m in cfg.machines
    ]
    return Gateway(
        machines=machines, sinks=build_sinks(cfg),
        poll_interval_ms=cfg.poll_interval_ms, min_stop_ms=cfg.min_stop_ms,
    )


def authorization_error(cfg: GatewayConfig, cli_authorized: bool) -> str | None:
    """Real adapters may not dial an endpoint without explicit consent (spec §7).

    Returns an error string to print, or None if the run is authorized. The
    simulator needs no gate; a real-protocol machine needs either the
    --i-have-authorization flag or its own ``authorized: true``.
    """
    real = [m for m in cfg.machines if m.protocol in REAL_PROTOCOLS]
    if not real:
        return None
    unauthorized = [m for m in real if not (cli_authorized or m.authorized)]
    if not unauthorized:
        return None
    names = ", ".join(f"{m.name!r} ({m.protocol})" for m in unauthorized)
    return (
        "REFUSING to connect: this run would dial a live PLC endpoint for "
        f"{names}.\n"
        "This connects to real industrial equipment. Only proceed against a "
        "simulator or an explicitly authorized machine - the ASLA line must never "
        "be a target without written ACP/engineering sign-off.\n"
        "Re-run with --i-have-authorization (or set 'authorized: true' on the "
        "machine) once you are sure of the endpoint."
    )


async def _run(gateway: Gateway, run_for: float) -> None:
    task = asyncio.create_task(gateway.run())
    if run_for > 0:
        await asyncio.sleep(run_for)
        gateway.request_stop()
    await task


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="plc_gateway", description="StopTrack PLC gateway (sim / S7 / OPC UA)")
    parser.add_argument("--config", required=True, help="path to config.yaml / config.json")
    parser.add_argument("--interactive", action="store_true", help="drive the simulator from stdin (stop [fault] / run / status)")
    parser.add_argument("--run-for", type=float, default=0, metavar="SECONDS", help="exit after N seconds (0 = run until Ctrl-C)")
    parser.add_argument("--i-have-authorization", dest="authorized", action="store_true",
                        help="consent to connect a real (s7/opcua) adapter to its configured endpoint")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")

    try:
        cfg = load_config(args.config)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2

    # Authorization gate — checked BEFORE any adapter is built or any socket opens.
    auth_err = authorization_error(cfg, args.authorized)
    if auth_err:
        print(auth_err, file=sys.stderr)
        return 3

    protocols = sorted({m.protocol for m in cfg.machines})
    mode = "SIMULATOR" if protocols == ["sim"] else f"LIVE-PROTOCOL ({', '.join(protocols)}) — authorized"
    print(f"plc_gateway - {mode} mode, {len(cfg.machines)} machine(s), poll every {cfg.poll_interval_ms}ms", flush=True)
    gateway = build_gateway(cfg, interactive=args.interactive)
    try:
        asyncio.run(_run(gateway, args.run_for))
    except KeyboardInterrupt:
        print("\nstopped.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
