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
import com.stoptrack.shared.FinishedStop
import com.stoptrack.shared.StopTrackJson
import com.stoptrack.shared.TimerState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The always-on bridge + operator presence. Keeps the local sync server (for the
 * web app) and the optional remote forwarder running whether or not the UI is
 * open, and hosts the native quick-stop timer surfaced in the persistent
 * notification and the floating bubble — so a watch can hand off a stop and an
 * operator can log one without opening the app. Runs as a foreground service, as
 * Android requires for this long-lived work.
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

    // --- quick-stop presence ---------------------------------------------------
    private val controller by lazy {
        QuickStopController(
            store, prefs, lifecycleScope,
            onChanged = ::onTimerChanged,
            onPending = ::openApp,
        )
    }
    private var overlay: OverlayController? = null
    private var tickJob: Job? = null
    private var restoredInProgress = false

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startInForeground("Starting bridge…")
        // React to every settings change: (re)bind the server, (re)start the
        // forwarder, sync operator/machine + the floating bubble.
        lifecycleScope.launch {
            prefs.settings.collect { applySettings(it) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        // Notification-action taps arrive here as service intents.
        when (intent?.action) {
            ACTION_START -> {
                intent.getStringExtra(EXTRA_MACHINE)?.takeIf { it.isNotBlank() }
                    ?.let { controller.machine = it }
                controller.start()
            }
            ACTION_PAUSE -> controller.pause()
            ACTION_RESUME -> controller.resume()
            ACTION_END -> controller.end()
            // The operator picked a reason (in the app) for the pending stop, or
            // dismissed it — record or drop it.
            ACTION_DOCUMENT -> controller.documentPending(
                intent.getStringExtra(EXTRA_REASON),
                intent.getStringExtra(EXTRA_NOTES),
                intent.getStringExtra(EXTRA_OPERATOR),
            )
            ACTION_DISCARD -> controller.discardPending()
            // Re-check the overlay after the user grants "draw over other apps"
            // (granting doesn't change settings, so nothing else would re-run it).
            ACTION_REFRESH_OVERLAY -> lifecycleScope.launch { applyOverlay(prefs.snapshot()) }
        }
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

        // Operator + preferred machine for native quick-stops.
        controller.operator = s.operatorName
        if (controller.machine.isBlank()) controller.machine = s.lastMachine

        // Resume a running — or awaiting-a-reason — stop after a service restart (once).
        if (!restoredInProgress) {
            restoredInProgress = true
            if (s.inProgress.isNotBlank()) {
                val saved = runCatching {
                    StopTrackJson.decodeFromString(TimerState.serializer(), s.inProgress)
                }.getOrNull()
                controller.restore(saved)
            }
            if (s.pendingStop.isNotBlank()) {
                val saved = runCatching {
                    StopTrackJson.decodeFromString(FinishedStop.serializer(), s.pendingStop)
                }.getOrNull()
                controller.restorePending(saved)
            }
        }

        applyOverlay(s)
        onTimerChanged()
    }

    /** Show/hide the floating bubble to match the toggle + overlay permission. */
    private fun applyOverlay(s: Settings) {
        val canDraw = android.provider.Settings.canDrawOverlays(this)
        if (s.overlayEnabled && canDraw) {
            if (overlay == null) overlay = OverlayController(this, controller, prefs, lifecycleScope)
            if (overlay?.isShowing != true) overlay?.show(s.overlayX, s.overlayY)
        } else {
            overlay?.hide()
        }
    }

    /** Timer transitioned or ticked: refresh the notification + bubble, and run a
     *  1-second tick only while a stop is active. */
    private fun onTimerChanged() {
        updateNotification()
        overlay?.update(controller.state)
        if (controller.state.active) {
            if (tickJob == null) {
                tickJob = lifecycleScope.launch {
                    while (isActive && controller.state.active) {
                        updateNotification()
                        overlay?.update(controller.state)
                        delay(1000)
                    }
                    tickJob = null
                }
            }
        } else {
            tickJob?.cancel(); tickJob = null
        }
    }

    private fun restartServer(port: Int, token: String?) {
        runCatching { server?.stop() }
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

    /** Bring the app forward so its reason picker can document a just-ended stop
     *  (End can be tapped from the notification/bubble while the app is closed). */
    private fun openApp() {
        runCatching {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
            )
        }
    }

    private fun startInForeground(text: String) {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        // Never let a foreground-start refusal crash the app; the UI must still open.
        runCatching { ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(text), type) }
    }

    private fun updateNotification() {
        val mgr = getSystemService(NotificationManager::class.java)
        mgr.notify(NOTIF_ID, buildNotification(bridgeStatusLine()))
    }

    private fun bridgeStatusLine(): String {
        val running = server != null
        return buildString {
            append(if (running) "Bridge on :$serverPort" else "Local server stopped")
            append(" · ${store.count(com.stoptrack.shared.Collection.STOPS)} stops")
            if (current.forwardEnabled) append(" · forwarding")
        }
    }

    private fun timerLine(): String {
        val st = controller.state
        val now = System.currentTimeMillis()
        return when {
            controller.pending != null -> "Stop ended — tap to add a reason"
            st.paused -> "Paused ${fmtElapsed(st.elapsed(now))} · ${st.machine}"
            st.running -> "Recording ${fmtElapsed(st.elapsed(now))} · ${st.machine}"
            else -> "Idle · tap Start to log a stop"
        }
    }

    private fun buildNotification(bridgeLine: String): Notification {
        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val timer = timerLine()
        val b = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("StopTrack")
            .setContentText(timer)
            .setStyle(NotificationCompat.BigTextStyle().bigText("$timer\n$bridgeLine"))
            .setSmallIcon(R.drawable.ic_stat_stoptrack)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setContentIntent(openApp)
            .setPriority(NotificationCompat.PRIORITY_LOW)

        // Timer actions. While a stop awaits a reason, offer none — tapping the
        // notification opens the app's reason picker.
        val st = controller.state
        when {
            controller.pending != null -> { /* tap opens the app to add a reason */ }
            st.running -> {
                b.addAction(0, "Pause", actionPI(ACTION_PAUSE, 12))
                b.addAction(0, "End", actionPI(ACTION_END, 13))
            }
            st.paused -> {
                b.addAction(0, "Resume", actionPI(ACTION_RESUME, 14))
                b.addAction(0, "End", actionPI(ACTION_END, 13))
            }
            else -> b.addAction(0, "Start stop", actionPI(ACTION_START, 11))
        }
        return b.build()
    }

    private fun actionPI(action: String, req: Int): PendingIntent = PendingIntent.getService(
        this, req, Intent(this, CompanionService::class.java).setAction(action),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun fmtElapsed(ms: Long): String {
        val s = ms / 1000
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, getString(R.string.bridge_channel_name), NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Keeps the StopTrack bridge running and shows the stop timer." }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        runCatching { server?.stop() }
        forwardJob?.cancel()
        tickJob?.cancel()
        overlay?.hide()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "stoptrack_bridge"
        private const val NOTIF_ID = 1001
        private const val FORWARD_INTERVAL_MS = 25_000L
        private const val NanoHttpTimeoutMs = 5000

        const val ACTION_START = "com.stoptrack.mobile.START"
        const val ACTION_PAUSE = "com.stoptrack.mobile.PAUSE"
        const val ACTION_RESUME = "com.stoptrack.mobile.RESUME"
        const val ACTION_END = "com.stoptrack.mobile.END"
        const val ACTION_DOCUMENT = "com.stoptrack.mobile.DOCUMENT"
        const val ACTION_DISCARD = "com.stoptrack.mobile.DISCARD"
        const val ACTION_REFRESH_OVERLAY = "com.stoptrack.mobile.REFRESH_OVERLAY"
        const val EXTRA_MACHINE = "machine"
        const val EXTRA_REASON = "reason"
        const val EXTRA_NOTES = "notes"
        const val EXTRA_OPERATOR = "operator"

        fun start(context: android.content.Context) {
            val intent = Intent(context, CompanionService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
        }
    }
}
