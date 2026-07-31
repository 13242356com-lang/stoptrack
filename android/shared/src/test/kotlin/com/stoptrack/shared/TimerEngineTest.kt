package com.stoptrack.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * Unit tests for [Timer] / [TimerState] — the port of the web app's `useTimer`
 * (StopTrack.tsx). These are the guard on the ONE piece of :shared that must not
 * drift from the web timer: if the watch and the phone disagree with the browser
 * about a stop's duration, the app is wrong about the only number a supervisor
 * actually trusts.
 *
 * Every test passes `now` explicitly, so there is no wall-clock flake: the whole
 * point of the design is that elapsed/duration are DERIVED from the timestamps
 * handed in, never stored.
 *
 * The `webElapsed` helper below is a literal transcription of the web formula
 * (StopTrack.tsx `nativeElapsed` / `useTimer`'s `elapsed`), so parity is asserted
 * against the source of truth rather than against a restatement of the Kotlin.
 */
class TimerEngineTest {

    private val t0 = 1_700_000_000_000L // fixed epoch ms; any value works
    private fun at(seconds: Long) = t0 + seconds * 1000L

    /** The web app's elapsed rule, transcribed from StopTrack.tsx. */
    private fun webElapsed(s: TimerState, now: Long): Long = when {
        s.paused -> s.accumulatedMs
        s.running -> s.accumulatedMs + (now - (s.segStartMs ?: now))
        else -> s.accumulatedMs
    }

    // ---- start ---------------------------------------------------------------

    @Test
    fun `start pins the machine and opens a fresh segment`() {
        val s = Timer.start("Line 2", t0)

        assertTrue(s.running)
        assertFalse(s.paused)
        assertTrue(s.active)
        assertEquals(t0, s.startTs)
        assertEquals(t0, s.segStartMs)
        assertEquals(0L, s.accumulatedMs)
        assertEquals("Line 2", s.machine)
        assertEquals(0L, s.elapsed(t0))
    }

    @Test
    fun `start discards any previous accumulated time`() {
        // A stale state with banked time must not leak into the next stop.
        val stale = TimerState(running = true, paused = true, startTs = at(-60), accumulatedMs = 60_000L, machine = "Line 1")
        val fresh = Timer.start("Line 1", t0)

        assertEquals(60_000L, stale.accumulatedMs) // untouched: transitions are pure
        assertEquals(0L, fresh.accumulatedMs)
        assertEquals(0L, fresh.elapsed(t0))
    }

    @Test
    fun `the machine is snapshotted at start, so switching machines mid-stop does not re-attribute`() {
        // The operator starts on Line 1 and roams; the running stop stays Line 1.
        val s = Timer.start("Line 1", t0)
        val finished = Timer.stop(s, at(30))

        assertEquals("Line 1", finished.machine)
    }

    // ---- elapsed is derived, never stored ------------------------------------

    @Test
    fun `elapsed is derived from now, so the same state yields different elapsed`() {
        val s = Timer.start("Line 1", t0)

        assertEquals(0L, s.elapsed(t0))
        assertEquals(5_000L, s.elapsed(at(5)))
        assertEquals(90_000L, s.elapsed(at(90)))
        // No mutation happened - the state object is unchanged.
        assertEquals(0L, s.accumulatedMs)
    }

    @Test
    fun `elapsed matches the web formula while running, paused and idle`() {
        val running = Timer.start("Line 1", t0)
        val paused = Timer.pause(running, at(10))
        val idle = Timer.EMPTY

        for (offset in listOf(0L, 1L, 10L, 37L, 3600L)) {
            val now = at(offset)
            assertEquals(webElapsed(running, now), running.elapsed(now), "running @$offset")
            assertEquals(webElapsed(paused, now), paused.elapsed(now), "paused @$offset")
            assertEquals(webElapsed(idle, now), idle.elapsed(now), "idle @$offset")
        }
    }

    @Test
    fun `an idle timer is not active and reports zero`() {
        assertFalse(Timer.EMPTY.active)
        assertFalse(Timer.EMPTY.running)
        assertEquals(0L, Timer.EMPTY.elapsed(at(999)))
    }

    // ---- pause ---------------------------------------------------------------

    @Test
    fun `pause banks the running segment exactly once and freezes elapsed`() {
        val s = Timer.pause(Timer.start("Line 1", t0), at(12))

        assertTrue(s.paused)
        assertTrue(s.running) // still an active stop, just not counting
        assertTrue(s.active)
        assertEquals(12_000L, s.accumulatedMs)
        assertNull(s.segStartMs)
        // Frozen: time passing while paused must not add to elapsed.
        assertEquals(12_000L, s.elapsed(at(12)))
        assertEquals(12_000L, s.elapsed(at(600)))
    }

    @Test
    fun `pausing an already-paused timer is a no-op and cannot double-bank`() {
        val once = Timer.pause(Timer.start("Line 1", t0), at(12))
        val twice = Timer.pause(once, at(30))

        assertSame(once, twice, "a second pause must return the same state, not re-bank")
        assertEquals(12_000L, twice.accumulatedMs)
    }

    @Test
    fun `pausing an idle timer is a no-op`() {
        assertSame(Timer.EMPTY, Timer.pause(Timer.EMPTY, at(5)))
    }

    // ---- resume --------------------------------------------------------------

    @Test
    fun `resume opens a new segment and keeps the banked time`() {
        val paused = Timer.pause(Timer.start("Line 1", t0), at(12))
        val resumed = Timer.resume(paused, at(50)) // 38s of paused gap

        assertFalse(resumed.paused)
        assertTrue(resumed.running)
        assertEquals(12_000L, resumed.accumulatedMs, "banked time survives resume")
        assertEquals(at(50), resumed.segStartMs)
        assertEquals(t0, resumed.startTs, "startTs still marks when the stop began")
        // The paused gap is excluded: 12s counted + 5s since resume.
        assertEquals(17_000L, resumed.elapsed(at(55)))
    }

    @Test
    fun `resuming a running timer is a no-op and cannot reset the segment`() {
        val running = Timer.start("Line 1", t0)
        val resumed = Timer.resume(running, at(30))

        assertSame(running, resumed)
        assertEquals(30_000L, resumed.elapsed(at(30)), "segment start was not moved")
    }

    @Test
    fun `resuming an idle timer is a no-op`() {
        assertSame(Timer.EMPTY, Timer.resume(Timer.EMPTY, at(5)))
    }

    // ---- multi-segment accounting -------------------------------------------

    @Test
    fun `pause and resume cycles sum the counted segments and exclude the gaps`() {
        // run 0-10s, paused 10-40s, run 40-55s, paused 55-70s, run 70-80s
        var s = Timer.start("Line 1", t0)
        s = Timer.pause(s, at(10))
        s = Timer.resume(s, at(40))
        s = Timer.pause(s, at(55))
        s = Timer.resume(s, at(70))

        // counted so far: 10s + 15s = 25s, plus 10s in the open segment
        assertEquals(35_000L, s.elapsed(at(80)))

        val finished = Timer.stop(s, at(80))
        assertEquals(35_000L, finished.durationMs)
        assertEquals(t0, finished.start, "start is when the stop began, not the last resume")
        assertEquals(at(80), finished.end)
        // The wall-clock span is 80s but only 35s was downtime being counted.
        assertEquals(80_000L, finished.end - finished.start)
    }

    // ---- stop ----------------------------------------------------------------

    @Test
    fun `stop while running counts the open segment`() {
        val finished = Timer.stop(Timer.start("Packaging", t0), at(45))

        assertEquals(t0, finished.start)
        assertEquals(at(45), finished.end)
        assertEquals(45_000L, finished.durationMs)
        assertEquals("Packaging", finished.machine)
    }

    @Test
    fun `stop while paused uses the banked time and ignores the paused gap`() {
        val paused = Timer.pause(Timer.start("Line 3", t0), at(20))
        val finished = Timer.stop(paused, at(300)) // stopped 280s after pausing

        assertEquals(20_000L, finished.durationMs, "paused time is not downtime")
        assertEquals(t0, finished.start)
        assertEquals(at(300), finished.end)
        assertEquals("Line 3", finished.machine)
    }

    @Test
    fun `stopping an idle timer yields a zero-duration stop, not a bogus one`() {
        // Guards the web app's NaN trap: there, `accumulated + (end - null)` would
        // be NaN. Here a missing segment must degrade to 0, never a negative or
        // epoch-sized duration.
        val finished = Timer.stop(Timer.EMPTY, at(10))

        assertEquals(0L, finished.durationMs)
        assertEquals(at(10), finished.start, "no startTs means the stop starts now")
        assertEquals(at(10), finished.end)
        assertEquals(0L, finished.end - finished.start)
    }

    @Test
    fun `duration never exceeds the wall-clock span of the stop`() {
        var s = Timer.start("Line 1", t0)
        s = Timer.pause(s, at(30))
        s = Timer.resume(s, at(100))
        val finished = Timer.stop(s, at(130))

        assertTrue(
            finished.durationMs <= finished.end - finished.start,
            "counted ${finished.durationMs}ms cannot exceed the ${finished.end - finished.start}ms span",
        )
        assertEquals(60_000L, finished.durationMs)
    }

    @Test
    fun `a stop that spans zero time is reported as zero, not negative`() {
        val finished = Timer.stop(Timer.start("Line 1", t0), t0)

        assertEquals(0L, finished.durationMs)
        assertTrue(finished.durationMs >= 0L)
    }

    // ---- purity --------------------------------------------------------------

    @Test
    fun `transitions do not mutate the state they are given`() {
        val started = Timer.start("Line 1", t0)
        val snapshot = started.copy()

        Timer.pause(started, at(10))
        Timer.resume(started, at(10))
        Timer.stop(started, at(10))

        assertEquals(snapshot, started, "Timer transitions must be side-effect free")
    }
}
