package com.stoptrack.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The always-on bridge. Keeps the local sync server (for the web app) and the
 * remote forwarder (optional) running whether or not the companion UI is open,
 * so a watch can hand off a stop at any time. Runs as a foreground service with a
 * persistent notification, as Android requires for this kind of long-lived work.
 */
class CompanionService : LifecycleService() {

    private val store by lazy { PhoneStore.get(this) }
    private val prefs by lazy { Prefs(this) }
    private val bridge by lazy { PhoneWearBridge(this) }

    private var server: LocalSyncServer? = null
    private var serverPort = -1
    private var serverToken: String? = null
    private var forwardJob: Job? = null
    private var current: Settings = Settings()

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startInForeground("Starting bridge…")
        // React to every settings change: (re)bind the server, (re)start the forwarder.
        lifecycleScope.launch {
            prefs.settings.collect { applySettings(it) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        return START_STICKY
    }

    private fun applySettings(s: Settings) {
        current = s
        val token = s.localToken.ifBlank { null }
        if (server == null || serverPort != s.localPort || serverToken != token) {
            restartServer(s.localPort, token)
        }

        forwardJob?.cancel()
        if (s.forwardEnabled && s.remoteUrl.isNotBlank()) {
            forwardJob = lifecycleScope.launch(Dispatchers.IO) {
                val forwarder = RemoteForwarder(store, prefs)
                while (isActive) {
                    runCatching { forwarder.runOnce(prefs.snapshot()) }
                    delay(FORWARD_INTERVAL_MS)
                }
            }
        }

        // Keep the watch's config current whenever settings change.
        lifecycleScope.launch { bridge.publishConfig(store.watchConfigJson()) }
        updateNotification()
    }

    private fun restartServer(port: Int, token: String?) {
        runCatching { server?.stop() }
        // onConfigChanged fires when the web app saves supervisor settings (PUT
        // /config); push the new machines/reasons/quick-stops to the watch at once.
        val srv = LocalSyncServer(
            store = store,
            token = token,
            port = port,
            onConfigChanged = { publishConfigToWatch() },
        )
        val started = runCatching { srv.start(NanoHttpTimeoutMs, false) }.isSuccess
        server = if (started) srv else null
        serverPort = if (started) port else -1
        serverToken = token
        updateNotification()
    }

    private fun publishConfigToWatch() {
        lifecycleScope.launch { bridge.publishConfig(store.watchConfigJson()) }
    }

    private fun startInForeground(text: String) {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        // Never let a foreground-start refusal crash the app; the UI must still open.
        // Worst case the bridge runs as an ordinary service.
        runCatching { ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(text), type) }
    }

    private fun updateNotification() {
        val running = server != null
        val text = buildString {
            append(if (running) "Serving http://127.0.0.1:$serverPort" else "Local server stopped")
            append(" · ${store.count(com.stoptrack.shared.Collection.STOPS)} stops")
            if (current.forwardEnabled) append(" · forwarding")
        }
        val mgr = getSystemService(NotificationManager::class.java)
        mgr.notify(NOTIF_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val openSettings = PendingIntent.getActivity(
            this, 1, Intent(this, BridgeSettingsActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("StopTrack running")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setOngoing(true)
            .setContentIntent(openApp)
            .addAction(0, "Bridge settings", openSettings)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, getString(R.string.bridge_channel_name), NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Keeps the StopTrack watch bridge running." }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        runCatching { server?.stop() }
        forwardJob?.cancel()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "stoptrack_bridge"
        private const val NOTIF_ID = 1001
        private const val FORWARD_INTERVAL_MS = 25_000L
        private const val NanoHttpTimeoutMs = 5000

        fun start(context: android.content.Context) {
            val intent = Intent(context, CompanionService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }
    }
}
