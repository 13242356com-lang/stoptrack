package com.stoptrack.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import com.stoptrack.shared.TimerState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.hypot

/**
 * The floating "Shazam-style" bubble: a small draggable button that hovers over
 * other apps and reflects/controls the native quick-stop timer. Tap toggles
 * Start ↔ End; drag repositions it (position persists). Uses a plain View (not
 * Compose) to avoid overlay lifecycle-owner plumbing. Requires the
 * SYSTEM_ALERT_WINDOW permission — the caller must check `canDrawOverlays` first.
 */
class OverlayController(
    private val context: Context,
    private val controller: QuickStopController,
    private val prefs: Prefs,
    private val scope: CoroutineScope,
) {
    private val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private var bubble: TextView? = null

    val isShowing get() = bubble != null

    @SuppressLint("ClickableViewAccessibility")
    fun show(startX: Int, startY: Int) {
        if (bubble != null) return
        val dp = context.resources.displayMetrics.density
        val size = (56 * dp).toInt()

        val view = TextView(context).apply {
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(0, 0, 0, 0)
            minWidth = size
            minHeight = size
        }

        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            android.graphics.PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = startX
            y = startY
        }

        // Tap vs drag: a small movement is a tap (toggle); a larger one repositions.
        view.setOnTouchListener(object : View.OnTouchListener {
            private var downX = 0f; private var downY = 0f
            private var startPx = 0; private var startPy = 0
            private var dragging = false
            private val touchSlop = 12 * dp

            override fun onTouch(v: View, e: MotionEvent): Boolean {
                when (e.action) {
                    MotionEvent.ACTION_DOWN -> {
                        downX = e.rawX; downY = e.rawY
                        startPx = lp.x; startPy = lp.y; dragging = false
                        return true
                    }
                    MotionEvent.ACTION_MOVE -> {
                        val dx = e.rawX - downX; val dy = e.rawY - downY
                        if (!dragging && hypot(dx, dy) > touchSlop) dragging = true
                        if (dragging) {
                            lp.x = startPx + dx.toInt()
                            lp.y = startPy + dy.toInt()
                            runCatching { windowManager.updateViewLayout(v, lp) }
                        }
                        return true
                    }
                    MotionEvent.ACTION_UP -> {
                        if (dragging) {
                            scope.launch { prefs.update(overlayX = lp.x, overlayY = lp.y) }
                        } else if (abs(e.rawX - downX) < touchSlop && abs(e.rawY - downY) < touchSlop) {
                            controller.toggle()
                        }
                        return true
                    }
                }
                return false
            }
        })

        bubble = view
        runCatching { windowManager.addView(view, lp) }
        update(controller.state)
    }

    /** Repaint the bubble for the current timer state (called on the 1s tick). */
    fun update(state: TimerState) {
        val v = bubble ?: return
        val running = state.running && !state.paused
        val bg = when {
            state.paused -> 0xFFF59E0B.toInt()   // amber
            running -> 0xFFEF4444.toInt()          // red (recording)
            else -> 0xFF10B981.toInt()             // emerald (idle → tap to start)
        }
        v.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(bg)
        }
        v.text = if (state.active) fmt(state.elapsed(System.currentTimeMillis())) else "STOP"
    }

    fun hide() {
        val v = bubble ?: return
        runCatching { windowManager.removeView(v) }
        bubble = null
        params = null
    }

    private fun overlayType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

    private fun fmt(ms: Long): String {
        val s = ms / 1000
        return "%d:%02d".format(s / 60, s % 60)
    }
}
