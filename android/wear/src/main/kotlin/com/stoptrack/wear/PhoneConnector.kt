package com.stoptrack.wear

import android.content.Context
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import com.stoptrack.shared.StopRecord
import com.stoptrack.shared.WearProtocol
import com.stoptrack.shared.toJson
import kotlinx.coroutines.tasks.await

/**
 * The watch side of the offline watch<->phone link. Everything here goes over the
 * Wear Data Layer (Bluetooth / local Wi-Fi) — there is deliberately no network
 * code on the watch. If the phone is out of range, sends fail and the caller
 * keeps the stop in its outbox to retry.
 */
class PhoneConnector(context: Context) {

    private val messageClient = Wearable.getMessageClient(context)
    private val dataClient = Wearable.getDataClient(context)
    private val nodeClient = Wearable.getNodeClient(context)

    suspend fun isPhoneReachable(): Boolean =
        runCatching { nodeClient.connectedNodes.await().isNotEmpty() }.getOrDefault(false)

    /**
     * Send one finished stop to the phone. Returns true if at least one connected
     * node accepted the message. A true here means "delivered to the phone app's
     * Data Layer"; the phone still sends an explicit ack (PATH_STOP_ACK) once it
     * has persisted the record, which is what actually clears the outbox.
     */
    suspend fun sendStop(record: StopRecord): Boolean {
        val nodes = runCatching { nodeClient.connectedNodes.await() }.getOrDefault(emptyList())
        if (nodes.isEmpty()) return false
        val payload = record.toJson().toByteArray(Charsets.UTF_8)
        var delivered = false
        for (node in nodes) {
            val ok = runCatching {
                messageClient.sendMessage(node.id, WearProtocol.PATH_STOP, payload).await()
            }.isSuccess
            delivered = delivered || ok
        }
        return delivered
    }

    /** Ask the phone to (re)publish its current config. */
    suspend fun requestConfig() {
        val nodes = runCatching { nodeClient.connectedNodes.await() }.getOrDefault(emptyList())
        for (node in nodes) {
            runCatching {
                messageClient.sendMessage(node.id, WearProtocol.PATH_REQUEST_CONFIG, ByteArray(0)).await()
            }
        }
    }

    /**
     * Read the latest config the phone published as a DataItem. Useful on launch
     * in case the app missed the live onDataChanged callback.
     */
    suspend fun readLatestConfigJson(): String? {
        val buffer = runCatching { dataClient.dataItems.await() }.getOrNull() ?: return null
        try {
            for (item in buffer) {
                if (item.uri.path == WearProtocol.PATH_CONFIG) {
                    val map = DataMapItem.fromDataItem(item).dataMap
                    return map.getString(WearProtocol.KEY_CONFIG_JSON)
                }
            }
        } finally {
            buffer.release()
        }
        return null
    }
}
