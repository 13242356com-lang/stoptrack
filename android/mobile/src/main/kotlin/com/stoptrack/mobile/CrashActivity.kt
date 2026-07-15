package com.stoptrack.mobile

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

/**
 * Plain-view (no Compose) screen that prints a crash's stack trace so a
 * non-technical user can screenshot and send it. Runs in its own `:crash`
 * process (see manifest) so it survives the crashing one.
 */
class CrashActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val trace = intent.getStringExtra(EXTRA_TRACE) ?: "No details captured."
        val text = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setTextIsSelectable(true)
            setTextColor(Color.WHITE)
            setPadding(32, 56, 32, 56)
            text = "StopTrack Companion stopped.\n\nPlease screenshot this and send it:\n\n$trace"
        }
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#7F1D1D")) // red-900
            addView(text)
        }
        setContentView(scroll)
    }

    companion object {
        const val EXTRA_TRACE = "trace"
    }
}
