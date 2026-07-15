package com.stoptrack.mobile.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Emerald = Color(0xFF10B981)
private val EmeraldDark = Color(0xFF059669)

private val Dark = darkColorScheme(
    primary = Emerald,
    onPrimary = Color(0xFF04241A),
    secondary = Color(0xFF38BDF8),
    background = Color(0xFF0B1120),
    surface = Color(0xFF0F172A),
)

private val Light = lightColorScheme(
    primary = EmeraldDark,
    onPrimary = Color.White,
    secondary = Color(0xFF0EA5E9),
)

@Composable
fun CompanionTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) Dark else Light,
        content = content,
    )
}
