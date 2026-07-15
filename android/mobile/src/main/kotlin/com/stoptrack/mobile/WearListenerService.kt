package com.stoptrack.mobile

import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import com.stoptrack.shared.Collection
import com.stoptrack.shared.StopTrackJson
import com.stoptrack.shared.WearProtocol
import com.stoptrack.shared.idOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject

/**
 * Receives everything the watch sends over the Data Layer:
 *  - a finished stop → store it locally and ack so the watch clears its outbox;
 *  - a config request → publish the current watch config back.
 *
 * The stored stop immediately becomes visible to the web app (via the local sync
 * server) with no server involved — that's the offline companion path working.
 */
class WearListenerService : WearableListenerService() {

    private val store by lazy { PhoneStore.get(applicationContext) }
    private val bridge by lazy { PhoneWearBridge(applicationContext) }

    override fun onMessageReceived(event: MessageEvent) {
        when (event.path) {
            WearProtocol.PATH_STOP -> handleStop(event)
            WearProtocol.PATH_REQUEST_CONFIG -> runBlocking { bridge.publishConfig(store.watchConfigJson()) }
        }
    }

    private fun handleStop(event: MessageEvent) {
        val text = String(event.data, Charsets.UTF_8)
        val record = runCatching { StopTrackJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        val id = idOf(record) ?: return
        store.upsertOne(Collection.STOPS, record)
        // Ack the originating watch so it drops the stop from its outbox.
        runBlocking { bridge.ackStop(event.sourceNodeId, id) }
    }
}
