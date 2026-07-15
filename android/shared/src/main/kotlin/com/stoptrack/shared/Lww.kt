package com.stoptrack.shared

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Last-write-wins timestamp for a record, matching the web app and server.js
 * `stampOf`: prefer `updatedAt`, then `loggedAt`, then `end`, then `start`, else 0.
 * Used to resolve conflicts when merging records from the watch, the web app, and
 * (optionally) the remote server.
 */
fun stampOf(record: JsonObject): Long {
    for (field in arrayOf("updatedAt", "loggedAt", "end", "start")) {
        val v = (record[field] as? JsonPrimitive)?.longOrNull
        if (v != null) return v
    }
    return 0L
}

/** The record's stable id, or null if the object has none. */
fun idOf(record: JsonObject): String? =
    (record["id"] as? JsonPrimitive)?.content?.takeIf { it.isNotEmpty() }

/**
 * Upsert [incoming] into [into] keyed by id, keeping whichever record has the
 * newer [stampOf] — the same rule the reference server uses. Returns true if the
 * store changed (incoming was newer or new).
 */
fun upsertNewer(into: MutableMap<String, JsonObject>, incoming: JsonObject): Boolean {
    val id = idOf(incoming) ?: return false
    val existing = into[id]
    if (existing == null || stampOf(incoming) >= stampOf(existing)) {
        into[id] = incoming
        return existing == null || stampOf(incoming) > stampOf(existing)
    }
    return false
}
