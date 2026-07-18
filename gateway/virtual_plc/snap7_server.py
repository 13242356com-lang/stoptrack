"""Virtual S7 PLC — a snap7 server exposing DB1, drivable like a real machine.

Emulates an S7-1200/1500 on the loopback so the gateway's S7Adapter can be
tested end to end with no Siemens software. Uses a non-privileged TCP port by
default (1102) to avoid needing admin rights for port 102.

Layout of DB1 (matches virtual_plc/s7.yaml):
    DB1.DBX0.0  running    (bool)
    DB1.DBW2    faultCode  (int16)
    DB1.DBD4    cycleCount (int32)

Run:  python virtual_plc/snap7_server.py --port 1102
      python virtual_plc/snap7_server.py --interactive
"""
from __future__ import annotations

import argparse
import asyncio

import snap7
from snap7 import util
from snap7.server import Server

from machine_driver import run_machine  # sibling module (script dir on sys.path)

DB_NUMBER = 1
DB_SIZE = 16

DEMO_TIMELINE = [
    {"at_ms": 3000, "set": {"running": False, "faultCode": 4}},
    {"at_ms": 10000, "set": {"running": True}},
    {"at_ms": 10600, "set": {"faultCode": 0}},
]


def main() -> None:
    ap = argparse.ArgumentParser(description="Virtual S7 PLC (snap7 server)")
    ap.add_argument("--port", type=int, default=1102, help="TCP port (default 1102; real S7 uses 102, needs admin)")
    ap.add_argument("--interactive", action="store_true", help="drive from stdin instead of the demo timeline")
    args = ap.parse_args()

    # DB1 backing store: a bytearray registered BY REFERENCE, so writes are live.
    mem = bytearray(DB_SIZE)
    srv = Server()
    srv.register_area(snap7.SrvArea.DB, DB_NUMBER, mem)
    srv.start_to("127.0.0.1", tcp_port=args.port)
    print(f"virtual S7 PLC listening on 127.0.0.1:{args.port} (DB{DB_NUMBER})", flush=True)

    def push(state) -> None:
        util.set_bool(mem, 0, 0, bool(state.get("running", True)))
        util.set_int(mem, 2, int(state.get("faultCode", 0)))
        util.set_dint(mem, 4, int(state.get("cycleCount", 0)))

    try:
        asyncio.run(run_machine(
            "Line 1 - Station A", push,
            timeline=None if args.interactive else DEMO_TIMELINE,
            interactive=args.interactive,
        ))
    except KeyboardInterrupt:
        print("\nstopping virtual S7 PLC.", flush=True)
    finally:
        srv.stop()
        srv.destroy()


if __name__ == "__main__":
    main()
