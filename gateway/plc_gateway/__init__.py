"""StopTrack PLC gateway — reads machine state, emits StopTrack stop events.

Phase 1: simulator + console sink only. Read-only by design: no adapter in
this package has, or will ever have, a write path to a PLC.
"""

__version__ = "0.1.0"
