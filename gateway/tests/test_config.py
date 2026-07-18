"""Config loading: valid configs load; malformed ones fail with clear messages."""
import pytest

from plc_gateway.config import ConfigError, load_config

VALID_YAML = """
poll_interval_ms: 100
min_stop_ms: 500
sink:
  - type: console
  - type: file
    path: events.jsonl
machines:
  - name: "Line 1 - Station A"
    protocol: sim
    tags:
      running:   { address: "DB1.DBX0.0", type: bool }
      faultCode: { address: "DB1.DBW2",   type: int }
    rules:
      - when: running edge false
        emit: stop_started
      - when: running edge true
        emit: stop_ended
        enrich: { reason_from: faultCode }
    faultMap: { 4: "Tooling change" }
"""


def write(tmp_path, text, name="config.yaml"):
    p = tmp_path / name
    p.write_text(text, encoding="utf-8")
    return p


def test_valid_yaml_loads(tmp_path):
    cfg = load_config(write(tmp_path, VALID_YAML))
    assert cfg.poll_interval_ms == 100
    assert cfg.min_stop_ms == 500
    assert [s.type for s in cfg.sinks] == ["console", "file"]
    assert cfg.sinks[1].path == "events.jsonl"
    m = cfg.machines[0]
    assert m.name == "Line 1 - Station A"
    assert {t.name for t in m.tags} == {"running", "faultCode"}
    assert m.fault_map == {4: "Tooling change"}
    assert len(m.rules) == 2


def test_json_config_loads_without_yaml(tmp_path):
    p = write(tmp_path, """{
      "poll_interval_ms": 100,
      "machines": [{
        "name": "M", "protocol": "sim",
        "tags": {"running": {"address": "DB1.DBX0.0", "type": "bool"}},
        "rules": [{"when": "running edge false", "emit": "stop_started"}]
      }]
    }""", name="config.json")
    assert load_config(p).machines[0].name == "M"


def test_missing_file_fails_clearly(tmp_path):
    with pytest.raises(ConfigError, match="not found"):
        load_config(tmp_path / "nope.yaml")


def test_unimplemented_protocol_rejected(tmp_path):
    # modbus is a known protocol but has no adapter yet.
    bad = VALID_YAML.replace("protocol: sim", "protocol: modbus")
    with pytest.raises(ConfigError, match="not implemented"):
        load_config(write(tmp_path, bad))


def test_s7_config_loads_with_conn(tmp_path):
    text = """
poll_interval_ms: 200
machines:
  - name: "M"
    protocol: s7
    s7: { host: "127.0.0.1", rack: 0, slot: 1, port: 1102 }
    tags: { running: { address: "DB1.DBX0.0", type: bool } }
    rules: [ { when: "running edge false", emit: stop_started } ]
"""
    cfg = load_config(write(tmp_path, text))
    m = cfg.machines[0]
    assert m.protocol == "s7"
    assert m.conn == {"host": "127.0.0.1", "rack": 0, "slot": 1, "port": 1102}


def test_s7_without_host_rejected(tmp_path):
    text = """
poll_interval_ms: 200
machines:
  - name: "M"
    protocol: s7
    s7: { rack: 0 }
    tags: { running: { address: "DB1.DBX0.0", type: bool } }
    rules: [ { when: "running edge false", emit: stop_started } ]
"""
    with pytest.raises(ConfigError, match="needs a 'host'"):
        load_config(write(tmp_path, text))


def test_opcua_bad_endpoint_rejected(tmp_path):
    text = """
poll_interval_ms: 200
machines:
  - name: "M"
    protocol: opcua
    opcua: { endpoint: "http://not-opc-ua" }
    tags: { running: { address: "ns=2;s=Running", type: bool } }
    rules: [ { when: "running edge false", emit: stop_started } ]
"""
    with pytest.raises(ConfigError, match="opc.tcp"):
        load_config(write(tmp_path, text))


def test_unknown_protocol_rejected(tmp_path):
    bad = VALID_YAML.replace("protocol: sim", "protocol: carrier-pigeon")
    with pytest.raises(ConfigError, match="unknown protocol"):
        load_config(write(tmp_path, bad))


def test_rule_with_unknown_tag_rejected(tmp_path):
    bad = VALID_YAML.replace("when: running edge false", "when: motor edge false")
    with pytest.raises(ConfigError, match="unknown tag 'motor'"):
        load_config(write(tmp_path, bad))


def test_bad_when_syntax_rejected(tmp_path):
    bad = VALID_YAML.replace("when: running edge false", "when: running flips")
    with pytest.raises(ConfigError, match="edge"):
        load_config(write(tmp_path, bad))


def test_file_sink_without_path_rejected(tmp_path):
    bad = VALID_YAML.replace("    path: events.jsonl\n", "")
    with pytest.raises(ConfigError, match="needs a 'path'"):
        load_config(write(tmp_path, bad))


def test_no_machines_rejected(tmp_path):
    with pytest.raises(ConfigError, match="machines"):
        load_config(write(tmp_path, "poll_interval_ms: 100\nmachines: []\n"))
