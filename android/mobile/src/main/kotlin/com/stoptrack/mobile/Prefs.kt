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
        )
    }

    suspend fun snapshot(): Settings = settings.first()

    suspend fun update(
        localPort: Int? = null,
        localToken: String? = null,
        remoteUrl: String? = null,
        remoteToken: String? = null,
        forwardEnabled: Boolean? = null,
    ) {
        store.edit { p ->
            localPort?.let { p[Keys.PORT] = it }
            localToken?.let { p[Keys.LOCAL_TOKEN] = it.trim() }
            remoteUrl?.let { p[Keys.REMOTE_URL] = it.trim().trimEnd('/') }
            remoteToken?.let { p[Keys.REMOTE_TOKEN] = it.trim() }
            forwardEnabled?.let { p[Keys.FORWARD] = it }
        }
    }

    // --- forwarder cursors ----------------------------------------------------

    suspend fun pushCursor(): Long = store.data.first()[Keys.PUSH_CURSOR] ?: 0L
    suspend fun setPushCursor(v: Long) { store.edit { it[Keys.PUSH_CURSOR] = v } }

    suspend fun pullCursor(c: Collection): Long = store.data.first()[Keys.pullCursor(c)] ?: 0L
    suspend fun setPullCursor(c: Collection, v: Long) { store.edit { it[Keys.pullCursor(c)] = v } }
}
