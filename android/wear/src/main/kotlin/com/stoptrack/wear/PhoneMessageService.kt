package com.stoptrack.wear

import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import com.stoptrack.shared.WearProtocol
import kotlinx.coroutines.runBlocking

/**
 * Receives everything the phone pushes to the watch over the Data Layer and
 * funnels it into [WatchStore], which the UI observes. Callbacks run on a
 * background binder thread, so the short `runBlocking` writes are safe here.
 */
class PhoneMessageService : WearableListenerService() {

    private val store by lazy { WatchStore(applicationContext) }

    /** Phone published fresh config (machines / reasons / quick stops). */
    override fun onDataChanged(events: DataEventBuffer) {
        for (event in events) {
            if (event.type != DataEvent.TYPE_CHANGED) continue
            if (event.dataItem.uri.path != WearProtocol.PATH_CONFIG) continue
            val json = DataMapItem.fromDataItem(event.dataItem).dataMap
                .getString(WearProtocol.KEY_CONFIG_JSON) ?: continue
            runBlocking { store.setConfigJson(json) }
        }
    }

    /** Phone acked a stored stop → clear it from the outbox. */
    override fun onMessageReceived(event: MessageEvent) {
        if (event.path == WearProtocol.PATH_STOP_ACK) {
            val id = String(event.data, Charsets.UTF_8)
            if (id.isNotBlank()) runBlocking { store.removeFromOutbox(id) }
        }
    }
}
