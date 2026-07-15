package com.stoptrack.wear

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.stoptrack.shared.QuickStop
import com.stoptrack.shared.StopRecord
import com.stoptrack.shared.WatchConfig
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class Phase { IDLE, RUNNING, PAUSED, DOCUMENTING, SAVED }

data class WatchUiState(
    val phase: Phase = Phase.IDLE,
    val operator: String = "",
    val machine: String = "",
    val config: WatchConfig = WatchConfig.DEFAULT,
    val elapsedMs: Long = 0L,
    val pendingStop: FinishedStop? = null,
    val reason: String = "",
    val phoneReachable: Boolean = false,
    val outboxCount: Int = 0,
    val lastSavedReason: String? = null,
) {
    val needsSetup: Boolean get() = machine.isBlank()
}

/**
 * Drives the whole watch experience. Holds the [TimerState] (the source of truth,
 * with elapsed derived), reflects [WatchStore] into UI state, and pushes finished
 * stops to the phone. All server concerns live on the phone — this class never
 * touches a network.
 */
class OperatorViewModel(app: Application) : AndroidViewModel(app) {

    private val store = WatchStore(app)
    private val phone = PhoneConnector(app)

    private var timer: TimerState = Timer.EMPTY
    private var tickJob: Job? = null

    private val _ui = MutableStateFlow(WatchUiState())
    val ui = _ui.asStateFlow()

    init {
        viewModelScope.launch { store.operator.collect { op -> _ui.update { it.copy(operator = op) } } }
        viewModelScope.launch { store.machine.collect { m -> _ui.update { it.copy(machine = m) } } }
        viewModelScope.launch { store.config.collect { c -> _ui.update { it.copy(config = c) } } }
        viewModelScope.launch { store.outbox.collect { o -> _ui.update { it.copy(outboxCount = o.size) } } }

        // Recover a timer that was live when the app was last closed.
        viewModelScope.launch {
            val saved = store.inProgress.first()
            if (saved != null && saved.active) {
                timer = restore(saved)
                _ui.update { it.copy(phase = if (timer.paused) Phase.PAUSED else Phase.RUNNING, elapsedMs = timer.elapsed(now())) }
                if (!timer.paused) startTicking()
            }
        }

        // Pull the latest config the phone published, then ask for a refresh.
        viewModelScope.launch {
            phone.readLatestConfigJson()?.let { store.setConfigJson(it) }
            phone.requestConfig()
            refreshReachable()
        }

        // Heartbeat: keep the reachability flag current and retry unsent stops.
        viewModelScope.launch {
            while (true) {
                delay(HEARTBEAT_MS)
                refreshReachable()
                flushOutbox()
            }
        }
    }

    // --- setup ----------------------------------------------------------------

    fun setOperator(name: String) = viewModelScope.launch { store.setOperator(name) }
    fun setMachine(machine: String) = viewModelScope.launch { store.setMachine(machine) }

    // --- timer lifecycle ------------------------------------------------------

    fun onStart() {
        val machine = _ui.value.machine
        if (machine.isBlank()) return
        timer = Timer.start(machine, now())
        persist()
        _ui.update { it.copy(phase = Phase.RUNNING, elapsedMs = 0L) }
        startTicking()
    }

    fun onPause() {
        timer = Timer.pause(timer, now())
        persist()
        stopTicking()
        _ui.update { it.copy(phase = Phase.PAUSED, elapsedMs = timer.elapsed(now())) }
    }

    fun onResume() {
        timer = Timer.resume(timer, now())
        persist()
        _ui.update { it.copy(phase = Phase.RUNNING) }
        startTicking()
    }

    fun onEnd() {
        val finished = Timer.stop(timer, now())
        timer = Timer.EMPTY
        stopTicking()
        viewModelScope.launch { store.saveInProgress(null) }
        val reasons = _ui.value.config.reasons
        _ui.update {
            it.copy(
                phase = Phase.DOCUMENTING,
                pendingStop = finished,
                reason = reasons.firstOrNull().orEmpty(),
                elapsedMs = finished.durationMs,
            )
        }
    }

    // --- documenting ----------------------------------------------------------

    fun selectReason(reason: String) = _ui.update { it.copy(reason = reason) }

    /** One-tap quick stop: applies its reason/notes and saves immediately. */
    fun onQuickStop(q: QuickStop) = saveStop(q.reason, q.notes)

    /** Save with the currently-selected reason. */
    fun onSaveSelected() = saveStop(_ui.value.reason, "")

    fun onDiscardPending() {
        _ui.update { it.copy(phase = Phase.IDLE, pendingStop = null) }
    }

    fun dismissSaved() {
        _ui.update { it.copy(phase = Phase.IDLE, pendingStop = null, lastSavedReason = null) }
    }

    private fun saveStop(reason: String, notes: String) {
        val pending = _ui.value.pendingStop ?: return
        val record = StopRecord.create(
            machine = pending.machine.ifBlank { _ui.value.machine },
            operator = _ui.value.operator,
            start = pending.start,
            end = pending.end,
            durationMs = pending.durationMs,
            reason = reason.ifBlank { "Other" },
            notes = notes,
        )
        viewModelScope.launch {
            store.addToOutbox(record)       // durable first — never lose a stop
            phone.sendStop(record)          // best-effort; ack later clears the outbox
        }
        _ui.update { it.copy(phase = Phase.SAVED, pendingStop = null, lastSavedReason = reason) }
        // Auto-return to idle so the operator isn't stuck on the confirmation.
        viewModelScope.launch {
            delay(SAVED_DISMISS_MS)
            if (_ui.value.phase == Phase.SAVED) dismissSaved()
        }
    }

    // --- helpers --------------------------------------------------------------

    fun retrySyncNow() = viewModelScope.launch { refreshReachable(); flushOutbox(); phone.requestConfig() }

    private fun startTicking() {
        stopTicking()
        tickJob = viewModelScope.launch {
            var sinceSave = 0L
            while (true) {
                _ui.update { it.copy(elapsedMs = timer.elapsed(now())) }
                delay(TICK_MS)
                sinceSave += TICK_MS
                if (sinceSave >= AUTOSAVE_MS) { persist(); sinceSave = 0L }
            }
        }
    }

    private fun stopTicking() {
        tickJob?.cancel()
        tickJob = null
    }

    private fun persist() = viewModelScope.launch { store.saveInProgress(timer) }

    private suspend fun refreshReachable() {
        val reachable = phone.isPhoneReachable()
        _ui.update { it.copy(phoneReachable = reachable) }
    }

    private suspend fun flushOutbox() {
        val queued = store.outbox.first()
        for (record in queued) phone.sendStop(record)
    }

    /** Port of the web app's `restore`: resume live, or hold paused-frozen. */
    private fun restore(d: TimerState): TimerState =
        if (d.paused || d.segStartMs == null)
            d.copy(running = true, paused = true, segStartMs = null)
        else
            d.copy(running = true, paused = false, segStartMs = now())

    private fun now() = System.currentTimeMillis()

    override fun onCleared() {
        super.onCleared()
        stopTicking()
    }

    private companion object {
        const val TICK_MS = 200L
        const val AUTOSAVE_MS = 5_000L
        const val HEARTBEAT_MS = 15_000L
        const val SAVED_DISMISS_MS = 2_000L
    }
}
