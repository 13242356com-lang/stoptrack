package com.stoptrack.mobile

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import com.stoptrack.mobile.ui.CompanionScreen
import com.stoptrack.mobile.ui.CompanionTheme

/**
 * The companion's single screen. Its real work happens in [CompanionService]
 * (started here); this activity just configures settings and shows status.
 */
class MainActivity : ComponentActivity() {

    private val vm: CompanionViewModel by viewModels()

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best-effort */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Notification permission is required to show the foreground-service notice.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        // Kick the bridge on launch; it is START_STICKY so it stays up afterwards.
        CompanionService.start(this)

        setContent {
            CompanionTheme {
                CompanionScreen(vm)
            }
        }
    }
}
