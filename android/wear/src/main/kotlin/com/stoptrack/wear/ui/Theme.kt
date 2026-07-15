package com.stoptrack.wear.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme

/** StopTrack accent palette, matching the web app (emerald on near-black). */
private val StopTrackColors = Colors(
    primary = Color(0xFF10B981),        // emerald-500
    primaryVariant = Color(0xFF059669), // emerald-600
    secondary = Color(0xFF38BDF8),      // sky-400
    secondaryVariant = Color(0xFF0EA5E9),
    background = Color(0xFF000000),
    surface = Color(0xFF0F172A),        // slate-900
    error = Color(0xFFEF4444),          // red-500
    onPrimary = Color(0xFF06251B),
    onSecondary = Color(0xFF04212E),
    onBackground = Color(0xFFF1F5F9),
    onSurface = Color(0xFFF1F5F9),
    onError = Color(0xFF3B0A0A),
)

@Composable
fun StopTrackWearTheme(content: @Composable () -> Unit) {
    MaterialTheme(colors = StopTrackColors, content = content)
}
