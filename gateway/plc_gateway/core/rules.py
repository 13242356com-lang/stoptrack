"""Minimal Phase-1 rules engine.

Two rule kinds (spec §2.2):
- edge-triggered: ``when: <tag> edge <false|true>`` fires on that transition
  and emits ``stop_started`` / ``stop_ended``;
- value-lookup enrichment: ``enrich.reason_from: <tag>`` reads that tag's
  current value when the rule fires and maps it through the machine's
  ``faultMap`` to a human reason.

``min_stop_ms`` debounce is not a rule concern: the gateway loop enforces it
(see core/gateway.py) because it owns the open-stop timing state.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from .adapter import TagValue
from .edge import Edge

_EDGE_WORDS = {"true": True, "false": False}


@dataclass(frozen=True)
class EdgeRule:
    tag: str                       # logical tag name, e.g. "running"
    to_value: bool                 # the NEW value that triggers the rule
    emit: str                      # "stop_started" | "stop_ended"
    reason_from: Optional[str]     # tag to read for faultMap enrichment


@dataclass(frozen=True)
class Firing:
    """What a rule decided: emit this kind of event, enriched with these."""

    emit: str
    reason: Optional[str] = None
    fault_code: Optional[int] = None


def parse_rule(raw: dict[str, Any]) -> EdgeRule:
    """Parse one config rule entry; raise ValueError with a precise message."""
    when = str(raw.get("when", "")).split()
    if len(when) != 3 or when[1] != "edge" or when[2] not in _EDGE_WORDS:
        raise ValueError(
            f"rule 'when' must look like '<tag> edge <false|true>', got: {raw.get('when')!r}"
        )
    emit = raw.get("emit")
    if emit not in ("stop_started", "stop_ended"):
        raise ValueError(f"rule 'emit' must be stop_started or stop_ended, got: {emit!r}")
    enrich = raw.get("enrich") or {}
    return EdgeRule(
        tag=when[0],
        to_value=_EDGE_WORDS[when[2]],
        emit=emit,
        reason_from=enrich.get("reason_from"),
    )


class RuleEngine:
    """Per-machine: holds parsed rules + faultMap, evaluates edges."""

    def __init__(self, rules: list[EdgeRule], fault_map: dict[int, str]) -> None:
        self._rules = rules
        self._fault_map = fault_map

    def evaluate(self, edge: Edge, current: dict[str, TagValue]) -> list[Firing]:
        """Given one transition and the full current snapshot, decide firings."""
        firings: list[Firing] = []
        for rule in self._rules:
            if rule.tag != edge.tag or bool(edge.new) is not rule.to_value:
                continue
            reason: Optional[str] = None
            fault_code: Optional[int] = None
            if rule.reason_from is not None:
                raw = current.get(rule.reason_from)
                if raw is not None:
                    fault_code = int(raw)
                    reason = self._fault_map.get(fault_code)
            firings.append(Firing(emit=rule.emit, reason=reason, fault_code=fault_code))
        return firings
