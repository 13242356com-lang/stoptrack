package com.stoptrack.shared

/**
 * The watch <-> phone Data Layer protocol. This is the offline, server-free link:
 * the watch never talks to a network, it only exchanges these messages with the
 * paired phone over the Wear Data Layer (Bluetooth / local Wi-Fi).
 *
 * Paths are Data Layer "message"/"data-item" paths and MUST start with "/".
 */
object WearProtocol {
    /** Watch -> phone: a finished [StopRecord], JSON-encoded, sent via MessageClient. */
    const val PATH_STOP = "/stoptrack/stop"

    /** Watch -> phone: request the phone to (re)send the current config now. */
    const val PATH_REQUEST_CONFIG = "/stoptrack/request-config"

    /**
     * Phone -> watch: the current [WatchConfig], published as a DataItem so the
     * watch always has the latest even if it was asleep when it changed.
     */
    const val PATH_CONFIG = "/stoptrack/config"

    /**
     * Phone -> watch: an ack that a stop was received and stored, so the watch can
     * clear it from its outbox. MessageClient path; body is the stop id (UTF-8).
     */
    const val PATH_STOP_ACK = "/stoptrack/stop-ack"

    /** DataItem key holding the config JSON string under [PATH_CONFIG]. */
    const val KEY_CONFIG_JSON = "config_json"

    /** DataItem key holding the epoch-ms the config was published (for freshness). */
    const val KEY_CONFIG_AT = "config_at"

    /** Capability advertised by the phone companion so the watch can find it. */
    const val CAPABILITY_PHONE_APP = "stoptrack_phone_companion"
}
