package com.stoptrack.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import com.stoptrack.mobile.ui.CompanionScreen
import com.stoptrack.mobile.ui.CompanionTheme

/**
 * Secondary screen for the watch bridge itself — local server port and the
 * optional remote-server forward. Reached from the persistent bridge
 * notification. The everyday app is the WebView in [MainActivity]; this is the
 * plumbing most operators never need to touch.
 */
class BridgeSettingsActivity : ComponentActivity() {

    private val vm: CompanionViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            CompanionTheme {
                CompanionScreen(vm)
            }
        }
    }
}
