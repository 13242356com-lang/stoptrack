package com.stoptrack.wear

import android.app.Application
import android.content.Intent
import java.io.PrintWriter
import java.io.StringWriter
import kotlin.system.exitProcess

/**
 * Installs a last-resort crash handler so a startup failure shows the error on
 * screen (via [CrashActivity]) instead of vanishing — the watch equivalent of the
 * web app's error overlay.
 */
class WearApp : Application() {

    override fun onCreate() {
        super.onCreate()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                val sw = StringWriter()
                error.printStackTrace(PrintWriter(sw))
                startActivity(
                    Intent(this, CrashActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                        .putExtra(CrashActivity.EXTRA_TRACE, sw.toString()),
                )
            }
            runCatching { previous?.uncaughtException(thread, error) }
            exitProcess(10)
        }
    }
}
