package com.stoptrack.mobile

import com.stoptrack.shared.Collection
import com.stoptrack.shared.FinishedStop
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
 * This is the SINGLE source of truth for the phone's stop timer: the notification,
 * the floating bubble AND the in-app WebView all drive and mirror this one timer
 * (the WebView via [MainActivity]'s two-way bridge). Ending never records a stop
 * with a default reason — it produces a [pending] [FinishedStop] and asks the app
 * to prompt for a reason (see [end]/[documentPending]).
 *
 * State is mirrored into [Prefs] on each transition so a foreground-service
 * restart (START_STICKY) resumes a running stop — or a pending one — rather than
 * losing it.
 */
class QuickStopController(
    private val store: PhoneStore,
    private val prefs: Prefs,
    private val scope: CoroutineScope,
    private val onChanged: () -> Unit,
    /** Invoked when [end] produces a stop awaiting a reason, so the service can
     *  bring the app forward to its reason picker. */
    private val onPending: () -> Unit = {},
) {
    @Volatile
    var state: TimerState = Timer.EMPTY
        private set

    /** A finished stop awaiting the operator's reason, or null. */
    @Volatile
    var pending: FinishedStop? = null
        private set

    /** Operator name + preferred machine, fed from [Prefs] by the service. */
    @Volatile var operator: String = ""
    @Volatile var machine: String = ""

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

    /** Start a stop on the current (or first configured) machine. No-op if a stop
     *  is already active or one is waiting to be documented. */
    @Synchronized
    fun start() {
        if (state.active || pending != null) return
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

    /** End the stop. Does NOT record it with a default reason — instead it stashes
     *  the finished stop as [pending] and asks the app to prompt for a reason. */
    @Synchronized
    fun end() {
        if (!state.active) return
        val finished = Timer.stop(state, now())
        state = Timer.EMPTY
        pending = finished
        persist()
        onChanged()
        onPending()
    }

    /** Record the pending stop with the operator-chosen reason (from the app's
     *  reason picker), then clear it. [operator] is the name the app supplies at
     *  document time — the web operator field, authoritative like the web's
     *  handleSave — falling back to the native [operator] if the app sends none. */
    @Synchronized
    fun documentPending(reason: String?, notes: String?, operator: String? = null) {
        val finished = pending ?: return
        val chosen = reason?.trim().takeUnless { it.isNullOrBlank() }
            ?: reasons().firstOrNull() ?: "Other"
        val record = StopRecord.create(
            machine = finished.machine,
            operator = operator ?: this.operator,
            start = finished.start,
            end = finished.end,
            durationMs = finished.durationMs,
            reason = chosen,
            notes = notes?.trim() ?: "",
        )
        val json = StopTrackJson.encodeToJsonElement(StopRecord.serializer(), record).jsonObject
        runCatching { store.upsertOne(Collection.STOPS, json) }
        pending = null
        persist()
        onChanged()
    }

    /** Drop the pending stop without recording it. */
    @Synchronized
    fun discardPending() {
        if (pending == null) return
        pending = null
        persist()
        onChanged()
    }

    /** One-tap behaviour for the bubble: active → end; a pending stop → open the
     *  app to add a reason; otherwise start. */
    fun toggle() = when {
        state.active -> end()
        pending != null -> onPending()
        else -> start()
    }

    /** Restore a running stop after a service restart. */
    fun restore(saved: TimerState?) {
        if (saved != null && saved.active) {
            state = saved
            if (machine.isBlank()) machine = saved.machine
            onChanged()
        }
    }

    /** Restore a stop that was awaiting a reason when the service was killed. */
    fun restorePending(saved: FinishedStop?) {
        if (saved != null && !state.active) {
            pending = saved
            onChanged()
        }
    }

    private fun persist() {
        val inProg = if (state.active)
            StopTrackJson.encodeToString(TimerState.serializer(), state) else ""
        val pend = pending?.let { StopTrackJson.encodeToString(FinishedStop.serializer(), it) } ?: ""
        scope.launch { prefs.update(inProgress = inProg, pendingStop = pend, lastMachine = machine) }
    }
}
