package com.stoptrack.shared

import kotlinx.serialization.Serializable

/**
 * The slice of the shared `config:lists` object the WATCH needs: the machine
 * list, reason list, and quick-stop buttons. The full web config carries more
 * (shift times, PIN hash, rates, handover emails), but the watch only picks a
 * machine and a reason, so it ignores the rest (`ignoreUnknownKeys`).
 *
 * Defaults mirror the web app's DEFAULT_* lists so the watch is usable out of the
 * box before it has ever received a config push from the phone.
 */
@Serializable
data class WatchConfig(
    val machines: List<String> = DEFAULT_MACHINES,
    val reasons: List<String> = DEFAULT_REASONS,
    val quickStops: List<QuickStop> = DEFAULT_QUICK_STOPS,
    /** last-write-wins clock, copied from the shared config. */
    val updatedAt: Long = 0L,
) {
    companion object {
        // Generic example lists — StopTrack is universal. A supervisor edits
        // these to match any line/machine; kept in step with the web defaults.
        val DEFAULT_MACHINES = listOf(
            "Line 1", "Line 2", "Line 3", "Packaging", "Assembly",
        )
        val DEFAULT_REASONS = listOf(
            "Mechanical fault", "Quality check", "Waiting on maintenance", "Tooling change",
            "Cleaning", "Material shortage", "Changeover / Setup", "Material jam",
            "Operator break", "Electrical fault", "Other",
        )
        val DEFAULT_QUICK_STOPS = listOf(
            QuickStop("Mechanical fault", "Mechanical fault"),
            QuickStop("Quality check", "Quality check"),
            QuickStop("Maintenance", "Waiting on maintenance"),
            QuickStop("Tooling change", "Tooling change"),
            QuickStop("Cleaning", "Cleaning"),
            QuickStop("Material jam", "Material jam"),
        )

        val DEFAULT = WatchConfig()
    }
}

/** One-tap stop button: a label, the reason it maps to, and an optional default note.
 * Shape matches the web app's quick-stop object `{ label, reason, notes }`. */
@Serializable
data class QuickStop(
    val label: String,
    val reason: String,
    val notes: String = "",
)
