"""FileSink — appends events as JSON lines (one event per line).

A JSONL file is greppable, tail-able, and trivially replayable into
StopTrack later. The handle stays open and is flushed per event so a crash
loses at most the in-flight line.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional, TextIO

from ..core.events import Event, EventSink

log = logging.getLogger(__name__)


class FileSink(EventSink):
    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._fh: Optional[TextIO] = None

    def _ensure_open(self) -> TextIO:
        if self._fh is None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._fh = self._path.open("a", encoding="utf-8")
            log.info("FileSink appending to %s", self._path)
        return self._fh

    async def emit(self, event: Event) -> None:
        fh = self._ensure_open()
        fh.write(json.dumps(event, ensure_ascii=False) + "\n")
        fh.flush()

    async def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None
