package com.stoptrack.wear

/** `fmtClock` — HH:MM:SS, the big running readout (ported from the web app). */
fun fmtClock(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return "%02d:%02d:%02d".format(h, m, sec)
}

/** `fmtDur` — compact "1h 2m 3s" downtime label (ported from the web app). */
fun fmtDur(ms: Long): String {
    val s = ms / 1000
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    val hPart = if (h > 0) "${h}h " else ""
    val mPart = if (m > 0 || h > 0) "${m}m " else ""
    return "$hPart$mPart${sec}s"
}
