package com.stoptrack.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import com.stoptrack.wear.ui.StopTrackWearTheme
import com.stoptrack.wear.ui.WatchApp

/**
 * The single Wear OS activity. All UI is Compose; state lives in
 * [OperatorViewModel]. There is no navigation graph — the operator flow is a
 * small state machine ([Phase]) rendered by [WatchApp].
 */
class MainActivity : ComponentActivity() {

    private val vm: OperatorViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            StopTrackWearTheme {
                WatchApp(vm)
            }
        }
    }
}
