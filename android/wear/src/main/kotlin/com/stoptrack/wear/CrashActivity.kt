package com.stoptrack.wear

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

/**
 * Plain-view crash screen for the watch. Small screen, but the trace is
 * scrollable and selectable so it can be screenshotted. Runs in its own `:crash`
 * process so it survives the crashing one.
 */
class CrashActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val trace = intent.getStringExtra(EXTRA_TRACE) ?: "No details captured."
        val text = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 9f
            setTextIsSelectable(true)
            setTextColor(Color.WHITE)
            setPadding(24, 24, 24, 24)
            text = "StopTrack crashed:\n\n$trace"
        }
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#7F1D1D"))
            addView(text)
        }
        setContentView(scroll)
    }

    companion object {
        const val EXTRA_TRACE = "trace"
    }
}
