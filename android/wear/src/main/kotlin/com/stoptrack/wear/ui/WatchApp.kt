package com.stoptrack.wear.ui

import android.app.RemoteInput
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CompactChip
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import androidx.wear.input.RemoteInputIntentHelper
import com.stoptrack.wear.OperatorViewModel
import com.stoptrack.wear.Phase
import com.stoptrack.wear.WatchUiState
import com.stoptrack.wear.fmtClock
import com.stoptrack.wear.fmtDur

/** Root: renders the current [Phase] and wraps every screen in the Wear scaffold. */
@Composable
fun WatchApp(vm: OperatorViewModel) {
    val ui by vm.ui.collectAsState()
    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
    ) {
        when (ui.phase) {
            Phase.IDLE -> IdleScreen(ui, vm)
            Phase.RUNNING, Phase.PAUSED -> TimerScreen(ui, vm)
            Phase.DOCUMENTING -> DocumentScreen(ui, vm)
            Phase.SAVED -> SavedScreen(ui)
        }
    }
}

/* ------------------------------------------------------------------ IDLE ---- */

@Composable
private fun IdleScreen(ui: WatchUiState, vm: OperatorViewModel) {
    val listState = rememberScalingLazyListState()
    val setOperator = rememberTextInput(label = "Operator name") { vm.setOperator(it) }

    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize(),
        state = listState,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item { ScreenTitle("StopTrack") }

        // Machine picker (required before a stop can start).
        item { SectionLabel(if (ui.machine.isBlank()) "Pick a machine" else "Machine · ${ui.machine}") }
        items(ui.config.machines) { machine ->
            val selected = machine == ui.machine
            CompactChip(
                modifier = Modifier.fillMaxWidth(),
                onClick = { vm.setMachine(machine) },
                colors = if (selected) ChipDefaults.primaryChipColors() else ChipDefaults.secondaryChipColors(),
                label = { Text(machine) },
            )
        }

        item { Spacer(Modifier.height(4.dp)) }

        // Operator name (optional; defaults to "Unnamed").
        item {
            Chip(
                modifier = Modifier.fillMaxWidth(),
                onClick = setOperator,
                colors = ChipDefaults.secondaryChipColors(),
                label = { Text("Operator") },
                secondaryLabel = { Text(ui.operator.ifBlank { "Unnamed — tap to set" }) },
            )
        }

        // Start — the primary action.
        item {
            Chip(
                modifier = Modifier.fillMaxWidth(),
                onClick = { vm.onStart() },
                enabled = !ui.needsSetup,
                colors = ChipDefaults.primaryChipColors(),
                label = { Text("Start stop", fontWeight = FontWeight.Bold) },
            )
        }

        item { SyncFooter(ui, onRetry = { vm.retrySyncNow() }) }
    }
}

/* ----------------------------------------------------------------- TIMER ---- */

@Composable
private fun TimerScreen(ui: WatchUiState, vm: OperatorViewModel) {
    val paused = ui.phase == Phase.PAUSED
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = ui.machine.ifBlank { "—" },
            style = MaterialTheme.typography.caption1,
            color = MaterialTheme.colors.onBackground,
            maxLines = 1,
        )
        Spacer(Modifier.height(2.dp))
        Text(
            text = fmtClock(ui.elapsedMs),
            fontFamily = FontFamily.Monospace,
            fontSize = 30.sp,
            fontWeight = FontWeight.Bold,
            color = if (paused) MaterialTheme.colors.secondary else MaterialTheme.colors.primary,
        )
        if (paused) {
            Text("Paused", style = MaterialTheme.typography.caption2, color = MaterialTheme.colors.secondary)
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = { if (paused) vm.onResume() else vm.onPause() },
                colors = ButtonDefaults.secondaryButtonColors(),
            ) {
                Text(if (paused) "▶" else "❚❚")
            }
            Button(
                onClick = { vm.onEnd() },
                colors = ButtonDefaults.buttonColors(backgroundColor = MaterialTheme.colors.error),
            ) {
                Text("End")
            }
        }
    }
}

/* ------------------------------------------------------------- DOCUMENT ---- */

