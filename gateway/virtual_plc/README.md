# Virtual PLC harness

Drivable "fake PLCs" so the gateway's **real** protocol adapters (S7, OPC UA) can
be tested end to end on a laptop — **no Siemens software, no hardware**. Each
emulator speaks the actual wire protocol, so it exercises the networked read path
(connect, addressing, batched reads) that the in-process `SimAdapter` cannot.

Both emulators are driven exactly like `SimAdapter`: a scripted timeline (default)
or interactive stdin (`--interactive`: type `stop [fault]`, `run`, `status`).

> These emulators **write** to their own memory/nodes because they *are* the PLC.
> The gateway's adapters remain strictly read-only.

## S7 (python-snap7)

```bash
# terminal 1 — start the virtual PLC (non-privileged port 1102; no admin needed)
python virtual_plc/snap7_server.py --port 1102

# terminal 2 — run the gateway against it
python -m plc_gateway --config virtual_plc/s7.yaml --i-have-authorization --run-for 15
```

Expected gateway output (over a real snap7 socket):

```
STOP started   Line 1 - Station A
STOP ended     Line 1 - Station A - 7s, reason: Tooling change
```

Real S7-1200/1500 CPUs use TCP **102**; `snap7_server.py` defaults to **1102** to
avoid needing admin rights. For a real PLC, set `s7.port: 102` (and the PLC's IP)
in the config.

## OPC UA (asyncua)

```bash
# terminal 1
python virtual_plc/opcua_server.py --port 4840

# terminal 2
python -m plc_gateway --config virtual_plc/opcua.yaml --i-have-authorization --run-for 15
```

Same `STOP started / STOP ended` output, over `opc.tcp://`. The server prints the
node ids it exposes (`ns=2;s=Machine_Running`, …) — these match `opcua.yaml`. It
runs without security certs (fine for a local test server; asyncua warns about
plaintext, which is expected here).

## Pointing at a real PLCSIM Advanced VM

The same configs work against a Siemens **PLCSIM Advanced** instance (usually in a
Hyper-V/VMware VM): change `s7.host` / `opcua.endpoint` from `127.0.0.1` to the
VM's IP, set `s7.port: 102`, and for OPC UA enable the CPU's OPC UA server in its
properties (off by default). The `--i-have-authorization` flag is still required —
and the real production line must never be a target without written ACP sign-off.
