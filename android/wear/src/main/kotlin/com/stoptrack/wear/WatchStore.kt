package com.stoptrack.wear

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.stoptrack.shared.StopRecord
import com.stoptrack.shared.StopTrackJson
import com.stoptrack.shared.WatchConfig
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "stoptrack_watch")

/**
 * Everything the watch persists locally, so a stop survives the app being closed
 * mid-timer and an unsent stop survives the phone being out of range. The
 * [PhoneMessageService] writes config/outbox here and the UI observes it — that
 * one-way "store is the source of truth" wiring keeps the service and UI
 * decoupled, mirroring the web app's single `api` touchpoint.
 */
class WatchStore(private val context: Context) {

    private object Keys {
        val OPERATOR = stringPreferencesKey("operator")
        val MACHINE = stringPreferencesKey("machine")
        val CONFIG = stringPreferencesKey("config_json")
        val OUTBOX = stringPreferencesKey("outbox_json")
        val INPROGRESS = stringPreferencesKey("inprogress_json")
        val SERVER_URL = stringPreferencesKey("server_url")
        val SERVER_TOKEN = stringPreferencesKey("server_token")
    }

    val operator: Flow<String> = context.dataStore.data.map { it[Keys.OPERATOR] ?: "" }
    val machine: Flow<String> = context.dataStore.data.map { it[Keys.MACHINE] ?: "" }

    // Direct server sync (the reliable path). Set once on the watch; empty = off.
    val serverUrl: Flow<String> = context.dataStore.data.map { it[Keys.SERVER_URL] ?: "" }
    val serverToken: Flow<String> = context.dataStore.data.map { it[Keys.SERVER_TOKEN] ?: "" }

    val config: Flow<WatchConfig> = context.dataStore.data.map { prefs ->
        prefs[Keys.CONFIG]?.let { runCatching { StopTrackJson.decodeFromString<WatchConfig>(it) }.getOrNull() }
            ?: WatchConfig.DEFAULT
    }

    val outbox: Flow<List<StopRecord>> = context.dataStore.data.map { prefs ->
        prefs[Keys.OUTBOX]?.let { runCatching { StopTrackJson.decodeFromString<List<StopRecord>>(it) }.getOrNull() }
            ?: emptyList()
    }

    val inProgress: Flow<TimerState?> = context.dataStore.data.map { prefs ->
        prefs[Keys.INPROGRESS]?.let { runCatching { StopTrackJson.decodeFromString<TimerState>(it) }.getOrNull() }
    }

    suspend fun setOperator(value: String) =
        context.dataStore.edit { it[Keys.OPERATOR] = value.trim() }.let {}

    suspend fun setMachine(value: String) =
        context.dataStore.edit { it[Keys.MACHINE] = value }.let {}

    suspend fun setServerUrl(value: String) =
        context.dataStore.edit { it[Keys.SERVER_URL] = value }.let {}

    suspend fun setServerToken(value: String) =
        context.dataStore.edit { it[Keys.SERVER_TOKEN] = value }.let {}

    /** Called by the Data Layer service when the phone pushes fresh config. */
    suspend fun setConfigJson(json: String) =
        context.dataStore.edit { it[Keys.CONFIG] = json }.let {}

    /** Autosave the live timer (or clear it when null). */
    suspend fun saveInProgress(state: TimerState?) {
        context.dataStore.edit { prefs ->
            if (state == null || !state.active) prefs.remove(Keys.INPROGRESS)
            else prefs[Keys.INPROGRESS] = StopTrackJson.encodeToString(TimerState.serializer(), state)
        }
    }

    suspend fun addToOutbox(record: StopRecord) {
        val current = outbox.first()
        val next = current.filter { it.id != record.id } + record
        writeOutbox(next)
    }

    /** Drop a stop the phone has acked as stored. */
    suspend fun removeFromOutbox(id: String) {
        val next = outbox.first().filter { it.id != id }
        writeOutbox(next)
    }

    private suspend fun writeOutbox(list: List<StopRecord>) {
        context.dataStore.edit {
            it[Keys.OUTBOX] = StopTrackJson.encodeToString(list)
        }
    }
}
