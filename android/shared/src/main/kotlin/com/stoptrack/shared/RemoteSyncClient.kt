package com.stoptrack.shared

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URI

/**
 * Blocking HTTP client for the StopTrack sync contract, built on plain
 * `HttpURLConnection` (no third-party HTTP dep). The phone companion uses this
 * ONLY for the optional, last-resort forward to a remote StopTrack server — the
 * watch<->phone path never touches it.
 *
 * All calls are synchronous; callers run them off the main thread (e.g. from a
 * coroutine on Dispatchers.IO).
 */
class RemoteSyncClient(baseUrl: String, private val token: String?) {

    /** Base URL with any trailing slash trimmed, matching the web app's `cleanUrl`. */
    private val base: String = baseUrl.trim().trimEnd('/')

    data class Health(val ok: Boolean, val serverTime: Long, val error: String? = null)
    data class Pull(val records: List<JsonObject>, val serverTime: Long)

    /** GET /health — true when the server answers 2xx. */
    fun health(): Health = try {
        val (code, body) = request("GET", SyncContract.HEALTH, null)
        if (code in 200..299) {
            Health(true, (body?.get("serverTime") as? kotlinx.serialization.json.JsonPrimitive)?.long ?: 0L)
        } else Health(false, 0L, "HTTP $code")
    } catch (e: Exception) {
        Health(false, 0L, e.message ?: "network error")
    }

    /** POST records to a collection (LWW upsert on the server). */
    fun push(collection: Collection, records: List<JsonObject>): Boolean {
        if (records.isEmpty()) return true
        val payload = buildJsonObject {
            put(collection.payloadKey, JsonArray(records))
        }
        val (code, _) = request("POST", collection.path, payload)
        return code in 200..299
    }

    /** GET a collection's records changed since [since] (ms), incl. tombstones. */
    fun pull(collection: Collection, since: Long): Pull {
        val path = "${collection.path}?${SyncContract.SINCE_PARAM}=$since"
        val (code, body) = request("GET", path, null)
        if (code !in 200..299 || body == null) return Pull(emptyList(), since)
        val arr = (body[collection.payloadKey] as? JsonArray) ?: JsonArray(emptyList())
        val records = arr.mapNotNull { it as? JsonObject }
        val serverTime = (body["serverTime"] as? kotlinx.serialization.json.JsonPrimitive)?.long ?: since
        return Pull(records, serverTime)
    }

    /** GET /config -> the shared config object (or null if the server has none). */
    fun getConfig(): Pair<JsonObject?, Long> {
        val (code, body) = request("GET", SyncContract.CONFIG, null)
        if (code !in 200..299 || body == null) return null to 0L
        val cfg = body["config"] as? JsonObject
        val at = (body["updatedAt"] as? kotlinx.serialization.json.JsonPrimitive)?.long ?: 0L
        return cfg to at
    }

    /** PUT /config — server keeps it only if [updatedAt] is newer (LWW). */
    fun putConfig(config: JsonObject, updatedAt: Long): Boolean {
        val payload = buildJsonObject {
            put("config", config)
            put("updatedAt", updatedAt)
        }
        val (code, _) = request("PUT", SyncContract.CONFIG, payload)
        return code in 200..299
    }

    // --- transport ------------------------------------------------------------

    private fun request(method: String, path: String, body: JsonObject?): Pair<Int, JsonObject?> {
        val conn = (URI.create(base + path).toURL().openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 8000
            readTimeout = 8000
            setRequestProperty("Content-Type", "application/json")
            SyncContract.authHeader(token)?.let { (k, v) -> setRequestProperty(k, v) }
            if (body != null) {
                doOutput = true
                outputStream.use { it.write(StopTrackJson.encodeToString(JsonObject.serializer(), body).toByteArray()) }
            }
        }
        return try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            val json = runCatching { StopTrackJson.parseToJsonElement(text).jsonObject }.getOrNull()
            code to json
        } finally {
            conn.disconnect()
        }
    }
}
