package com.stoptrack.mobile

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.stoptrack.shared.Collection
import com.stoptrack.shared.RemoteSyncClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class CompanionUi(
    val settings: Settings = Settings(),
    val storedStops: Int = 0,
    val connectedWatches: Int = 0,
    val testResult: String? = null,
    val testing: Boolean = false,
)

/**
 * Backs the companion screen. Writes go to [Prefs]; the running [CompanionService]
 * observes those and reconfigures itself, so the UI never talks to the server or
 * the Data Layer directly — it just edits settings and reads counts.
 */
class CompanionViewModel(app: Application) : AndroidViewModel(app) {

    private val prefs = Prefs(app)
    private val store = PhoneStore.get(app)
    private val bridge = PhoneWearBridge(app)

    private val _ui = MutableStateFlow(CompanionUi())
    val ui = _ui.asStateFlow()

    init {
        viewModelScope.launch { prefs.settings.collect { s -> _ui.update { it.copy(settings = s) } } }
        // Light polling for live counts (stored stops + connected watches).
        viewModelScope.launch {
            while (true) {
                val stops = store.count(Collection.STOPS)
                val watches = bridge.connectedWatchCount()
                _ui.update { it.copy(storedStops = stops, connectedWatches = watches) }
                delay(4000)
            }
        }
    }

    fun setLocalPort(port: Int) = viewModelScope.launch { prefs.update(localPort = port) }
    fun setLocalToken(token: String) = viewModelScope.launch { prefs.update(localToken = token) }
    fun setRemoteUrl(url: String) = viewModelScope.launch { prefs.update(remoteUrl = url) }
    fun setRemoteToken(token: String) = viewModelScope.launch { prefs.update(remoteToken = token) }
    fun setForwardEnabled(enabled: Boolean) = viewModelScope.launch { prefs.update(forwardEnabled = enabled) }
    fun setOperatorName(name: String) = viewModelScope.launch { prefs.update(operatorName = name) }
    fun setOverlayEnabled(enabled: Boolean) = viewModelScope.launch { prefs.update(overlayEnabled = enabled) }

    fun pushConfigToWatch() = viewModelScope.launch { bridge.publishConfig(store.watchConfigJson()) }

    /** Test the optional remote server the same way the web app's Test connection does. */
    fun testRemote() {
        val s = _ui.value.settings
        if (s.remoteUrl.isBlank()) return
        _ui.update { it.copy(testing = true, testResult = null) }
        viewModelScope.launch {
            val health = withContext(Dispatchers.IO) {
                RemoteSyncClient(s.remoteUrl, s.remoteToken.ifBlank { null }).health()
            }
            _ui.update {
                it.copy(testing = false, testResult = if (health.ok) "Server reachable" else (health.error ?: "Connection failed"))
            }
        }
    }
}
