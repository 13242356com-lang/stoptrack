package com.stoptrack.shared

import kotlinx.serialization.Serializable

/**
 * The StopTrack stopwatch, a direct port of the web app's `useTimer` (see
 * ../../StopTrack.tsx). Same invariant: elapsed is DERIVED from
 * `accumulated + (now - segStart)`, never stored, so it can't drift. Pause banks
 * the current segment into `accumulated` exactly once; resume opens a new
 * segment. The machine is snapshotted at Start so switching machines mid-stop
 * doesn't re-attribute the running stop.
 *
 * Lives in :shared so both the watch (:wear) and the phone quick-timer (:mobile)
 * drive one identical timer.
 */
@Serializable
data class TimerState(
    val running: Boolean = false,
    val paused: Boolean = false,
    val startTs: Long? = null,
    val accumulatedMs: Long = 0L,
    val segStartMs: Long? = null,
    /** machine pinned at Start. */
    val machine: String = "",
) {
    val active: Boolean get() = running || paused

    /** Derived elapsed at [now], matching the web app's `elapsed`. */
    fun elapsed(now: Long): Long = when {
        paused -> accumulatedMs
        running && segStartMs != null -> accumulatedMs + (now - segStartMs)
        else -> accumulatedMs
    }
}

/**
 * The finished stop handed to the documentation step (start/end/duration +
 * machine). Serializable so the phone can persist it as a "pending" stop —
 * awaiting the operator's reason — across a foreground-service restart.
 */
@Serializable
data class FinishedStop(
    val start: Long,
    val end: Long,
    val durationMs: Long,
    val machine: String,
)

/** Pure timer transitions. Kept side-effect-free so they're trivial to reason about. */
object Timer {
    val EMPTY = TimerState()

    fun start(machine: String, now: Long): TimerState =
        TimerState(running = true, paused = false, startTs = now, accumulatedMs = 0L, segStartMs = now, machine = machine)

    fun pause(s: TimerState, now: Long): TimerState =
        if (!s.running || s.paused || s.segStartMs == null) s
        else s.copy(paused = true, accumulatedMs = s.accumulatedMs + (now - s.segStartMs), segStartMs = null)

    fun resume(s: TimerState, now: Long): TimerState =
        if (s.paused) s.copy(paused = false, segStartMs = now) else s

    /** Returns the finished stop; caller should then reset to [EMPTY]. */
    fun stop(s: TimerState, now: Long): FinishedStop {
        val duration = if (s.paused || s.segStartMs == null) s.accumulatedMs
        else s.accumulatedMs + (now - s.segStartMs)
        return FinishedStop(start = s.startTs ?: now, end = now, durationMs = duration, machine = s.machine)
    }
}
