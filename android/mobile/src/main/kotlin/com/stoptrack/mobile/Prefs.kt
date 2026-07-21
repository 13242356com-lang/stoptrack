package com.stoptrack.mobile

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.stoptrack.shared.Collection
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.settingsStore: DataStore<Preferences> by preferencesDataStore(name = "companion_settings")

/** Everything the operator/supervisor configures on the phone companion. */
data class Settings(
    val localPort: Int = DEFAULT_PORT,
    val localToken: String = "",
    val remoteUrl: String = "",
    val remoteToken: String = "",
    val forwardEnabled: Boolean = false,
    // Quick-stop presence (notification + floating bubble).
    val operatorName: String = "",
    val lastMachine: String = "",
    val overlayEnabled: Boolean = false,
    val overlayX: Int = 0,
    val overlayY: Int = 200,
    /** Serialized in-progress [com.stoptrack.shared.TimerState]; "" = none. Lets a
     *  running quick-stop survive a foreground-service restart. */
    val inProgress: String = "",
) {
    companion object {
        const val DEFAULT_PORT = 4000
    }
}

/**
 * Companion settings + sync cursors, on DataStore. Kept small: the local server
 * config, the optional remote-forward config, and last-write-wins cursors so the
 * forwarder only ships deltas.
 */
class Prefs(context: Context) {

    private val store = context.applicationContext.settingsStore

    private object Keys {
        val PORT = intPreferencesKey("local_port")
        val LOCAL_TOKEN = stringPreferencesKey("local_token")
        val REMOTE_URL = stringPreferencesKey("remote_url")
        val REMOTE_TOKEN = stringPreferencesKey("remote_token")
        val FORWARD = booleanPreferencesKey("forward_enabled")
        val OPERATOR = stringPreferencesKey("operator_name")
        val LAST_MACHINE = stringPreferencesKey("last_machine")
        val OVERLAY_ON = booleanPreferencesKey("overlay_enabled")
        val OVERLAY_X = intPreferencesKey("overlay_x")
        val OVERLAY_Y = intPreferencesKey("overlay_y")
        val IN_PROGRESS = stringPreferencesKey("in_progress")
        val PUSH_CURSOR = longPreferencesKey("cursor_push")
        fun pullCursor(c: Collection) = longPreferencesKey("cursor_pull_${c.name.lowercase()}")
    }

    val settings: Flow<Settings> = store.data.map { p ->
        Settings(
            localPort = p[Keys.PORT] ?: Settings.DEFAULT_PORT,
            localToken = p[Keys.LOCAL_TOKEN] ?: "",
            remoteUrl = p[Keys.REMOTE_URL] ?: "",
            remoteToken = p[Keys.REMOTE_TOKEN] ?: "",
            forwardEnabled = p[Keys.FORWARD] ?: false,
            operatorName = p[Keys.OPERATOR] ?: "",
            lastMachine = p[Keys.LAST_MACHINE] ?: "",
            overlayEnabled = p[Keys.OVERLAY_ON] ?: false,
            overlayX = p[Keys.OVERLAY_X] ?: 0,
            overlayY = p[Keys.OVERLAY_Y] ?: 200,
            inProgress = p[Keys.IN_PROGRESS] ?: "",
        )
    }

    suspend fun snapshot(): Settings = settings.first()

    suspend fun update(
        localPort: Int? = null,
        localToken: String? = null,
        remoteUrl: String? = null,
        remoteToken: String? = null,
        forwardEnabled: Boolean? = null,
        operatorName: String? = null,
        lastMachine: String? = null,
        overlayEnabled: Boolean? = null,
        overlayX: Int? = null,
        overlayY: Int? = null,
        inProgress: String? = null,
    ) {
        store.edit { p ->
            localPort?.let { p[Keys.PORT] = it }
            localToken?.let { p[Keys.LOCAL_TOKEN] = it.trim() }
            remoteUrl?.let { p[Keys.REMOTE_URL] = it.trim().trimEnd('/') }
            remoteToken?.let { p[Keys.REMOTE_TOKEN] = it.trim() }
            forwardEnabled?.let { p[Keys.FORWARD] = it }
            operatorName?.let { p[Keys.OPERATOR] = it.trim() }
            lastMachine?.let { p[Keys.LAST_MACHINE] = it }
            overlayEnabled?.let { p[Keys.OVERLAY_ON] = it }
            overlayX?.let { p[Keys.OVERLAY_X] = it }
            overlayY?.let { p[Keys.OVERLAY_Y] = it }
            inProgress?.let { p[Keys.IN_PROGRESS] = it }
        }
    }

    // --- forwarder cursors ----------------------------------------------------

    suspend fun pushCursor(): Long = store.data.first()[Keys.PUSH_CURSOR] ?: 0L
    suspend fun setPushCursor(v: Long) { store.edit { it[Keys.PUSH_CURSOR] = v } }

    suspend fun pullCursor(c: Collection): Long = store.data.first()[Keys.pullCursor(c)] ?: 0L
    suspend fun setPullCursor(c: Collection, v: Long) { store.edit { it[Keys.pullCursor(c)] = v } }
}
