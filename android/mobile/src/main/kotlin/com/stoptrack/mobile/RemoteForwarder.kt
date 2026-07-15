package com.stoptrack.mobile

import com.stoptrack.shared.Collection
import com.stoptrack.shared.RemoteSyncClient
import com.stoptrack.shared.stampOf

/**
 * The LAST-RESORT sync: pushes the phone's local data to a remote StopTrack
 * server and pulls back others' changes, last-write-wins. Entirely optional — the
 * watch<->phone companion works without it. Only runs when the supervisor enables
 * forwarding and sets a server URL. Blocking; call from an IO dispatcher.
 */
class RemoteForwarder(private val store: PhoneStore, private val prefs: Prefs) {

    /** One push+pull cycle. Best-effort: any failure leaves cursors untouched to retry. */
    suspend fun runOnce(settings: Settings): Boolean {
        if (!settings.forwardEnabled || settings.remoteUrl.isBlank()) return false
        val client = RemoteSyncClient(settings.remoteUrl, settings.remoteToken.ifBlank { null })
        if (!client.health().ok) return false

        // Push local deltas (records newer than the last push cursor).
        val pushCursor = prefs.pushCursor()
        var maxPushed = pushCursor
        for (collection in Collection.entries) {
            val changed = store.since(collection, pushCursor)
            if (changed.isNotEmpty() && client.push(collection, changed)) {
                for (r in changed) maxPushed = maxOf(maxPushed, stampOf(r))
            }
        }
        if (maxPushed > pushCursor) prefs.setPushCursor(maxPushed)

        // Pull remote deltas per collection.
        for (collection in Collection.entries) {
            val cursor = prefs.pullCursor(collection)
            val pull = client.pull(collection, cursor)
            if (pull.records.isNotEmpty()) store.upsert(collection, pull.records)
            if (pull.serverTime > cursor) prefs.setPullCursor(collection, pull.serverTime)
        }

        // Reconcile config both directions by updatedAt.
        val (localCfg, localAt) = store.getConfig()
        val (remoteCfg, remoteAt) = client.getConfig()
        if (remoteCfg != null && remoteAt > localAt) {
            store.putConfig(remoteCfg, remoteAt)
        } else if (localCfg != null && localAt > remoteAt) {
            client.putConfig(localCfg, localAt)
        }
        return true
    }
}
