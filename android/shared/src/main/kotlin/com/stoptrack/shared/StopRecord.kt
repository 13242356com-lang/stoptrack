package com.stoptrack.shared

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * One machine-downtime stop, matching the StopTrack web app's stop record
 * (see ../../CLAUDE.md → "The stop record (data model)"). The watch only ever
 * builds TIMED stops (real start/end from the stopwatch), so this type omits the
 * fields that only apply elsewhere (`manual`, `discardReason`, `deleted`, …).
 * The phone companion stores incoming records opaquely as JSON, so those other
 * fields still round-trip fine when they arrive from the web app.
 *
 * Field names and semantics are deliberately identical to the web record so a
 * stop logged on the watch is indistinguishable from one logged on the phone
 * once it reaches the shared data set.
 */
@Serializable
data class StopRecord(
    val id: String,
    val machine: String,
    val operator: String,
    /** epoch ms — when the stop actually began (the watch's real Start press). */
    val start: Long,
    /** epoch ms — when the stop ended (End Stop press). */
    val end: Long,
    /** ms of downtime (end - start minus paused time). */
    val duration: Long,
    val reason: String,
    val notes: String = "",
    val discarded: Boolean = false,
    /**
     * epoch ms — when the record was CREATED. Drives current-shift membership in
     * the operator view. Critical: for a timed watch stop this equals the moment
     * End Stop was pressed, so it always lands in the current shift.
     */
    val loggedAt: Long,
    /** last-write-wins clock for sync (server + web resolve conflicts on this). */
    val updatedAt: Long,
) {
    companion object {
        /**
         * Build a stop the same way the web app's `handleSave` does:
         * `id = "<start>-<random>"`, `loggedAt`/`updatedAt` = now.
         */
        fun create(
            machine: String,
            operator: String,
            start: Long,
            end: Long,
            durationMs: Long,
            reason: String,
            notes: String = "",
            now: Long = System.currentTimeMillis(),
        ): StopRecord = StopRecord(
            id = "$start-${(0 until 1_000_000).random()}",
            machine = machine.ifBlank { "Unknown" },
            operator = operator.trim().ifBlank { "Unnamed" },
            start = start,
            end = end,
            duration = durationMs,
            reason = reason,
            notes = notes.trim(),
            discarded = false,
            loggedAt = now,
            updatedAt = now,
        )
    }
}

/** Shared JSON: emit defaults (so `discarded:false`/`notes:""` appear like the web
 * record) and ignore unknown keys (so evolving web records never break parsing). */
val StopTrackJson: Json = Json {
    encodeDefaults = true
    ignoreUnknownKeys = true
    isLenient = true
}

fun StopRecord.toJson(): String = StopTrackJson.encodeToString(this)
