package com.stoptrack.mobile

import com.stoptrack.shared.Collection
import com.stoptrack.shared.StopTrackJson
import com.stoptrack.shared.SyncContract
import fi.iki.elonen.NanoHTTPD
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.long

/**
 * The StopTrack sync contract (server/README.md) served on 127.0.0.1. THIS is the
 * seam the web app points at: set Supervisor → Server sync → URL to
 * `http://127.0.0.1:<port>` and everything the watch logs shows up in the web
 * app's supervisor view with no external server involved.
 *
 * Bound to loopback only, so it is never reachable off the phone. Because the web
 * app is an https origin talking to http loopback, every response carries CORS
 * headers and preflights answer Chrome's Private Network Access probe.
 */
class LocalSyncServer(
    private val store: PhoneStore,
    private val token: String?,
    port: Int,
    private val onActivity: (String) -> Unit = {},
    private val onConfigChanged: () -> Unit = {},
) : NanoHTTPD("127.0.0.1", port) {

    override fun serve(session: IHTTPSession): Response {
        // Preflight — approve CORS + private-network access.
        if (session.method == Method.OPTIONS) return cors(noContent())

        if (!authOk(session)) return cors(json(Response.Status.UNAUTHORIZED, errorBody("unauthorized")))

        val path = session.uri
        val method = session.method
        val serverTime = System.currentTimeMillis()

        return try {
            val response = when {
                path == SyncContract.HEALTH && method == Method.GET ->
                    json(Response.Status.OK, ok(serverTime))

                path == SyncContract.CONFIG && method == Method.GET -> {
                    val (config, updatedAt) = store.getConfig()
                    json(Response.Status.OK, buildJsonObject {
                        put("config", config ?: JsonObject(emptyMap()))
                        put("updatedAt", JsonPrimitive(updatedAt))
                    })
                }

                path == SyncContract.CONFIG && method == Method.PUT -> {
                    val body = readJson(session)
                    val config = body?.get("config") as? JsonObject
                    val incomingAt = (body?.get("updatedAt") as? JsonPrimitive)?.long
                        ?: (config?.get("updatedAt") as? JsonPrimitive)?.long ?: 0L
                    val changed = store.putConfig(config, incomingAt)
                    if (changed) {
                        onActivity("config updated from web app")
                        onConfigChanged() // push machines/reasons/quick-stops to the watch
                    }
                    json(Response.Status.OK, ok(serverTime))
                }

                path == SyncContract.REPORT && method == Method.POST ->
                    // Handover email is a server-only feature; the web app falls
                    // back to copy/paste when this answers 501.
                    json(Response.Status.NOT_IMPLEMENTED, errorBody("email not supported by companion"))

                else -> {
                    val collection = collectionFor(path)
                    if (collection == null) json(Response.Status.NOT_FOUND, errorBody("not found"))
                    else when (method) {
                        Method.GET -> {
                            val since = session.parameters[SyncContract.SINCE_PARAM]?.firstOrNull()?.toLongOrNull() ?: 0L
                            val records = store.since(collection, since)
                            json(Response.Status.OK, buildJsonObject {
                                put(collection.payloadKey, kotlinx.serialization.json.JsonArray(records))
                                put("serverTime", JsonPrimitive(serverTime))
                            })
                        }
                        Method.POST -> {
                            val body = readJson(session)
                            val records = body.arrayFieldOrEmpty(collection.payloadKey)
                            val changed = store.upsert(collection, records)
                            if (changed > 0) onActivity("$changed ${collection.name.lowercase()} from web app")
                            json(Response.Status.OK, ok(serverTime))
                        }
                        else -> json(Response.Status.METHOD_NOT_ALLOWED, errorBody("method not allowed"))
                    }
                }
            }
            cors(response)
        } catch (e: Exception) {
            cors(json(Response.Status.INTERNAL_ERROR, errorBody(e.message ?: "error")))
        }
    }

    private fun collectionFor(path: String): Collection? = when (path) {
        SyncContract.STOPS -> Collection.STOPS
        SyncContract.PRODUCTION -> Collection.PRODUCTION
        SyncContract.SESSIONS -> Collection.SESSIONS
        else -> null
    }

    private fun authOk(session: IHTTPSession): Boolean {
        if (token.isNullOrBlank()) return true // open on loopback
        val header = session.headers["authorization"] ?: return false
        return header.trim() == "Bearer $token"
    }

    // --- body / response helpers ---------------------------------------------

    private fun readJson(session: IHTTPSession): JsonObject? {
        val files = HashMap<String, String>()
        return try {
            session.parseBody(files)
            val raw = files["postData"] ?: return null
            StopTrackJson.parseToJsonElement(raw).jsonObject
        } catch (e: Exception) {
            null
        }
    }

    private fun json(status: Response.Status, body: JsonObject): Response =
        newFixedLengthResponse(status, "application/json", StopTrackJson.encodeToString(JsonObject.serializer(), body))

    private fun ok(serverTime: Long): JsonObject = buildJsonObject {
        put("ok", JsonPrimitive(true))
        put("serverTime", JsonPrimitive(serverTime))
    }

    private fun errorBody(message: String): JsonObject = buildJsonObject {
        put("ok", JsonPrimitive(false))
        put("error", JsonPrimitive(message))
    }

    private fun noContent(): Response =
        newFixedLengthResponse(Response.Status.NO_CONTENT, "application/json", "")

    /** Attach CORS + Private Network Access headers so the https web app can call in. */
    private fun cors(response: Response): Response = response.apply {
        addHeader("Access-Control-Allow-Origin", "*")
        addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        addHeader("Access-Control-Allow-Headers", "Authorization, Content-Type")
        addHeader("Access-Control-Allow-Private-Network", "true")
        addHeader("Access-Control-Max-Age", "600")
    }
}

private fun JsonObject?.arrayFieldOrEmpty(key: String): List<JsonObject> =
    (this?.get(key) as? kotlinx.serialization.json.JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
