package com.stoptrack.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.stoptrack.mobile.CompanionUi
import com.stoptrack.mobile.CompanionViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompanionScreen(vm: CompanionViewModel) {
    val ui by vm.ui.collectAsState()

    Scaffold(topBar = { TopAppBar(title = { Text("Watch bridge settings") }) }) { pad ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(pad)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "The StopTrack app and the watch already work together with no setup. " +
                    "These are just the plumbing — you rarely need to change anything here.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            StatusCard(ui)
            LocalServerCard(ui, vm)
            WatchCard(ui, vm)
            RemoteForwardCard(ui, vm)
        }
    }
}

/** Fallback screen if the app can't create its WebView (very rare). */
@Composable
fun StartupError(error: Throwable) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("StopTrack couldn't start", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text(
            "Please screenshot this and send it:",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            (error.message ?: error.javaClass.simpleName) + "\n\n" + error.stackTraceToString(),
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun StatusCard(ui: CompanionUi) = SectionCard("Bridge status") {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Metric("Watches linked", ui.connectedWatches.toString())
        Metric("Stops stored", ui.storedStops.toString())
    }
}


@Composable
private fun LocalServerCard(ui: CompanionUi, vm: CompanionViewModel) = SectionCard("Local server") {
    var port by remember { mutableStateOf(ui.settings.localPort.toString()) }
    var token by remember { mutableStateOf(ui.settings.localToken) }
    LaunchedEffect(ui.settings.localPort) { port = ui.settings.localPort.toString() }
    LaunchedEffect(ui.settings.localToken) { token = ui.settings.localToken }

    OutlinedTextField(
        value = port,
        onValueChange = { port = it.filter(Char::isDigit).take(5) },
        label = { Text("Port") },
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number),
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = token,
        onValueChange = { token = it },
        label = { Text("Token (optional — leave blank on this phone)") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(8.dp))
    Button(
        onClick = {
            port.toIntOrNull()?.let { vm.setLocalPort(it) }
            vm.setLocalToken(token)
        },
        modifier = Modifier.fillMaxWidth(),
    ) { Text("Save & restart server") }
}

@Composable
private fun WatchCard(ui: CompanionUi, vm: CompanionViewModel) = SectionCard("Watch") {
    Text(
        if (ui.connectedWatches > 0) "${ui.connectedWatches} watch(es) connected"
        else "No watch connected — open StopTrack on the watch",
        style = MaterialTheme.typography.bodyMedium,
    )
    Spacer(Modifier.height(8.dp))
    OutlinedButton(onClick = { vm.pushConfigToWatch() }, modifier = Modifier.fillMaxWidth()) {
        Text("Send machines & reasons to watch")
    }
}

@Composable
private fun RemoteForwardCard(ui: CompanionUi, vm: CompanionViewModel) = SectionCard("Remote server (optional)") {
    var url by remember { mutableStateOf(ui.settings.remoteUrl) }
    var token by remember { mutableStateOf(ui.settings.remoteToken) }
    LaunchedEffect(ui.settings.remoteUrl) { url = ui.settings.remoteUrl }
    LaunchedEffect(ui.settings.remoteToken) { token = ui.settings.remoteToken }

    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Text("Forward to a shared server", style = MaterialTheme.typography.bodyMedium)
        Switch(checked = ui.settings.forwardEnabled, onCheckedChange = { vm.setForwardEnabled(it) })
    }
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = url,
        onValueChange = { url = it },
        label = { Text("Server URL") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = token,
        onValueChange = { token = it },
        label = { Text("Factory token") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { vm.setRemoteUrl(url); vm.setRemoteToken(token) }) { Text("Save") }
        OutlinedButton(onClick = { vm.setRemoteUrl(url); vm.setRemoteToken(token); vm.testRemote() }, enabled = !ui.testing) {
            Text(if (ui.testing) "Testing…" else "Test connection")
        }
    }
    ui.testResult?.let {
        Spacer(Modifier.height(6.dp))
        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
    }
}

/* --------------------------------------------------------------- helpers ---- */

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            content()
        }
    }
}

@Composable
private fun Metric(label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
