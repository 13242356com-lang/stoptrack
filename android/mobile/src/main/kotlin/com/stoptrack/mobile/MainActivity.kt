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

        // Keep the port the JS bridge reports in step with settings.
        lifecycleScope.launch {
            Prefs(applicationContext).settings.collect { syncPort = it.localPort }
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

    /** Exposed to the web app as `window.StopTrackNative`. */
    private inner class NativeBridge {
        /** Tells the web app where the built-in bridge's sync server is. */
        @JavascriptInterface
        fun syncUrl(): String = "http://127.0.0.1:$syncPort"

        /** Loopback needs no token. */
        @JavascriptInterface
        fun token(): String = ""

        /** The web app reports when its own stop-timer is running/paused, so the
         *  native notification + floating bubble suppress their Start and can't
         *  double-count the same stop. */
        @JavascriptInterface
        fun reportTimerActive(active: Boolean) {
            runCatching {
                startService(
                    Intent(this@MainActivity, CompanionService::class.java)
                        .setAction(CompanionService.ACTION_WEB_TIMER)
                        .putExtra(CompanionService.EXTRA_ACTIVE, active),
                )
            }
        }
    }

    private companion object {
        const val ASSET_URL = "file:///android_asset/index.html"
    }
}
