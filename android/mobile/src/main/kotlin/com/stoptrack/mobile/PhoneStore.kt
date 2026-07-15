package com.stoptrack.mobile

import android.content.Context
import com.stoptrack.shared.Collection
import com.stoptrack.shared.StopTrackJson
import com.stoptrack.shared.stampOf
import com.stoptrack.shared.upsertNewer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.long
import kotlinx.serialization.json.JsonPrimitive
import java.io.File

/**
 * The phone's local data set — the offline, server-free heart of the companion.
 * It mirrors server.js exactly: three id-keyed collections (stops / production /
 * sessions) plus a shared config, records treated opaquely and merged
 * last-write-wins. The web app syncs against this (via [LocalSyncServer]) and the
 * watch feeds stops into it, so the whole system works with no server at all.
 *
 * Blocking + `@Synchronized` on purpose: NanoHTTPD and the Wear listener both
 * call in from their own threads, and a single lock is simpler than juggling
 * suspend boundaries. Volume is a factory line's worth of stops, so persisting
 * the whole file per change (like the reference server) is fine.
 */
class PhoneStore private constructor(context: Context) {

    private val file = File(context.filesDir, "companion-data.json")

    private val collections: Map<Collection, MutableMap<String, JsonObject>> = mapOf(
        Collection.STOPS to mutableMapOf(),
        Collection.PRODUCTION to mutableMapOf(),
        Collection.SESSIONS to mutableMapOf(),
    )
    private var config: JsonObject? = null
    private var configUpdatedAt: Long = 0L

    init {
        load()
    }

    // --- records --------------------------------------------------------------

    /** Upsert records into a collection (LWW). Returns how many actually changed. */
    @Synchronized
    fun upsert(collection: Collection, records: List<JsonObject>): Int {
        val map = collections.getValue(collection)
        var changed = 0
        for (r in records) if (upsertNewer(map, r)) changed++
        if (changed > 0) persist()
        return changed
    }

    /** One record straight in (used by the Wear listener for a single stop). */
    fun upsertOne(collection: Collection, record: JsonObject): Boolean =
        upsert(collection, listOf(record)) > 0

    /** Records in a collection changed since [since] ms (incl. tombstones). */
    @Synchronized
    fun since(collection: Collection, since: Long): List<JsonObject> =
        collections.getValue(collection).values.filter { stampOf(it) > since }

    @Synchronized
    fun count(collection: Collection): Int = collections.getValue(collection).size

    // --- config ---------------------------------------------------------------

    @Synchronized
    fun getConfig(): Pair<JsonObject?, Long> = config to configUpdatedAt

    /** Replace config if [updatedAt] is newer (LWW), like the server's PUT /config. */
    @Synchronized
    fun putConfig(newConfig: JsonObject?, updatedAt: Long): Boolean {
        if (updatedAt >= configUpdatedAt) {
            config = newConfig
            configUpdatedAt = updatedAt
            persist()
            return true
        }
        return false
    }

    /**
     * The config JSON to push to the watch: just the fields the watch needs
     * (machines / reasons / quick stops), so its PIN hash etc. never leave the
     * phone. Falls back to an empty object → the watch keeps its defaults.
     */
    @Synchronized
    fun watchConfigJson(): String {
        val cfg = config ?: return "{}"
        val slim = buildJsonObject {
            for (key in arrayOf("machines", "reasons", "quickStops")) {
                cfg[key]?.let { put(key, it) }
            }
            put("updatedAt", JsonPrimitive(configUpdatedAt))
        }
        return StopTrackJson.encodeToString(JsonObject.serializer(), slim)
    }

    // --- persistence ----------------------------------------------------------

    private fun persist() {
        val root = buildJsonObject {
            for ((collection, map) in collections) {
                put(collection.name.lowercase(), JsonObject(map))
            }
            put("config", buildJsonObject {
                config?.let { put("config", it) }
                put("updatedAt", JsonPrimitive(configUpdatedAt))
            })
        }
        runCatching { file.writeText(StopTrackJson.encodeToString(JsonObject.serializer(), root)) }
    }

    private fun load() {
        if (!file.exists()) return
        val root = runCatching { StopTrackJson.parseToJsonElement(file.readText()).jsonObject }.getOrNull() ?: return
        for ((collection, map) in collections) {
            (root[collection.name.lowercase()] as? JsonObject)?.forEach { (id, value) ->
                (value as? JsonObject)?.let { map[id] = it }
            }
        }
        (root["config"] as? JsonObject)?.let { c ->
            config = c["config"] as? JsonObject
            configUpdatedAt = (c["updatedAt"] as? JsonPrimitive)?.long ?: 0L
        }
    }

    companion object {
        @Volatile
        private var instance: PhoneStore? = null

        /** Process-wide singleton so the HTTP server, Wear listener, and forwarder
         *  all share one data set. */
        fun get(context: Context): PhoneStore =
            instance ?: synchronized(this) {
                instance ?: PhoneStore(context.applicationContext).also { instance = it }
            }
    }
}
