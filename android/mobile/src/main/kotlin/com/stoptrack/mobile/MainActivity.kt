package com.stoptrack.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import com.stoptrack.mobile.ui.CompanionTheme
import com.stoptrack.mobile.ui.StartupError
import kotlinx.coroutines.launch

/**
 * The full StopTrack phone app. It shows the entire web app (operator +
 * supervisor + analytics + exports) inside a WebView, and the built-in bridge
 * ([CompanionService]) links it to the watch. The web UI auto-connects to the
 * bridge's local server via the injected [NativeBridge] — no manual setup.
 */
class MainActivity : ComponentActivity() {

    private var webView: WebView? = null

    /** Current local-server port, kept live so the JS bridge hands the web app the
     *  right URL even if the port is changed in Bridge settings. */
    @Volatile
    private var syncPort: Int = Settings.DEFAULT_PORT

    /** Last native timer/pending state pushed to the WebView, kept so a freshly
     *  loaded page can pull the current state on demand (`requestState`). */
    @Volatile
    private var lastStatePayload: String = """{"timer":null,"pending":null}"""

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best-effort */ }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        // Start (and keep alive) the bridge that serves the local sync API + links
        // the watch. Guarded so a service hiccup can't stop the UI opening.
        runCatching { CompanionService.start(this) }

        // Keep the port the JS bridge reports in step with settings, and mirror the
        // native timer/pending state into the WebView on every change (the native
        // quick-stop timer is the single source of truth; the web UI is a view).
        lifecycleScope.launch {
            Prefs(applicationContext).settings.collect { s ->
                syncPort = s.localPort
                val timer = s.inProgress.ifBlank { "null" }
                val pending = s.pendingStop.ifBlank { "null" }
                val payload = "{\"timer\":$timer,\"pending\":$pending}"
                lastStatePayload = payload
                pushState(payload)
            }
        }

        val web = try {
            buildWebView()
        } catch (e: Throwable) {
            // If the WebView itself can't be created (rare), show a readable error
            // instead of a blank screen.
            setContent { CompanionTheme { StartupError(e) } }
            return
        }
        webView = web
        setContentView(web)
        web.loadUrl(ASSET_URL)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val wv = webView
                if (wv != null && wv.canGoBack()) wv.goBack() else finish()
            }
        })
    }

    private fun buildWebView(): WebView = WebView(this).apply {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // the web app's localStorage store
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            cacheMode = WebSettings.LOAD_DEFAULT
            // The app is loaded from file:// but talks to http://127.0.0.1 (the
            // in-app bridge), so allow that cross-origin + cleartext-to-loopback.
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        webViewClient = WebViewClient()
        addJavascriptInterface(NativeBridge(), "StopTrackNative")
    }

    override fun onDestroy() {
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    /** Deliver native timer/pending state to the web app's shell hook. */
    private fun pushState(payload: String) {
        runOnUiThread {
            runCatching {
                webView?.evaluateJavascript(
                    "window.StopTrackShell && window.StopTrackShell.onState($payload);", null,
                )
            }
        }
    }

    /** Fire a command to the always-on service (which owns the timer). */
    private fun fire(action: String, extras: (Intent) -> Unit = {}) {
        runCatching {
            startService(
                Intent(this, CompanionService::class.java).setAction(action).also(extras),
            )
        }
    }

    /**
     * Exposed to the web app as `window.StopTrackNative`. Two-way: the timer
     * controls (start/pause/resume/end/document/discard) drive the native
     * quick-stop timer, and [requestState] pulls the current state so the WebView
     * mirrors it. The native timer stays the single source of truth.
     */
    private inner class NativeBridge {
        /** Tells the web app where the built-in bridge's sync server is. */
        @JavascriptInterface
        fun syncUrl(): String = "http://127.0.0.1:$syncPort"

        /** Loopback needs no token. */
        @JavascriptInterface
        fun token(): String = ""

        /** Push the current native timer/pending state to the just-registered shell. */
        @JavascriptInterface
        fun requestState() = pushState(lastStatePayload)

        @JavascriptInterface
        fun startStop(machine: String?) =
            fire(CompanionService.ACTION_START) { it.putExtra(CompanionService.EXTRA_MACHINE, machine ?: "") }

        @JavascriptInterface
        fun pauseStop() = fire(CompanionService.ACTION_PAUSE)

        @JavascriptInterface
        fun resumeStop() = fire(CompanionService.ACTION_RESUME)

        @JavascriptInterface
        fun endStop() = fire(CompanionService.ACTION_END)

        @JavascriptInterface
        fun documentStop(reason: String?, notes: String?) =
            fire(CompanionService.ACTION_DOCUMENT) {
                it.putExtra(CompanionService.EXTRA_REASON, reason ?: "")
                it.putExtra(CompanionService.EXTRA_NOTES, notes ?: "")
            }

        @JavascriptInterface
        fun discardStop() = fire(CompanionService.ACTION_DISCARD)
    }

    private companion object {
        const val ASSET_URL = "file:///android_asset/index.html"
    }
}
