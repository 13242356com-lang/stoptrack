package com.stoptrack.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
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

    /** Pending `<input type=file>` callback (Restore-from-backup picker), fed by
     *  [fileChooserLauncher]. */
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    /** System document picker for the web app's file inputs (Restore from backup).
     *  A WebView shows no picker without a WebChromeClient wired to one. */
    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            fileChooserCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
            fileChooserCallback = null
        }

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
        // Without a WebChromeClient the web app's <input type=file> (Restore from
        // backup) opens nothing — route it to the system document picker.
        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null) // cancel any earlier request
                fileChooserCallback = filePathCallback
                return try {
                    fileChooserLauncher.launch("*/*")
                    true
                } catch (e: Exception) {
                    fileChooserCallback = null
                    false
                }
            }
        }
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

    /**
     * Write [content] to the device's Downloads. API 29+ uses MediaStore (no
     * permission, lands in the shared Downloads folder); older devices fall back
     * to the app's external Downloads dir. Returns a human-readable location, or
     * null on failure.
     */
    private fun writeToDownloads(filename: String, mimeType: String, content: String): String? {
        val bytes = content.toByteArray(Charsets.UTF_8)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, filename)
                put(MediaStore.Downloads.MIME_TYPE, mimeType)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return null
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return "Downloads/$filename"
        }
        val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
        val file = java.io.File(dir, filename)
        file.outputStream().use { it.write(bytes) }
        return file.absolutePath
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

        /** Save a file (backup / CSV / JSON export) to the Downloads folder. A blob
         *  download from the WebView is silently dropped, so the web app hands the
         *  bytes here instead. */
        @JavascriptInterface
        fun saveFile(filename: String, mimeType: String?, content: String) {
            val loc = runCatching {
                writeToDownloads(filename, mimeType?.ifBlank { null } ?: "application/octet-stream", content)
            }.getOrNull()
            runOnUiThread {
                Toast.makeText(
                    this@MainActivity,
                    if (loc != null) "Saved: $loc" else "Couldn't save $filename",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }

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
