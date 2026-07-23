package com.stoptrack.mobile

import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Emulator boot/smoke test — the check the cloud session can't do by hand.
 * Launches the real [MainActivity] (WebView + foreground-service bridge) on an
 * emulator in CI and asserts it comes up and stays RESUMED. A crash on boot —
 * a foreground-service refusal, a WebView init failure, a bridge exception —
 * drops the activity out of RESUMED and fails this test. The functional stop-flow
 * behaviour is covered by the headless-browser test (test/web-e2e.mjs).
 */
@RunWith(AndroidJUnit4::class)
class SmokeTest {

    @Test
    fun appLaunchesAndStaysUp() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.moveToState(Lifecycle.State.RESUMED)
            // Give the WebView time to load the bundled index.html and the service
            // to start; a boot-time crash would surface within this window.
            Thread.sleep(8_000)
            var state: Lifecycle.State? = null
            scenario.onActivity { state = it.lifecycle.currentState }
            assertEquals("app should still be running after launch", Lifecycle.State.RESUMED, state)
        }
    }
}