@Composable
private fun DocumentScreen(ui: WatchUiState, vm: OperatorViewModel) {
    val listState = rememberScalingLazyListState()
    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize(),
        state = listState,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item { ScreenTitle("Why stopped?") }
        item {
            Text(
                text = "Downtime ${fmtDur(ui.pendingStop?.durationMs ?: ui.elapsedMs)}",
                style = MaterialTheme.typography.caption1,
                color = MaterialTheme.colors.primary,
                textAlign = TextAlign.Center,
            )
        }

        if (ui.config.quickStops.isNotEmpty()) {
            item { SectionLabel("Quick stops") }
            items(ui.config.quickStops) { q ->
                Chip(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { vm.onQuickStop(q) },
                    colors = ChipDefaults.secondaryChipColors(),
                    label = { Text(q.label) },
                    secondaryLabel = if (q.reason != q.label) ({ Text(q.reason) }) else null,
                )
            }
        }

        item { SectionLabel("All reasons") }
        items(ui.config.reasons) { reason ->
            CompactChip(
                modifier = Modifier.fillMaxWidth(),
                onClick = {
                    vm.selectReason(reason)
                    vm.onSaveSelected()
                },
                colors = ChipDefaults.primaryChipColors(),
                label = { Text(reason) },
            )
        }

        item { Spacer(Modifier.height(4.dp)) }
        item {
            CompactChip(
                modifier = Modifier.fillMaxWidth(),
                onClick = { vm.onDiscardPending() },
                colors = ChipDefaults.secondaryChipColors(),
                label = { Text("Discard") },
            )
        }
    }
}

/* ---------------------------------------------------------------- SAVED ---- */

@Composable
private fun SavedScreen(ui: WatchUiState) {
    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("✓", fontSize = 40.sp, color = MaterialTheme.colors.primary)
        Spacer(Modifier.height(4.dp))
        Text("Stop saved", style = MaterialTheme.typography.title3, fontWeight = FontWeight.Bold)
        ui.lastSavedReason?.let {
            Text(it, style = MaterialTheme.typography.caption1, color = MaterialTheme.colors.onBackground)
        }
        if (!ui.phoneReachable) {
            Spacer(Modifier.height(4.dp))
            Text(
                "Phone offline — will send when connected",
                style = MaterialTheme.typography.caption2,
                color = MaterialTheme.colors.secondary,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/* -------------------------------------------------------------- shared ----- */

@Composable
private fun ScreenTitle(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.title3,
        fontWeight = FontWeight.Bold,
        textAlign = TextAlign.Center,
        modifier = Modifier.padding(bottom = 2.dp),
    )
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.caption2,
        color = MaterialTheme.colors.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 2.dp),
        textAlign = TextAlign.Center,
    )
}

/** One-line watch<->phone status, plus queued (unsent) stop count and a retry tap. */
@Composable
private fun SyncFooter(ui: WatchUiState, onRetry: () -> Unit) {
    val text = when {
        !ui.phoneReachable && ui.outboxCount > 0 -> "Phone offline · ${ui.outboxCount} waiting"
        !ui.phoneReachable -> "Phone offline"
        ui.outboxCount > 0 -> "Sending ${ui.outboxCount}…"
        else -> "Linked to phone"
    }
    CompactChip(
        modifier = Modifier.fillMaxWidth(),
        onClick = onRetry,
        colors = ChipDefaults.secondaryChipColors(),
        label = {
            Text(
                text,
                style = MaterialTheme.typography.caption2,
                color = if (ui.phoneReachable) MaterialTheme.colors.primary else MaterialTheme.colors.secondary,
            )
        },
    )
}

/**
 * Wear text input (voice or on-watch keyboard) via RemoteInput. Returns a lambda
 * to launch it; the result is delivered to [onText].
 */
@Composable
private fun rememberTextInput(label: String, onText: (String) -> Unit): () -> Unit {
    val key = "st_text"
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data ?: return@rememberLauncherForActivityResult
        val text = RemoteInput.getResultsFromIntent(data)?.getCharSequence(key)?.toString()
        if (!text.isNullOrBlank()) onText(text.trim())
    }
    return {
        val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
        val inputs = listOf(RemoteInput.Builder(key).setLabel(label).build())
        RemoteInputIntentHelper.putRemoteInputsExtra(intent, inputs)
        launcher.launch(intent)
    }
}
