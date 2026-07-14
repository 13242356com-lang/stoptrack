"""Virtual OPC UA PLC — an asyncua server exposing machine tags, drivable like a
real machine.

Emulates a CPU with its OPC UA server enabled, on the loopback, so the gateway's
OPCUAAdapter can be tested end to end with no vendor software.

Nodes (matches virtual_plc/opcua.yaml, namespace index 2):
    ns=2;s=Machine_Running   (Boolean)
    ns=2;s=Fault_Code        (Int16)
    ns=2;s=Cycle_Count       (Int32)

Run:  python virtual_plc/opcua_server.py --port 4840
      python virtual_plc/opcua_server.py --interactive
"""
from __future__ import annotations

import argparse
import asyncio

from asyncua import Server, ua

from machine_driver import run_machine  # sibling module (script dir on sys.path)

NS_URI = "http://stoptrack.local/plc"

DEMO_TIMELINE = [
    {"at_ms": 3000, "set": {"running": False, "faultCode": 4}},
    {"at_ms": 10000, "set": {"running": True}},
    {"at_ms": 10600, "set": {"faultCode": 0}},
]


async def serve(port: int, interactive: bool) -> None:
    server = Server()
    await server.init()
    server.set_endpoint(f"opc.tcp://0.0.0.0:{port}/stoptrack/")
    idx = await server.register_namespace(NS_URI)

    objects = server.get_objects_node()
    machine = await objects.add_object(idx, "ASLA_1_Laser")
    running = await machine.add_variable(ua.NodeId("Machine_Running", idx), "Machine_Running", True, ua.VariantType.Boolean)
    fault = await machine.add_variable(ua.NodeId("Fault_Code", idx), "Fault_Code", 0, ua.VariantType.Int16)
    cycle = await machine.add_variable(ua.NodeId("Cycle_Count", idx), "Cycle_Count", 0, ua.VariantType.Int32)

    print(f"virtual OPC UA PLC listening on opc.tcp://0.0.0.0:{port}/stoptrack/ (ns={idx})", flush=True)
    print(f"  nodes: ns={idx};s=Machine_Running  ns={idx};s=Fault_Code  ns={idx};s=Cycle_Count", flush=True)

    async def push(state) -> None:
        await running.write_value(bool(state.get("running", True)), ua.VariantType.Boolean)
        await fault.write_value(int(state.get("faultCode", 0)), ua.VariantType.Int16)
        await cycle.write_value(int(state.get("cycleCount", 0)), ua.VariantType.Int32)

    async with server:
        await run_machine(
            "ASLA 1 - Laser", push,
            timeline=None if interactive else DEMO_TIMELINE,
            interactive=interactive,
        )


def main() -> None:
    ap = argparse.ArgumentParser(description="Virtual OPC UA PLC (asyncua server)")
    ap.add_argument("--port", type=int, default=4840, help="TCP port (default 4840)")
    ap.add_argument("--interactive", action="store_true", help="drive from stdin instead of the demo timeline")
    args = ap.parse_args()
    try:
        asyncio.run(serve(args.port, args.interactive))
    except KeyboardInterrupt:
        print("\nstopping virtual OPC UA PLC.", flush=True)


if __name__ == "__main__":
    main()
