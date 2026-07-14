# StopTrack PLC Gateway

Reads live machine state from a PLC and turns state changes into StopTrack
stop events (`stop_started` / `stop_ended`, with fault-code → reason mapping),
so downtime is captured **automatically** alongside the app's manual entries.

The gateway is **read-only by design** — no adapter defines a write method, and
none ever will. It ships with an in-process **simulator** plus real **S7**
(python-snap7) and **OPC UA** (asyncua) adapters, all tested against
simulators/emulators only. Real adapters sit behind an **authorization gate**;
connecting to actual production hardware requires the plant's ACP sign-off and is
out of scope here.

## Run the demo

Needs Python 3.11+ and (for YAML configs) pyyaml:

```bash
cd gateway
pip install pyyaml          # or use a .json config, which needs nothing
python -m plc_gateway --config config.yaml --run-for 15
```

The bundled `config.yaml` scripts a mini-shift on a simulated S7-1500:
at ~3s the machine "stops" with fault code 4, at ~10s it runs again. Expected
output:

```
[HH:MM:SS] STOP started   ASLA 1 - Laser
[HH:MM:SS] STOP ended     ASLA 1 - Laser — 7s, reason: Teflon change
```

That single pair of lines proves the whole pipeline: poll → edge detection →
rules → fault-map enrichment → event emit.

### Drive the simulator by hand

```bash
python -m plc_gateway --config config.yaml --interactive
```

Then type `stop 7` (stop with fault 7), `run` (recover), `status`, Ctrl-C to
quit. Remove/empty the `timeline` in the config if you want a purely manual
session.

## Testing against a virtual PLC (S7 / OPC UA)

The real adapters are validated against **local emulators** that speak the actual
wire protocol — no Siemens software, no hardware. See
[`virtual_plc/README.md`](virtual_plc/README.md). In short:

```bash
pip install python-snap7 asyncua

# S7 — terminal 1: the virtual PLC; terminal 2: the gateway
python virtual_plc/snap7_server.py --port 1102
python -m plc_gateway --config virtual_plc/s7.yaml --i-have-authorization --run-for 15

# OPC UA
python virtual_plc/opcua_server.py --port 4840
python -m plc_gateway --config virtual_plc/opcua.yaml --i-have-authorization --run-for 15
```

Both produce the same `STOP started / STOP ended … reason: Teflon change` events
as the simulator — now over a real socket. The same configs point at a Siemens
**PLCSIM Advanced** VM by swapping `127.0.0.1` for the VM's IP.

**Authorization gate:** any `s7`/`opcua` machine refuses to connect without
`--i-have-authorization` (or `authorized: true` on the machine) — it exits before
opening a socket. The simulator needs no gate.

## Architecture (one gateway, many PLCs, zero forks)

```
Gateway core:  poll loop → EdgeDetector → RuleEngine → EventSink(s)
                    ↑ (PLCAdapter contract)
        SimAdapter · S7Adapter (snap7) · OPCUAAdapter (asyncua)
```

- `plc_gateway/core/adapter.py` — the `PLCAdapter` ABC (connect / disconnect /
  list_tags / read / read_many / is_connected). **No write methods.** All
  protocol specifics live behind this line.
- `core/edge.py` — transition detection; first poll primes memory silently.
- `core/rules.py` — `when: <tag> edge <false|true>` rules + `enrich.reason_from`
  value-lookup through the machine's `faultMap`.
- `core/gateway.py` — the loop; pairs each `stop_ended` with its
  `stop_started` and computes `duration`.
- `adapters/sim.py` — in-memory fake S7-1500 (timeline- or stdin-driven,
  optional read jitter).
- `sinks/console.py` — human-readable event printer.
- `config.py` — YAML/JSON load + fail-fast validation.

## Event contract (what StopTrack will consume in Phase 4)

```json
{ "type": "stop_started", "machine": "ASLA 1 - Laser", "ts": 1720000000000 }
{ "type": "stop_ended",   "machine": "ASLA 1 - Laser", "ts": 1720000042000,
  "start": 1720000000000, "duration": 42000,
  "reason": "Teflon change", "faultCode": 4, "auto": true }
```

## Config

See `config.yaml` — machines are data, not code. Per machine: `protocol`
(only `sim` until Phase 3), `tags` (logical name → address/type), `rules`, and
a `faultMap`. Malformed configs fail on startup with a one-line message.

`sink:` accepts one mapping or a list, so console + file can run together:

```yaml
sink:
  - type: console
  - type: file
    path: events.jsonl        # JSON lines, one event per line
```

### Micro-pause debounce (`min_stop_ms`)

Stops shorter than `min_stop_ms` are ignored entirely. Because a
`stop_started` can't be un-emitted, the gateway **holds** the started event
until the stop has survived the threshold; if the machine recovers sooner,
neither event is emitted. A held start, once released, carries its **original**
timestamp, so durations stay truthful (they'll always be ≥ `min_stop_ms`).

## Tests

```bash
pip install pytest
python -m pytest tests -q
```

34 tests cover edge detection (priming, steady-state silence, transitions),
rule parsing + faultMap enrichment, gateway pairing/duration/debounce
(including the recover-in-the-same-poll ordering case), config validation
failures, and both sinks.

## Roadmap

- ~~Phase 2~~ — done: `min_stop_ms` debounce, FileSink, multi-sink config,
  pytest suite.
- ~~Phase 3~~ — done: `S7Adapter` (python-snap7) + `OPCUAAdapter` (asyncua),
  the `--i-have-authorization` gate, and a `virtual_plc/` emulator harness for
  license-free end-to-end testing.
- **Phase 4** — WebSocketSink + a StopTrack client so auto-captured stops
  (`auto: true`) appear beside manual ones; manual entry stays as fallback.
- **Phase 5 (gated)** — real-hardware validation, only with plant/engineering
  sign-off, read-only, machine PLC only.
