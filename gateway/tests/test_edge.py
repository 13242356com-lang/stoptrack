"""Edge detection — the §8 priority: transitions, not states."""
from plc_gateway.core.edge import EdgeDetector


def test_first_poll_primes_silently():
    det = EdgeDetector()
    assert det.detect("M1", {"running": True, "faultCode": 0}) == []


def test_steady_state_yields_no_edges():
    det = EdgeDetector()
    det.detect("M1", {"running": True})
    for _ in range(50):
        assert det.detect("M1", {"running": True}) == []


def test_transition_yields_exactly_one_edge():
    det = EdgeDetector()
    det.detect("M1", {"running": True})
    edges = det.detect("M1", {"running": False})
    assert len(edges) == 1
    assert (edges[0].old, edges[0].new) == (True, False)
    # and nothing again while it stays false
    assert det.detect("M1", {"running": False}) == []


def test_round_trip_yields_two_edges():
    det = EdgeDetector()
    det.detect("M1", {"running": True})
    down = det.detect("M1", {"running": False})
    up = det.detect("M1", {"running": True})
    assert [(e.old, e.new) for e in down + up] == [(True, False), (False, True)]


def test_tags_are_independent():
    det = EdgeDetector()
    det.detect("M1", {"running": True, "faultCode": 0})
    edges = det.detect("M1", {"running": True, "faultCode": 4})
    assert len(edges) == 1
    assert edges[0].tag == "faultCode"


def test_machines_are_independent():
    det = EdgeDetector()
    det.detect("M1", {"running": True})
    det.detect("M2", {"running": True})
    edges = det.detect("M1", {"running": False})
    assert len(edges) == 1 and edges[0].machine == "M1"
    assert det.detect("M2", {"running": True}) == []
