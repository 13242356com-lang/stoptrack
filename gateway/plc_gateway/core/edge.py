"""Edge detection — the conceptual core of the gateway.

Rules react to *transitions* (a value changing), never to steady states.
The detector remembers the previous value of every (machine, tag) pair and
reports only actual changes. The very first poll primes the memory and
reports nothing: the gateway must not fire events for the state a machine
happened to be in at startup.
"""
from __future__ import annotations

from dataclasses import dataclass

from .adapter import TagValue


@dataclass(frozen=True)
class Edge:
    """One observed transition of one tag on one machine."""

    machine: str
    tag: str
    old: TagValue
    new: TagValue


class EdgeDetector:
    def __init__(self) -> None:
        self._prev: dict[tuple[str, str], TagValue] = {}

    def detect(self, machine: str, values: dict[str, TagValue]) -> list[Edge]:
        """Compare a fresh snapshot against memory; return transitions only."""
        edges: list[Edge] = []
        for tag, new in values.items():
            key = (machine, tag)
            if key in self._prev and self._prev[key] != new:
                edges.append(Edge(machine=machine, tag=tag, old=self._prev[key], new=new))
            self._prev[key] = new
        return edges
