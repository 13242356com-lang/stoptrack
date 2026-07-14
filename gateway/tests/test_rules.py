"""Rules: parsing, edge matching, faultMap enrichment."""
import pytest

from plc_gateway.core.edge import Edge
from plc_gateway.core.rules import RuleEngine, parse_rule

FAULT_MAP = {4: "Teflon change", 7: "Foil / infeed jam"}


def engine():
    return RuleEngine(
        [
            parse_rule({"when": "running edge false", "emit": "stop_started"}),
            parse_rule({"when": "running edge true", "emit": "stop_ended",
                        "enrich": {"reason_from": "faultCode"}}),
        ],
        FAULT_MAP,
    )


def test_parse_rule_valid():
    r = parse_rule({"when": "running edge false", "emit": "stop_started"})
    assert (r.tag, r.to_value, r.emit, r.reason_from) == ("running", False, "stop_started", None)


@pytest.mark.parametrize("bad", [
    {"when": "running goes false", "emit": "stop_started"},
    {"when": "running edge maybe", "emit": "stop_started"},
    {"when": "edge false", "emit": "stop_started"},
    {"when": "running edge false", "emit": "explode"},
    {"emit": "stop_started"},
])
def test_parse_rule_rejects_malformed(bad):
    with pytest.raises(ValueError):
        parse_rule(bad)


def test_true_to_false_fires_started():
    firings = engine().evaluate(
        Edge("M", "running", True, False), {"running": False, "faultCode": 0}
    )
    assert [f.emit for f in firings] == ["stop_started"]


def test_false_to_true_fires_ended_with_mapped_reason():
    firings = engine().evaluate(
        Edge("M", "running", False, True), {"running": True, "faultCode": 4}
    )
    assert len(firings) == 1
    assert firings[0].emit == "stop_ended"
    assert firings[0].reason == "Teflon change"
    assert firings[0].fault_code == 4


def test_unmapped_fault_keeps_code_without_reason():
    firings = engine().evaluate(
        Edge("M", "running", False, True), {"running": True, "faultCode": 99}
    )
    assert firings[0].reason is None
    assert firings[0].fault_code == 99


def test_edge_on_other_tag_fires_nothing():
    assert engine().evaluate(Edge("M", "faultCode", 0, 4), {"running": True, "faultCode": 4}) == []
