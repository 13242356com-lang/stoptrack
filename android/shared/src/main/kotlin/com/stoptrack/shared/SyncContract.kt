package com.stoptrack.shared

/**
 * The StopTrack sync HTTP contract (see ../../server/README.md). The phone
 * companion IMPLEMENTS this on 127.0.0.1 for the local web app, and CONSUMES it
 * when optionally forwarding to a remote server. Keep these paths in step with
 * server/server.js.
 */
object SyncContract {
    const val HEALTH = "/health"
    const val STOPS = "/stops"
    const val CONFIG = "/config"
    const val PRODUCTION = "/production"
    const val SESSIONS = "/sessions"
    const val REPORT = "/report"

    /** GET query param used by /stops, /production, /sessions to page changes. */
    const val SINCE_PARAM = "since"

    /** Bearer scheme for the shared factory token. */
    fun authHeader(token: String?): Pair<String, String>? =
        if (token.isNullOrBlank()) null else "Authorization" to "Bearer $token"
}

/**
 * The three synced record collections. The companion keeps one keyed map per
 * collection, exactly like server.js's `{ stops, production, sessions }`.
 *
 * [payloadKey] is the JSON array field the contract uses for that collection:
 * `/stops` wraps records under "stops", while `/production` and `/sessions` use
 * "records" (see server/README.md). Get and post use the same key.
 */
enum class Collection(val path: String, val payloadKey: String) {
    STOPS(SyncContract.STOPS, "stops"),
    PRODUCTION(SyncContract.PRODUCTION, "records"),
    SESSIONS(SyncContract.SESSIONS, "records"),
}
