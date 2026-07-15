package com.stoptrack.mobile

import android.content.Context
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import com.stoptrack.shared.WearProtocol
import kotlinx.coroutines.tasks.await

/**
 * The phone side of the Data Layer link. Publishes config to the watch and acks
 * stored stops so the watch can clear its outbox.
 */
class PhoneWearBridge(context: Context) {

    private val dataClient = Wearable.getDataClient(context)
    private val messageClient = Wearable.getMessageClient(context)
    private val nodeClient = Wearable.getNodeClient(context)

    /**
     * Publish the watch config as a DataItem. Bumping the timestamp guarantees the
     * item changes each time so the watch's onDataChanged always fires.
     */
    suspend fun publishConfig(configJson: String) {
        val request = PutDataMapRequest.create(WearProtocol.PATH_CONFIG).apply {
            dataMap.putString(WearProtocol.KEY_CONFIG_JSON, configJson)
            dataMap.putLong(WearProtocol.KEY_CONFIG_AT, System.currentTimeMillis())
        }.asPutDataRequest().setUrgent()
        runCatching { dataClient.putDataItem(request).await() }
    }

    /** Tell a specific watch node that [stopId] is stored (clears its outbox entry). */
    suspend fun ackStop(nodeId: String, stopId: String) {
        runCatching {
            messageClient.sendMessage(nodeId, WearProtocol.PATH_STOP_ACK, stopId.toByteArray(Charsets.UTF_8)).await()
        }
    }

    suspend fun connectedWatchCount(): Int =
        runCatching { nodeClient.connectedNodes.await().size }.getOrDefault(0)
}
