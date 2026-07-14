"""Config loading + validation.

YAML via pyyaml when available; .json files (or a missing pyyaml) fall back
to the stdlib json parser. Validation fails fast with one clear message —
an engineer fixing a fault map should never see a Python traceback.

Phase 1 accepts only ``protocol: sim``. Real protocols (s7 / opcua / modbus)
are Phase 3 and will additionally require an explicit authorization flag
before dialing any real endpoint.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .core.adapter import TagSpec
from .core.rules import EdgeRule, parse_rule

KNOWN_PROTOCOLS = ("sim", "s7", "opcua", "modbus")
IMPLEMENTED_PROTOCOLS = ("sim", "s7", "opcua")
REAL_PROTOCOLS = ("s7", "opcua")  # dial a network endpoint -> need the authorization gate
VALID_TAG_TYPES = ("bool", "int", "real", "string")


class ConfigError(Exception):
    """Raised with a human-readable, single-line explanation."""


@dataclass
class MachineConfig:
    name: str
    protocol: str
    tags: list[TagSpec]
    rules: list[EdgeRule]
    fault_map: dict[int, str]
    sim: dict[str, Any] = field(default_factory=dict)   # timeline / jitter_ms / interactive
    conn: dict[str, Any] = field(default_factory=dict)  # s7: {host,rack,slot,port} / opcua: {endpoint}
    authorized: bool = False                            # per-machine consent to dial a real endpoint


VALID_SINKS = ("console", "file")


@dataclass
class SinkConfig:
    type: str
    path: str = ""  # for type == "file"


@dataclass
class GatewayConfig:
    poll_interval_ms: int
    min_stop_ms: int  # micro-pause debounce, enforced by the gateway loop
    sinks: list[SinkConfig]
    machines: list[MachineConfig]


def _read_raw(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        return json.loads(text)
    try:
        import yaml  # optional dependency
    except ImportError as exc:
        raise ConfigError(
            f"{path.name} is YAML but pyyaml is not installed - "
            "run 'pip install pyyaml' or use a .json config"
        ) from exc
    return yaml.safe_load(text)


def load_config(path: str | Path) -> GatewayConfig:
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"config file not found: {p}")
    try:
        raw = _read_raw(p)
    except ConfigError:
        raise
    except Exception as exc:
        raise ConfigError(f"could not parse {p.name}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"{p.name}: top level must be a mapping")

    poll = raw.get("poll_interval_ms", 200)
    if not isinstance(poll, int) or poll <= 0:
        raise ConfigError(f"poll_interval_ms must be a positive integer, got {poll!r}")
    min_stop = raw.get("min_stop_ms", 0)
    if not isinstance(min_stop, int) or min_stop < 0:
        raise ConfigError(f"min_stop_ms must be a non-negative integer, got {min_stop!r}")

    # `sink:` accepts one mapping or a list of them (console + file together).
    sink_raw = raw.get("sink") or {"type": "console"}
    if isinstance(sink_raw, dict):
        sink_raw = [sink_raw]
    if not isinstance(sink_raw, list):
        raise ConfigError("'sink' must be a mapping or a list of mappings")
    sinks: list[SinkConfig] = []
    for s in sink_raw:
        stype = (s or {}).get("type", "console")
        if stype not in VALID_SINKS:
            raise ConfigError(f"sink type {stype!r} is not available (valid: {', '.join(VALID_SINKS)}; websocket arrives in Phase 4)")
        path = str((s or {}).get("path", ""))
        if stype == "file" and not path:
            raise ConfigError("sink type 'file' needs a 'path' (e.g. path: events.jsonl)")
        sinks.append(SinkConfig(type=stype, path=path))

    machines_raw = raw.get("machines")
    if not machines_raw or not isinstance(machines_raw, list):
        raise ConfigError("config needs a non-empty 'machines' list")

    machines: list[MachineConfig] = []
    for i, m in enumerate(machines_raw):
        where = f"machines[{i}]"
        name = m.get("name")
        if not name or not isinstance(name, str):
            raise ConfigError(f"{where}: every machine needs a 'name'")
        where = f"machine {name!r}"

        protocol = m.get("protocol", "sim")
        if protocol not in KNOWN_PROTOCOLS:
            raise ConfigError(f"{where}: unknown protocol {protocol!r} (known: {', '.join(KNOWN_PROTOCOLS)})")
        if protocol not in IMPLEMENTED_PROTOCOLS:
            raise ConfigError(
                f"{where}: protocol {protocol!r} is not implemented yet "
                f"(available: {', '.join(IMPLEMENTED_PROTOCOLS)})"
            )

        # Per-protocol connection block, validated up front.
        conn: dict[str, Any] = {}
        if protocol == "s7":
            s7 = m.get("s7") or {}
            host = s7.get("host")
            if not host or not isinstance(host, str):
                raise ConfigError(f"{where}: s7 needs a 'host' (the PLC/simulator IP)")
            conn = {
                "host": host,
                "rack": int(s7.get("rack", 0)),
                "slot": int(s7.get("slot", 1)),
                "port": int(s7.get("port", 102)),
            }
        elif protocol == "opcua":
            opc = m.get("opcua") or {}
            endpoint = opc.get("endpoint")
            if not endpoint or not isinstance(endpoint, str) or not endpoint.startswith("opc.tcp://"):
                raise ConfigError(f"{where}: opcua needs an 'endpoint' like opc.tcp://host:4840")
            conn = {"endpoint": endpoint}

        tags_raw = m.get("tags")
        if not tags_raw or not isinstance(tags_raw, dict):
            raise ConfigError(f"{where}: needs a 'tags' mapping (e.g. running: {{address, type}})")
        tags: list[TagSpec] = []
        for tag_name, spec in tags_raw.items():
            spec = spec or {}
            ttype = spec.get("type", "bool")
            if ttype not in VALID_TAG_TYPES:
                raise ConfigError(f"{where}: tag {tag_name!r} has invalid type {ttype!r} (valid: {', '.join(VALID_TAG_TYPES)})")
            tags.append(TagSpec(name=tag_name, address=str(spec.get("address", "")), type=ttype))
        tag_names = {t.name for t in tags}

        rules_raw = m.get("rules")
        if not rules_raw or not isinstance(rules_raw, list):
            raise ConfigError(f"{where}: needs a non-empty 'rules' list")
        rules: list[EdgeRule] = []
        for r in rules_raw:
            try:
                rule = parse_rule(r)
            except ValueError as exc:
                raise ConfigError(f"{where}: {exc}") from exc
            if rule.tag not in tag_names:
                raise ConfigError(f"{where}: rule references unknown tag {rule.tag!r}")
            if rule.reason_from is not None and rule.reason_from not in tag_names:
                raise ConfigError(f"{where}: enrich.reason_from references unknown tag {rule.reason_from!r}")
            rules.append(rule)

        fault_map_raw = m.get("faultMap") or {}
        fault_map = {int(k): str(v) for k, v in fault_map_raw.items()}

        machines.append(MachineConfig(
            name=name, protocol=protocol, tags=tags, rules=rules,
            fault_map=fault_map, sim=m.get("sim") or {},
            conn=conn, authorized=bool(m.get("authorized", False)),
        ))

    return GatewayConfig(
        poll_interval_ms=poll, min_stop_ms=min_stop, sinks=sinks, machines=machines,
    )
