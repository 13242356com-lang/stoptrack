package com.stoptrack.mobile

import com.stoptrack.shared.Collection
import com.stoptrack.shared.StopRecord
import com.stoptrack.shared.StopTrackJson
import com.stoptrack.shared.Timer
import com.stoptrack.shared.TimerState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The phone's native quick-stop timer — the source of truth behind the persistent
 * notification and the floating bubble, so an operator can start/stop a stop
 * WITHOUT opening the app. It reuses the shared [Timer] transitions (identical to
 * the web app's `useTimer`) and, on End, writes a [StopRecord] straight into
 * [PhoneStore]; the running [LocalSyncServer] then serves it to the web app and
 * the supervisor. Works with the app backgrounded or closed.
 *
 * State is mirrored into [Prefs] on each transition so a foreground-service
 * restart (START_STICKY) resumes a running stop rather than losing it.
 */
class QuickStopController(
    private val store: PhoneStore,
    private val prefs: Prefs,
    private val scope: CoroutineScope,
    private val onChanged: () -> Unit,
) {
    @Volatile
    var state: TimerState = Timer.EMPTY
        private set

    /** Operator name + preferred machine, fed from [Prefs] by the service. */
    @Volatile var operator: String = ""
    @Volatile var machine: String = ""

    /** True while the in-app WebView timer is running (reported via NativeBridge):
     *  native Start is suppressed so the two timers can't double-count one stop. */
    @Volatile var webTimerActive: Boolean = false

    private fun now() = System.currentTimeMillis()

    /** Machines from the synced supervisor config (for the bubble's picker). */
    fun machines(): List<String> = configList("machines")

    /** Reasons from the synced config; the default reason for a quick End. */
    fun reasons(): List<String> = configList("reasons")

    private fun configList(key: String): List<String> {
        val cfg = store.getConfig().first ?: return emptyList()
        val arr = cfg[key] as? JsonArray ?: return emptyList()
        return arr.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() }
    }

    /** Start a stop on the current (or first configured) machine. No-op if the
     *  in-app timer is already running, or a native stop is already active. */
    @Synchronized
    fun start() {
        if (webTimerActive || state.active) return
        val m = machine.ifBlank { machines().firstOrNull() ?: "Unknown" }
        machine = m
        state = Timer.start(m, now())
        persist()
        onChanged()
    }

    @Synchronized
    fun pause() {
        if (!state.running || state.paused) return
        state = Timer.pause(state, now())
        persist()
        onChanged()
    }

    @Synchronized
    fun resume() {
        if (!state.paused) return
        state = Timer.resume(state, now())
        persist()
        onChanged()
    }

    /** End the stop and record it (reason defaults to the first configured reason,
     *  else "Other" — the operator can annotate it later in the app). */
    @Synchronized
    fun end(reason: String? = null) {
        if (!state.active) return
        val finished = Timer.stop(state, now())
        state = Timer.EMPTY
        val chosen = reason?.trim().takeUnless { it.isNullOrBlank() }
            ?: reasons().firstOrNull() ?: "Other"
        val record = StopRecord.create(
            machine = finished.machine,
            operator = operator,
            start = finished.start,
            end = finished.end,
            durationMs = finished.durationMs,
            reason = chosen,
        )
        val json = StopTrackJson.encodeToJsonElement(StopRecord.serializer(), record).jsonObject
        runCatching { store.upsertOne(Collection.STOPS, json) }
        persist()
        onChanged()
    }

    /** One-tap behaviour for the bubble: idle → start, active → end. */
    fun toggle() = if (state.active) end() else start()

    /** Restore a running stop after a service restart. */
    fun restore(saved: TimerState?) {
        if (saved != null && saved.active) {
            state = saved
            if (machine.isBlank()) machine = saved.machine
            onChanged()
        }
    }

    private fun persist() {
        val serialized = if (state.active)
            StopTrackJson.encodeToString(TimerState.serializer(), state) else ""
        scope.launch { prefs.update(inProgress = serialized, lastMachine = machine) }
    }
}
