import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Play, Square, Pause, Clock, Factory, AlertCircle, BarChart3, List, User,
  RefreshCw, Trash2, CheckCircle, Settings, Plus, X, Download, Search,
  Moon, Sun, TrendingUp, RotateCcw, Zap, Archive, Sparkles, Lock, Unlock, PencilLine, Target,
} from "lucide-react";

/* ============================================================================
   StopTrack — universal machine downtime tracker
   Single-file, offline-first. All persistence goes through the `api` object
   below so it can be swapped for a server backend with no UI changes.
   ========================================================================== */

// ---------- Defaults --------------------------------------------------------
// Generic example lists — StopTrack is universal, so defaults are neutral. A
// supervisor edits these to match any line/machine in Supervisor → Settings.
const DEFAULT_MACHINES = [
  "Line 1", "Line 2", "Line 3", "Packaging", "Assembly",
];
const DEFAULT_REASONS = [
  "Mechanical fault", "Quality check", "Waiting on maintenance", "Tooling change",
  "Cleaning", "Material shortage", "Changeover / Setup", "Material jam",
  "Operator break", "Electrical fault", "Other",
];
// Quick-stop buttons shown on the operator timer (reason + optional default note).
const DEFAULT_QUICK_STOPS = [
  { label: "Mechanical fault", reason: "Mechanical fault" },
  { label: "Quality check", reason: "Quality check" },
  { label: "Maintenance", reason: "Waiting on maintenance" },
  { label: "Tooling change", reason: "Tooling change" },
  { label: "Cleaning", reason: "Cleaning" },
  { label: "Material jam", reason: "Material jam" },
];
// Shifts: supervisor-defined time frames operators pick from. `goals` = optional
// per-machine output target ({ machine: units }); a machine with no entry has no
// goal. Legacy single-shift configs (`config.shift`) migrate into a one-entry
// list on load; a legacy shift-wide `goal` number migrates into `goals` for the
// first machine it can (see normalizeShifts).
const DEFAULT_SHIFTS = [
  { id: "shift-1", name: "Day", start: "06:00", end: "14:00", goals: {} },
];

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_MS = 60 * DAY; // discarded/archived records auto-purge after 60 days

// ---------- Formatting helpers ---------------------------------------------
const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h > 0 ? h + "h " : ""}${m > 0 || h > 0 ? m + "m " : ""}${sec}s`;
};
const fmtTime = (ts) =>
  new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const dayKey = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
// Compact "how long ago" for the sync status line.
const relTime = (ts) => {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 90) return "1m ago";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 5400) return "1h ago";
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

function shiftLengthMs(shift) {
  if (!shift?.start || !shift?.end) return 0;
  const [sh, sm] = shift.start.split(":").map(Number);
  const [eh, em] = shift.end.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60; // overnight shift
  return mins * 60 * 1000;
}

// Today's occurrence of a shift's END as epoch ms, rolling into tomorrow for an
// overnight shift or one whose end time has already passed — the honest "time
// left in the shift" denominator for the goal projection.
function shiftEndAt(shift, now = Date.now()) {
  if (!shift?.end) return null;
  const [eh, em] = shift.end.split(":").map(Number);
  const d = new Date(now);
  d.setHours(eh, em, 0, 0);
  let end = d.getTime();
  if (end <= now) end += 24 * 60 * 60 * 1000; // already past today → later tonight/tomorrow
  return end;
}

// Coerce a shifts array (or a legacy single `shift`) into a valid, non-empty list
// of {id,name,start,end,goal}. Returns null if there's nothing usable.
function normalizeShifts(shiftsArr, legacyShift) {
  // A per-machine goals map: { machine: units } with positive integers only.
  const cleanGoals = (raw) => {
    const out = {};
    if (raw && typeof raw === "object") {
      for (const [m, v] of Object.entries(raw)) {
        const n = Math.max(0, Math.round(Number(v) || 0));
        if (m && n > 0) out[m] = n;
      }
    }
    return out;
  };
  const clean = Array.isArray(shiftsArr)
    ? shiftsArr.filter((s) => s && s.start && s.end).map((s, i) => ({
        id: s.id || `shift-${i + 1}`,
        name: s.name || `Shift ${i + 1}`,
        start: s.start, end: s.end,
        goals: cleanGoals(s.goals),
      }))
    : [];
  if (clean.length) return clean;
  if (legacyShift && legacyShift.start && legacyShift.end)
    return [{ id: "shift-1", name: "Shift 1", start: legacyShift.start, end: legacyShift.end, goals: {} }];
  return null;
}

// Legacy mirror written alongside `shifts` so older clients / the watch config
// (which reads only {start,end}) keep working off the primary shift.
const legacyShiftOf = (shifts) =>
  shifts && shifts[0] ? { start: shifts[0].start, end: shifts[0].end } : { start: "06:00", end: "14:00" };

// Stable key fragment for a machine name (used in production record ids).
const machineSlug = (m) => String(m || "").replace(/[^a-zA-Z0-9]+/g, "-");
const HOUR_MS = 60 * 60 * 1000;

// ---------- OEE -------------------------------------------------------------
// OEE = Availability × Performance × Quality, each a 0..1 fraction.
//  - Availability = run time / planned time            (needs planned + downtime)
//  - Performance  = actual output / theoretical output (needs a rated rate)
//  - Quality      = good units / total units           (needs a unit count)
// Any factor whose inputs are missing comes back null; OEE then multiplies only
// the known factors and flags `partial` so the UI can say so instead of showing
// a misleadingly low number.
function computeOEE({ plannedMs, downtimeMs, unitsProduced, scrapCount, ratePerHour }) {
  const planned = Math.max(0, plannedMs || 0);
  const runMs = Math.max(0, planned - Math.max(0, downtimeMs || 0));
  const units = Math.max(0, Number(unitsProduced) || 0);
  const scrap = Math.min(units, Math.max(0, Number(scrapCount) || 0));
  const rate = Number(ratePerHour) || 0;

  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const a = planned > 0 ? clamp01(runMs / planned) : null;
  const theoretical = rate > 0 ? rate * (runMs / HOUR_MS) : 0;
  const p = rate > 0 && theoretical > 0 ? clamp01(units / theoretical) : null;
  const q = units > 0 ? clamp01((units - scrap) / units) : null;

  const factors = [a, p, q].filter((f) => f != null);
  const oee = factors.length ? factors.reduce((x, y) => x * y, 1) : null;
  const partial = a == null || p == null || q == null;
  return { a, p, q, oee, partial };
}
const pct = (f) => (f == null ? "—" : `${(f * 100).toFixed(1)}%`);
const oeeAccent = (f) => (f == null ? "" : f > 0.85 ? "text-emerald-500" : f > 0.6 ? "text-amber-500" : "text-red-500");

// ---------- Shift output goal ----------------------------------------------
// Given a units goal, what's been produced, the machine's rated units/hour, and
// when the shift ends, project whether the goal is still reachable. `slackMs` is
// how much MORE downtime can be absorbed and still hit it — so it shrinks with
// every stop (the "given the number and times of stops" part). state:
//   met   — already at/over the goal
//   track — comfortably reachable
//   risk  — reachable but little slack left
//   missed— can't be reached even running flat-out for the rest of the shift
//   na    — no goal or no machine rate set (can't project)
function computeGoalStatus({ goal, produced, ratePerHour, shiftEndMs, machine, now = Date.now() }) {
  const g = Math.max(0, Number(goal) || 0);
  const made = Math.max(0, Number(produced) || 0);
  const rate = Number(ratePerHour) || 0;
  if (g <= 0 || rate <= 0 || !shiftEndMs) return { state: "na", goal: g, produced: made, machine };
  const need = Math.max(0, g - made);
  const remainingMs = Math.max(0, shiftEndMs - now);
  if (need === 0) return { state: "met", goal: g, produced: made, need, remainingMs, slackMs: remainingMs, ratePerHour: rate, machine };
  const requiredRunMs = (need / rate) * HOUR_MS;
  const slackMs = remainingMs - requiredRunMs;
  const state = slackMs < 0 ? "missed" : slackMs < 15 * 60 * 1000 ? "risk" : "track";
  return { state, goal: g, produced: made, need, remainingMs, requiredRunMs, slackMs, ratePerHour: rate, machine };
}
const goalAccent = (state) =>
  state === "missed" ? "text-red-500" : state === "risk" ? "text-amber-500"
    : state === "met" || state === "track" ? "text-emerald-500" : "";

// ---------- Shift handover report -------------------------------------------
// Snapshot of the operator's current shift, for the handover modal / email.
// Roaming-aware: machines-worked breakdown and shift-wide OEE come from myShift.
function buildShiftReport({ operator, machine, myStops, myShift, clearedBefore, activeShift, goalStatus }) {
  const downtimeMs = myStops.reduce((a, s) => a + s.duration, 0);
  const byReason = {};
  myStops.forEach((s) => { byReason[s.reason] = (byReason[s.reason] || 0) + s.duration; });
  const topReasons = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
  const longest = myStops.reduce((best, s) => (!best || s.duration > best.duration ? s : best), null);
  return {
    operator: operator.trim() || "Unnamed", machine,
    shiftName: activeShift?.name || null,
    windowStart: clearedBefore || null, windowEnd: Date.now(),
    stopCount: myStops.length, downtimeMs, topReasons, longest,
    machines: myShift.rows, hasSessions: myShift.hasSessions,
    oee: myShift.overall, goal: goalStatus || null,
    notes: myStops.filter((s) => s.notes).map((s) => ({ reason: s.reason, notes: s.notes })),
  };
}

// One-line human summary of a goal projection, shared by the report + the UI.
function goalSummaryText(g) {
  if (!g || g.state === "na") return "";
  const who = g.machine ? `${g.machine} ` : "";
  if (g.state === "met") return `${who}goal ${g.goal} met (${g.produced} made)`;
  const base = `${who}goal ${g.goal} · made ${g.produced}`;
  if (g.state === "missed") return `${base} · not achievable (short by ${g.need})`;
  const slack = g.slackMs != null ? `, up to ${fmtDur(g.slackMs)} more downtime OK` : "";
  return `${base} · ${g.state === "risk" ? "at risk" : "on track"} (need ${g.need}${slack})`;
}

// Plain-text rendering of the report — what gets copied / emailed.
function formatReportText(r) {
  const lines = [];
  lines.push("STOPTRACK SHIFT HANDOVER");
  lines.push(`Operator: ${r.operator}${r.machines.length <= 1 ? ` · Machine: ${r.machines[0]?.machine || r.machine}` : ""}`);
  lines.push(`Shift: ${r.shiftName ? `${r.shiftName} · ` : ""}${r.windowStart ? fmtTime(r.windowStart) : "start"} → ${fmtTime(r.windowEnd)}`);
  lines.push("");
  lines.push(`Stops: ${r.stopCount} · Downtime: ${fmtDur(r.downtimeMs)}`);
  lines.push(`OEE${r.oee.partial ? " (partial)" : ""}: ${pct(r.oee.oee)}  [A ${pct(r.oee.a)} · P ${pct(r.oee.p)} · Q ${pct(r.oee.q)}]`);
  { const gs = goalSummaryText(r.goal); if (gs) lines.push(gs); }
  if (r.machines.length) {
    lines.push("");
    lines.push("Machines worked:");
    r.machines.forEach((m) => {
      const bits = [];
      if (r.hasSessions) bits.push(fmtDur(m.mannedMs));
      bits.push(`${m.stops} stop${m.stops === 1 ? "" : "s"}`);
      if (m.downtimeMs) bits.push(`${fmtDur(m.downtimeMs)} down`);
      if (m.units || m.scrap) bits.push(`${m.units} units / ${m.scrap} scrap`);
      lines.push(`  - ${m.machine}: ${bits.join(" · ")}`);
    });
  }
  if (r.topReasons.length) {
    lines.push("");
    lines.push("Top stop reasons:");
    r.topReasons.slice(0, 5).forEach(([reason, ms]) => lines.push(`  - ${reason}: ${fmtDur(ms)}`));
  }
  if (r.longest) lines.push(`Longest stop: ${r.longest.reason} · ${fmtDur(r.longest.duration)} (${fmtTime(r.longest.start)})`);
  if (r.notes.length) {
    lines.push("");
    lines.push("Notes:");
    r.notes.slice(0, 8).forEach((n) => lines.push(`  - [${n.reason}] ${n.notes}`));
  }
  return lines.join("\n");
}

function downloadFile(content, filename, type) {
  // In the Android shell a blob/anchor download is silently dropped by the WebView
  // (no DownloadListener, and blob: URLs never reach it). Hand the bytes to native,
  // which writes the file to the Downloads folder. Falls back to the browser path.
  const n = (typeof window !== "undefined") ? window.StopTrackNative : null;
  if (n && typeof n.saveFile === "function") {
    try { n.saveFile(filename, type || "application/octet-stream", String(content)); return; }
    catch (e) { /* fall through to the browser download */ }
  }
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The last-write-wins clock for a stop record. Newer records were mutated more
// recently. Falls back through older fields for records saved before updatedAt
// existed, so mixed-vintage data still merges sanely.
const stampOf = (s) => s.updatedAt ?? s.loggedAt ?? s.end ?? s.start ?? 0;

// SHA-256 hex of a string, used to store the supervisor PIN as a hash rather
// than plaintext. Implemented in pure JS on purpose: the app is opened from a
// file:// origin on the shop floor, where Chrome marks the context insecure and
// crypto.subtle is undefined. A pure-JS SHA-256 works everywhere AND yields the
// same digest as Web Crypto, so a PIN hash set on one device still matches on
// another regardless of how each was served. Kept async so callers don't change.
async function sha256Hex(str) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  // UTF-8 encode
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0xd800 || c >= 0xe000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else { i++; c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff)); bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  const l = bytes.length;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bitLen = l * 8;
  for (let i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, i * 8)) & 0xff);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Array(64);
  for (let i = 0; i < bytes.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = (bytes[i + j * 4] << 24) | (bytes[i + j * 4 + 1] << 16) | (bytes[i + j * 4 + 2] << 8) | (bytes[i + j * 4 + 3]);
    for (let j = 16; j < 64; j++) {
      const s0 = rr(w[j - 15], 7) ^ rr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rr(w[j - 2], 17) ^ rr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let j = 0; j < 64; j++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[j] + w[j]) | 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const toHex = (x) => (x >>> 0).toString(16).padStart(8, "0");
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
}

/* ============================================================================
   DATA LAYER  (offline-first)
   ----------------------------------------------------------------------------
   Every read/write lives here. To move to a server later, replace the bodies
   of these functions with `fetch()` calls — the component code never touches
   storage directly. Each method is defensive: it resolves to a safe fallback
   instead of throwing, so a storage failure degrades gracefully.
   Keys:  stop:<id>            one record per stop (shared scope)
          config:lists         machines / reasons / quickStops / shift (shared)
          config:prefs         dark mode, last reason, cleared-before (personal)
          inprogress:current   live timer autosave (personal)
   ========================================================================== */
/* ----------------------------------------------------------------------------
   STORAGE BACKEND
   The app prefers the Claude-artifacts `window.storage` API (async, supports a
   shared scope so operators see each other's stops). When that isn't present
   — e.g. the file is dropped into a plain Vite/CRA build, or storage is
   blocked — it transparently falls back to the browser's localStorage, and as
   a last resort an in-memory map (so the UI still works for the session).
   All three implement the same async shape: get / set / delete / list.
   To move to a server later, add a fourth backend here (or swap `api` bodies
   for fetch) — nothing above this line changes.
-----------------------------------------------------------------------------*/
function pickBackend() {
  // 1) Claude artifacts runtime
  if (typeof window !== "undefined" && window.storage && typeof window.storage.set === "function") {
    return { kind: "window.storage", persistent: true, shared: true, impl: window.storage };
  }
  // 2) Browser localStorage (synchronous; wrapped to match the async API)
  const ls = (() => {
    try {
      if (typeof localStorage === "undefined") return null;
      const probe = "__stoptrack_probe__";
      localStorage.setItem(probe, "1"); localStorage.removeItem(probe);
      return localStorage;
    } catch { return null; }
  })();
  if (ls) {
    return {
      kind: "localStorage", persistent: true, shared: false,
      impl: {
        async get(key) { const v = ls.getItem(key); return v == null ? null : { key, value: v }; },
        async set(key, value) { ls.setItem(key, value); return { key, value }; },
        async delete(key) { ls.removeItem(key); return { key }; },
        async list(prefix) { const keys = []; for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(prefix)) keys.push(k); } return { keys }; },
      },
    };
  }
  // 3) In-memory (non-persistent) — keeps the app usable even with no storage
  const mem = new Map();
  return {
    kind: "memory", persistent: false, shared: false,
    impl: {
      async get(key) { return mem.has(key) ? { key, value: mem.get(key) } : null; },
      async set(key, value) { mem.set(key, value); return { key, value }; },
      async delete(key) { mem.delete(key); return { key }; },
      async list(prefix) { return { keys: [...mem.keys()].filter((k) => k.startsWith(prefix)) }; },
    },
  };
}

const BACKEND = pickBackend();
const STORE = BACKEND.impl;
// `true` = shared scope on window.storage; ignored by the other backends.
const SHARED = BACKEND.shared;
// Surfaced in the UI so the operator knows whether data persists / is shared.
export const STORAGE_INFO = { kind: BACKEND.kind, persistent: BACKEND.persistent, shared: BACKEND.shared };

// Gate for the sync outbox: only enqueue changes for upload once server sync is
// actually configured, so a device that never syncs doesn't grow an outbox.
let syncEnabled = false;
// Short fetch timeout so a dead server never blocks the offline-first UI.
async function fetchJSON(url, { token, method = "GET", body, timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "Request timed out" : (e?.message || "Network error") };
  } finally { clearTimeout(timer); }
}

const api = {
  // --- stops -----------------------------------------------------------------
  async loadStops() {
    try {
      const res = await STORE.list("stop:", SHARED);
      const keys = res?.keys || [];
      if (!keys.length) return { ok: true, stops: [] };
      const items = await Promise.all(keys.map(async (k) => {
        try { const r = await STORE.get(k, SHARED); return r ? { key: k, ...JSON.parse(r.value) } : null; }
        catch { return null; }
      }));
      const now = Date.now();
      const survivors = [];
      for (const s of items.filter(Boolean)) {
        // Purge long-discarded records AND old delete-tombstones to keep storage
        // tidy. Tombstones must outlive RETENTION_MS long enough to have synced.
        const gcAt = (s.discarded && s.discardedAt) || (s.deleted && s.deletedAt);
        if (gcAt && now - gcAt > RETENTION_MS) {
          try { await STORE.delete(s.key, SHARED); } catch { /* ignore */ }
        } else survivors.push(s);
      }
      survivors.sort((a, b) => b.start - a.start);
      return { ok: true, stops: survivors };
    } catch {
      return { ok: false, stops: [] };
    }
  },

  // Save one stop, then read it back to confirm the write actually landed.
  async saveStop(record) {
    const key = `stop:${record.id}`;
    try {
      try { await STORE.set(key, JSON.stringify(record), SHARED); }
      catch { await STORE.set(key, JSON.stringify(record)); } // some builds reject the scope flag
      const check = await STORE.get(key, SHARED).catch(() => STORE.get(key));
      if (!check || !check.value) return { ok: false, error: "The stop didn't save. Check storage and try again." };
      await this._enqueue(key);
      return { ok: true, record };
    } catch (e) {
      return { ok: false, error: e?.message || "The stop didn't save. Try again." };
    }
  },

  async updateStop(record) {
    const key = record.key || `stop:${record.id}`;
    try { await STORE.set(key, JSON.stringify(record), SHARED); await this._enqueue(key); return { ok: true }; }
    catch { return { ok: false }; }
  },

  // Permanent delete — writes a tombstone (deleted:true) instead of erasing the
  // key, so the deletion can propagate to other devices via sync and then be
  // garbage-collected locally after RETENTION_MS (see loadStops purge).
  async deleteStop(record) {
    const key = record.key || `stop:${record.id}`;
    const now = Date.now();
    const tomb = { id: record.id, key, deleted: true, updatedAt: now, deletedAt: now };
    try {
      try { await STORE.set(key, JSON.stringify(tomb), SHARED); }
      catch { await STORE.set(key, JSON.stringify(tomb)); }
      await this._enqueue(key);
      return { ok: true, tombstone: tomb };
    } catch { return { ok: false }; }
  },

  // --- production (units/scrap per shift, synced like stops) ----------------
  async loadProduction() {
    try {
      const res = await STORE.list("prod:", SHARED);
      const keys = res?.keys || [];
      const items = await Promise.all(keys.map(async (k) => {
        try { const r = await STORE.get(k, SHARED); return r ? { key: k, ...JSON.parse(r.value) } : null; }
        catch { return null; }
      }));
      return { ok: true, records: items.filter(Boolean) };
    } catch { return { ok: false, records: [] }; }
  },

  // Upsert the production record for one (operator, machine, shift). Read-back
  // verified like saveStop, and enqueued for sync under its full key.
  async saveProduction(record) {
    const key = `prod:${record.id}`;
    try {
      try { await STORE.set(key, JSON.stringify(record), SHARED); }
      catch { await STORE.set(key, JSON.stringify(record)); }
      const check = await STORE.get(key, SHARED).catch(() => STORE.get(key));
      if (!check || !check.value) return { ok: false, error: "The output didn't save. Check storage and try again." };
      await this._enqueue(key);
      return { ok: true, record };
    } catch (e) {
      return { ok: false, error: e?.message || "The output didn't save. Try again." };
    }
  },

  // --- machine sessions (who was at which machine, when — synced) -----------
  async loadSessions() {
    try {
      const res = await STORE.list("sess:", SHARED);
      const keys = res?.keys || [];
      const items = await Promise.all(keys.map(async (k) => {
        try { const r = await STORE.get(k, SHARED); return r ? { key: k, ...JSON.parse(r.value) } : null; }
        catch { return null; }
      }));
      const now = Date.now();
      const survivors = [];
      for (const s of items.filter(Boolean)) {
        // GC sessions that ended long ago, same policy as discarded stops.
        if (s.end && now - s.end > RETENTION_MS) {
          try { await STORE.delete(s.key, SHARED); } catch { /* ignore */ }
        } else survivors.push(s);
      }
      return { ok: true, records: survivors };
    } catch { return { ok: false, records: [] }; }
  },

  // Upsert a session (open or closed). Fire-and-forget — presence tracking must
  // never block or error the operator flow.
  async saveSession(record) {
    const key = `sess:${record.id}`;
    try {
      try { await STORE.set(key, JSON.stringify(record), SHARED); }
      catch { await STORE.set(key, JSON.stringify(record)); }
      await this._enqueue(key);
      return { ok: true, record };
    } catch { return { ok: false }; }
  },

  // Read any record straight from storage by its full key (used by the sync
  // push loop to assemble outbox payloads without depending on React state).
  async getRecordByKey(key) {
    try { const r = await STORE.get(key, SHARED).catch(() => STORE.get(key)); return r ? { key, ...JSON.parse(r.value) } : null; }
    catch { return null; }
  },

  // Write a record that arrived FROM the server. Deliberately does NOT enqueue,
  // so a pulled change isn't immediately pushed back up (no echo loop).
  async putLocal(record) {
    const key = record.key || `stop:${record.id}`;
    try { await STORE.set(key, JSON.stringify(record), SHARED).catch(() => STORE.set(key, JSON.stringify(record))); return { ok: true }; }
    catch { return { ok: false }; }
  },

  // --- config (shared across operators) -------------------------------------
  async loadConfig() {
    try { const r = await STORE.get("config:lists", SHARED); return r ? JSON.parse(r.value) : null; }
    catch { return null; }
  },
  async saveConfig(cfg) {
    try { await STORE.set("config:lists", JSON.stringify(cfg), SHARED); return { ok: true }; }
    catch { return { ok: false }; }
  },

  // --- prefs (personal) ------------------------------------------------------
  async loadPrefs() {
    try { const r = await STORE.get("config:prefs", false); return r ? JSON.parse(r.value) : null; }
    catch { return null; }
  },
  async savePrefs(prefs) {
    try { await STORE.set("config:prefs", JSON.stringify(prefs), false); } catch { /* ignore */ }
  },

  // --- in-progress timer autosave (personal) --------------------------------
  async saveInProgress(data) {
    try { await STORE.set("inprogress:current", JSON.stringify(data), false); } catch { /* ignore */ }
  },
  async loadInProgress() {
    try { const r = await STORE.get("inprogress:current", false); return r ? JSON.parse(r.value) : null; }
    catch { return null; }
  },
  async clearInProgress() {
    try { await STORE.delete("inprogress:current", false); } catch { /* ignore */ }
  },

  // --- full backup / restore (carry data across app versions) ---------------
  // A downloaded index.html is a NEW browser origin (empty localStorage), and a
  // re-signed APK reinstalls fresh — either way the old data is stranded. These
  // export/import one portable JSON of EVERYTHING (shared config + personal prefs
  // + all stops/production/sessions) so the supervisor can carry it over. Import
  // merges last-write-wins, so restoring onto a populated app never clobbers
  // newer records.
  async exportAll() {
    const [config, prefs, stops, production, sessions] = await Promise.all([
      this.loadConfig(), this.loadPrefs(), this.loadStops(), this.loadProduction(), this.loadSessions(),
    ]);
    const strip = (arr) => (arr || []).map(({ key, ...rest }) => rest);
    return {
      app: "stoptrack", schema: 1, exportedAt: Date.now(),
      config: config || null,
      prefs: prefs || null,
      stops: strip(stops.stops),
      production: strip(production.records),
      sessions: strip(sessions.records),
    };
  },
  async importAll(data) {
    if (!data || data.app !== "stoptrack") throw new Error("Not a StopTrack backup file.");
    const counts = { stops: 0, production: 0, sessions: 0, configApplied: false };
    // Config — last-write-wins on updatedAt.
    if (data.config) {
      const cur = await this.loadConfig();
      if (!cur || (Number(data.config.updatedAt) || 0) >= (Number(cur.updatedAt) || 0)) {
        await this.saveConfig(data.config);
        counts.configApplied = true;
      }
    }
    // Prefs — shallow-merge so restore brings back the shift cutoff / chosen
    // shift / operator without wiping this device's dark-mode etc.
    if (data.prefs) {
      const cur = (await this.loadPrefs()) || {};
      await this.savePrefs({ ...cur, ...data.prefs });
    }
    // Records — upsert by id, newest last-write stamp wins.
    const mergeInto = async (incoming, existing, saver) => {
      const local = new Map((existing || []).map((r) => [r.id, r]));
      let n = 0;
      for (const r of (incoming || [])) {
        if (!r || !r.id) continue;
        const cur = local.get(r.id);
        if (!cur || stampOf(r) >= stampOf(cur)) { await saver(r); n++; }
      }
      return n;
    };
    counts.stops = await mergeInto(data.stops, (await this.loadStops()).stops, (r) => this.saveStop(r));
    counts.production = await mergeInto(data.production, (await this.loadProduction()).records, (r) => this.saveProduction(r));
    counts.sessions = await mergeInto(data.sessions, (await this.loadSessions()).records, (r) => this.saveSession(r));
    return counts;
  },

  // --- sync: config (device-local, NOT shared — bootstrap info per device) ---
  async loadSyncConfig() {
    try { const r = await STORE.get("config:sync", false); return r ? JSON.parse(r.value) : null; }
    catch { return null; }
  },
  async saveSyncConfig(cfg) {
    try { await STORE.set("config:sync", JSON.stringify(cfg), false); } catch { /* ignore */ }
    syncEnabled = !!(cfg && cfg.enabled && cfg.url);
  },
  setSyncEnabled(v) { syncEnabled = !!v; },

  // --- sync: outbox + cursor bookkeeping (device-local) ---------------------
  async getOutbox() {
    try { const r = await STORE.get("sync:outbox", false); const a = r ? JSON.parse(r.value) : []; return Array.isArray(a) ? a : []; }
    catch { return []; }
  },
  async setOutbox(ids) {
    try { await STORE.set("sync:outbox", JSON.stringify([...new Set(ids)]), false); } catch { /* ignore */ }
  },
  // Append a storage key (stop:<id> / prod:<id>) to the outbox. No-op until
  // sync is configured (see syncEnabled). Older outboxes stored bare stop ids;
  // normalizeOutboxKey upgrades those on read.
  async _enqueue(key) {
    if (!syncEnabled) return;
    try { const keys = await this.getOutbox(); if (!keys.includes(key)) await this.setOutbox([...keys, key]); }
    catch { /* ignore — a lost enqueue just means it syncs on the next full push */ }
  },
  // Seed the outbox with every local stop/production/session key — used the first
  // time sync is turned on so existing history is uploaded, not just changes after.
  async seedOutboxWithAll() {
    try {
      const stops = await STORE.list("stop:", SHARED);
      const prods = await STORE.list("prod:", SHARED).catch(() => ({ keys: [] }));
      const sess = await STORE.list("sess:", SHARED).catch(() => ({ keys: [] }));
      await this.setOutbox([...(stops?.keys || []), ...(prods?.keys || []), ...(sess?.keys || [])]);
    } catch { /* ignore */ }
  },
  // This device's open machine-session id, so a reload can close the dangling
  // span it left behind (device-local, never synced).
  async getCurrentSessionId() {
    try { const r = await STORE.get("sync:currentSession", false); return r ? r.value : null; }
    catch { return null; }
  },
  async setCurrentSessionId(id) {
    try { if (id) await STORE.set("sync:currentSession", id, false); else await STORE.delete("sync:currentSession", false); }
    catch { /* ignore */ }
  },

  // Named pull cursors: "" for stops (legacy key), "prod" for production.
  async getCursor(name = "") {
    const k = name ? `sync:cursor:${name}` : "sync:cursor";
    try { const r = await STORE.get(k, false); return r ? Number(r.value) || 0 : 0; }
    catch { return 0; }
  },
  async setCursor(ts, name = "") {
    const k = name ? `sync:cursor:${name}` : "sync:cursor";
    try { await STORE.set(k, String(ts || 0), false); } catch { /* ignore */ }
  },

  // --- sync: remote (network) — the future server seam. Each method maps 1:1
  // to a documented endpoint; swap the URL and everything above stays put. ----
  async remoteHealth(cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    return fetchJSON(`${cfg.url.replace(/\/$/, "")}/health`, { token: cfg.token, timeoutMs: 5000 });
  },
  async remotePush(records, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/stops`, { token: cfg.token, method: "POST", body: { stops: records } });
    return res.ok ? { ok: true, serverTime: res.data?.serverTime || Date.now() } : res;
  },
  async remotePull(since, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/stops?since=${since || 0}`, { token: cfg.token });
    return res.ok ? { ok: true, stops: res.data?.stops || [], serverTime: res.data?.serverTime || Date.now() } : res;
  },
  async remotePushProduction(records, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/production`, { token: cfg.token, method: "POST", body: { records } });
    return res.ok ? { ok: true, serverTime: res.data?.serverTime || Date.now() } : res;
  },
  async remotePullProduction(since, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/production?since=${since || 0}`, { token: cfg.token });
    return res.ok ? { ok: true, records: res.data?.records || [], serverTime: res.data?.serverTime || Date.now() } : res;
  },
  async remotePushSessions(records, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/sessions`, { token: cfg.token, method: "POST", body: { records } });
    return res.ok ? { ok: true, serverTime: res.data?.serverTime || Date.now() } : res;
  },
  async remotePullSessions(since, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/sessions?since=${since || 0}`, { token: cfg.token });
    return res.ok ? { ok: true, records: res.data?.records || [], serverTime: res.data?.serverTime || Date.now() } : res;
  },
  // Ask the sync server to email a shift handover report. The server answers
  // 501 when SMTP isn't configured; callers surface that and fall back to Copy.
  async sendReport(payload, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/report`, { token: cfg.token, method: "POST", body: payload, timeoutMs: 15000 });
    if (res.ok) return { ok: true };
    return { ok: false, error: res.status === 501 ? "Email isn't set up on the server" : (res.error || "Send failed") };
  },
  async remoteGetConfig(cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/config`, { token: cfg.token });
    return res.ok ? { ok: true, config: res.data?.config || null, updatedAt: res.data?.updatedAt || 0 } : res;
  },
  async remotePutConfig(config, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    return fetchJSON(`${cfg.url.replace(/\/$/, "")}/config`, { token: cfg.token, method: "PUT", body: { config, updatedAt: config?.updatedAt || Date.now() } });
  },
};

/* ============================================================================
   THEME
   ========================================================================== */
function useTheme(dark) {
  return useMemo(() => dark
    ? { app: "bg-slate-950 text-slate-100", card: "bg-slate-900 border border-slate-800", sub: "text-slate-400", input: "bg-slate-800 border-slate-700 text-slate-100 placeholder-slate-500", chip: "bg-slate-800", rowHover: "hover:bg-slate-800/60", thead: "bg-slate-800/60 text-slate-400", border: "border-slate-800", muted: "bg-slate-800/60", accentBtn: "bg-slate-700 hover:bg-slate-600 text-white" }
    : { app: "bg-slate-100 text-slate-800", card: "bg-white shadow-sm", sub: "text-slate-500", input: "bg-white border-slate-300 text-slate-800 placeholder-slate-400", chip: "bg-slate-100", rowHover: "hover:bg-slate-50", thead: "bg-slate-50 text-slate-500", border: "border-slate-100", muted: "bg-slate-100", accentBtn: "bg-slate-700 hover:bg-slate-800 text-white" },
  [dark]);
}

/* ============================================================================
   TIMER HOOK  — single source of truth for the live stopwatch.
   ----------------------------------------------------------------------------
   Fixes the original bugs:
   - elapsed is DERIVED, not a separate piece of state that can drift
   - pause banks the segment exactly once; resume starts a fresh segment
   - the live re-render interval only runs while actively timing
   - autosave + tab-hide recovery all read from one coherent state object
   ========================================================================== */
const emptyTimer = { running: false, paused: false, startTs: null, accumulated: 0, segStart: null };

// Derived elapsed for a web-shaped timer state (used by the native-shell mirror).
// Same rule as useTimer's `elapsed`, so the display can't disagree with the state.
function nativeElapsed(s, now) {
  if (!s) return 0;
  return s.paused ? s.accumulated : s.running ? s.accumulated + (now - s.segStart) : s.accumulated;
}

function useTimer({ operator, machine }) {
  const [state, setState] = useState(emptyTimer);
  const [now, setNow] = useState(Date.now());
  const stateRef = useRef(state);
  stateRef.current = state;
  // Current machine, readable from the stable start() callback. The machine is
  // SNAPSHOTTED into timer state at start, so a roaming operator can switch
  // machines mid-stop without re-attributing the running stop.
  const machineRef = useRef(machine);
  machineRef.current = machine;

  // Derived elapsed — never stored, so it can't disagree with the timer state.
  const elapsed = state.paused
    ? state.accumulated
    : state.running
      ? state.accumulated + (now - state.segStart)
      : state.accumulated;

  // Re-render ~5x/sec only while actively running (not paused / idle).
  useEffect(() => {
    if (!state.running || state.paused) return;
    const iv = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(iv);
  }, [state.running, state.paused]);

  // Autosave whenever the timer is active, and on tab-hide / page-hide.
  const persist = useCallback((s, extra = {}) => {
    if (!s.running && !s.paused) return;
    api.saveInProgress({ operator, machine, ...s, savedAt: Date.now(), ...extra });
  }, [operator, machine]);

  useEffect(() => { persist(state); }, [state, persist]);

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "hidden") {
        const s = stateRef.current;
        if (s.running || s.paused) api.saveInProgress({ operator, machine, ...s, savedAt: Date.now() });
      }
    };
    document.addEventListener("visibilitychange", handler);
    window.addEventListener("pagehide", handler);
    return () => {
      document.removeEventListener("visibilitychange", handler);
      window.removeEventListener("pagehide", handler);
    };
  }, [operator, machine]);

  const start = useCallback(() => {
    const t = Date.now();
    // machine is pinned here; autosave spreads state AFTER the machine prop, so
    // the pinned value wins in the recovery payload too.
    setState({ running: true, paused: false, startTs: t, accumulated: 0, segStart: t, machine: machineRef.current });
  }, []);

  const pause = useCallback(() => {
    setState((s) => {
      if (!s.running || s.paused) return s;
      const banked = s.accumulated + (Date.now() - s.segStart);
      return { ...s, paused: true, accumulated: banked, segStart: null };
    });
  }, []);

  const resume = useCallback(() => {
    setState((s) => (s.paused ? { ...s, paused: false, segStart: Date.now() } : s));
  }, []);

  // Stop returns the finished {start, end, duration}; caller documents it.
  const stop = useCallback(() => {
    const s = stateRef.current;
    const end = Date.now();
    const duration = s.paused ? s.accumulated : s.accumulated + (end - s.segStart);
    setState(emptyTimer);
    api.clearInProgress();
    // Carries the pinned machine so documentation attributes the stop to where
    // it actually happened, not to wherever the operator has switched to since.
    return { start: s.startTs, end, duration, machine: s.machine };
  }, []);

  const reset = useCallback(() => { setState(emptyTimer); api.clearInProgress(); }, []);

  // Restore a recovered session (resume live, or paused-frozen). Keeps the
  // recovered machine pinned.
  const restore = useCallback((d) => {
    if (d.paused || !d.segStart) {
      setState({ running: true, paused: true, startTs: d.startTs, accumulated: d.accumulated || 0, segStart: null, machine: d.machine });
    } else {
      setState({ running: true, paused: false, startTs: d.startTs, accumulated: d.accumulated || 0, segStart: Date.now(), machine: d.machine });
    }
  }, []);

  return { state, elapsed, start, pause, resume, stop, reset, restore };
}

/* ============================================================================
   SYNC HOOK — offline-first background sync.
   ----------------------------------------------------------------------------
   localStorage stays the source of truth. This hook pushes the local outbox to
   the server when online and pulls remote changes, merging by last-write-wins
   (updatedAt). It is inert until a server URL is configured, and every network
   call is best-effort: a failure leaves local data untouched and retries later.
   ========================================================================== */
const SYNC_INTERVAL_MS = 25000;

function useSync({ cfg, onRemoteStops, onRemoteProduction, onRemoteSessions, localConfig, onRemoteConfig }) {
  const [status, setStatus] = useState({
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    lastSync: null, pending: 0, syncing: false, error: null,
  });
  // Keep the latest inputs in refs so the stable `flush` callback never runs
  // against stale config/handlers.
  const cfgRef = useRef(cfg); cfgRef.current = cfg;
  const onStopsRef = useRef(onRemoteStops); onStopsRef.current = onRemoteStops;
  const onProdRef = useRef(onRemoteProduction); onProdRef.current = onRemoteProduction;
  const onSessRef = useRef(onRemoteSessions); onSessRef.current = onRemoteSessions;
  const localCfgRef = useRef(localConfig); localCfgRef.current = localConfig;
  const onCfgRef = useRef(onRemoteConfig); onCfgRef.current = onRemoteConfig;
  const runningRef = useRef(false); // guards against overlapping flushes

  const enabled = !!(cfg && cfg.enabled && cfg.url);

  const flush = useCallback(async () => {
    const c = cfgRef.current;
    if (!c || !c.enabled || !c.url) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) { setStatus((s) => ({ ...s, online: false })); return; }
    if (runningRef.current) return;
    runningRef.current = true;
    setStatus((s) => ({ ...s, syncing: true, online: true }));
    try {
      // 1) PUSH — upload everything queued in the outbox, split by record type.
      // Entries are full storage keys; bare ids from pre-production outboxes are
      // treated as stops for backward compatibility.
      const keys = (await api.getOutbox()).map((k) => (k.includes(":") ? k : `stop:${k}`));
      if (keys.length) {
        const records = (await Promise.all(keys.map((k) => api.getRecordByKey(k)))).filter(Boolean);
        const stopRows = records.filter((r) => r.key.startsWith("stop:"));
        const prodRows = records.filter((r) => r.key.startsWith("prod:"));
        const sessRows = records.filter((r) => r.key.startsWith("sess:"));
        if (stopRows.length) {
          const res = await api.remotePush(stopRows, c);
          if (!res.ok) { setStatus((s) => ({ ...s, syncing: false, error: res.error || "Push failed", pending: keys.length })); runningRef.current = false; return; }
        }
        if (prodRows.length) {
          const res = await api.remotePushProduction(prodRows, c);
          if (!res.ok) { setStatus((s) => ({ ...s, syncing: false, error: res.error || "Push failed", pending: keys.length })); runningRef.current = false; return; }
        }
        if (sessRows.length) {
          const res = await api.remotePushSessions(sessRows, c);
          if (!res.ok) { setStatus((s) => ({ ...s, syncing: false, error: res.error || "Push failed", pending: keys.length })); runningRef.current = false; return; }
        }
        await api.setOutbox([]); // clear only after every push confirmed
      }

      // 2) CONFIG — last-write-wins both directions.
      const localCfg = localCfgRef.current;
      const remoteCfg = await api.remoteGetConfig(c);
      if (remoteCfg.ok && remoteCfg.config && (remoteCfg.updatedAt || 0) > (localCfg?.updatedAt || 0)) {
        onCfgRef.current?.(remoteCfg.config);
      } else if (localCfg && (localCfg.updatedAt || 0) > (remoteCfg.ok ? (remoteCfg.updatedAt || 0) : 0)) {
        await api.remotePutConfig(localCfg, c);
      }

      // 3) PULL — stops and production, each behind its own cursor.
      const since = await api.getCursor();
      const pull = await api.remotePull(since, c);
      if (pull.ok) {
        if (pull.stops.length) await onStopsRef.current?.(pull.stops);
        await api.setCursor(pull.serverTime);
      }
      const prodSince = await api.getCursor("prod");
      const prodPull = await api.remotePullProduction(prodSince, c);
      if (prodPull.ok) {
        if (prodPull.records.length) await onProdRef.current?.(prodPull.records);
        await api.setCursor(prodPull.serverTime, "prod");
      }
      const sessSince = await api.getCursor("sess");
      const sessPull = await api.remotePullSessions(sessSince, c);
      if (sessPull.ok) {
        if (sessPull.records.length) await onSessRef.current?.(sessPull.records);
        await api.setCursor(sessPull.serverTime, "sess");
      }

      const pending = (await api.getOutbox()).length;
      const pullErr = !pull.ok ? (pull.error || "Pull failed") : !prodPull.ok ? (prodPull.error || "Pull failed") : !sessPull.ok ? (sessPull.error || "Pull failed") : null;
      setStatus({ online: true, lastSync: Date.now(), pending, syncing: false, error: pullErr });
    } catch (e) {
      setStatus((s) => ({ ...s, syncing: false, error: e?.message || "Sync error" }));
    } finally { runningRef.current = false; }
  }, []);

  // Interval + connectivity-driven flushing while sync is enabled.
  useEffect(() => {
    if (!enabled) { setStatus((s) => ({ ...s, error: null })); return; }
    flush();
    const iv = setInterval(flush, SYNC_INTERVAL_MS);
    const onOnline = () => { setStatus((s) => ({ ...s, online: true })); flush(); };
    const onOffline = () => setStatus((s) => ({ ...s, online: false }));
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => { clearInterval(iv); window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, [enabled, flush]);

  // Keep the pending count fresh even when idle (e.g. after a local save).
  const refreshPending = useCallback(async () => {
    const pending = (await api.getOutbox()).length;
    setStatus((s) => (s.pending === pending ? s : { ...s, pending }));
  }, []);

  return { status, flush, refreshPending, enabled };
}

/* ============================================================================
   ROOT APP
   ========================================================================== */
export default function App() {
  const [view, setView] = useState("operator");
  const [dark, setDark] = useState(false);

  // config (shared)
  const [machines, setMachines] = useState(DEFAULT_MACHINES);
  const [reasons, setReasons] = useState(DEFAULT_REASONS);
  const [quickStops, setQuickStops] = useState(DEFAULT_QUICK_STOPS);
  // Supervisor-defined shifts (shared config). Operators pick one; the choice
  // (shiftId) is a personal pref like operator/machine.
  const [shifts, setShifts] = useState(DEFAULT_SHIFTS);
  const [shiftId, setShiftId] = useState(DEFAULT_SHIFTS[0].id);

  // prefs (personal)
  const [lastReason, setLastReason] = useState(null);
  // clearedBefore: stops with start <= this are hidden from the live view but
  // kept in storage and still exported. This is the "cleared for view" cutoff.
  const [clearedBefore, setClearedBefore] = useState(0);
  // showAll: temporarily reveal stops hidden by clearedBefore, WITHOUT erasing
  // the cutoff — so "Show all" is reversible via a "Hide again" toggle. This is
  // view-only state and is intentionally not persisted across refresh.
  const [showAll, setShowAll] = useState(false);

  // data
  const [stops, setStops] = useState([]);
  const [loading, setLoading] = useState(true);

  // operator session
  const [operator, setOperator] = useState("");
  const [machine, setMachine] = useState(DEFAULT_MACHINES[0]);
  // Setup lock: when locked, operator/machine are read-only. Both the lock flag
  // and the locked values persist across refresh (see prefs load/save below).
  const [setupLocked, setSetupLocked] = useState(false);
  const timer = useTimer({ operator, machine });

  // --- Native Android shell -------------------------------------------------
  // On the phone app the NATIVE quick-stop timer (notification + floating bubble)
  // is the single source of truth: the same one timer that logs a stop when the
  // app is closed. Here the operator timer becomes a view/controller over it —
  // buttons drive native, the display mirrors native, and End routes the finished
  // stop into the existing reason picker (below). In a plain browser `nativeApi`
  // is null and every branch here stays inert; the local useTimer path is unchanged.
  const nativeApi = (typeof window !== "undefined") ? window.StopTrackNative : null;
  const inShell = !!(nativeApi && typeof nativeApi.startStop === "function");
  const [nativeTimer, setNativeTimer] = useState(null);     // web-shaped timer state
  const [nativePending, setNativePending] = useState(null); // finished stop awaiting a reason
  const [nowTick, setNowTick] = useState(Date.now());

  // Receive native state pushes; keep the timer + pending state in React.
  useEffect(() => {
    if (!inShell) return;
    window.StopTrackShell = {
      onState(s) {
        try {
          const d = (typeof s === "string") ? JSON.parse(s) : s;
          const ts = d && d.timer;
          setNativeTimer(ts ? {
            running: !!ts.running, paused: !!ts.paused, startTs: ts.startTs ?? null,
            accumulated: ts.accumulatedMs || 0, segStart: ts.segStartMs ?? null, machine: ts.machine || "",
          } : emptyTimer);
          const p = d && d.pending;
          setNativePending(p ? { start: p.start, end: p.end, duration: p.durationMs, machine: p.machine } : null);
        } catch (e) { /* ignore malformed pushes */ }
      },
    };
    try { if (typeof nativeApi.requestState === "function") nativeApi.requestState(); } catch (e) { /* ignore */ }
    return () => { try { delete window.StopTrackShell; } catch (e) { window.StopTrackShell = undefined; } };
  }, [inShell]);

  // Live re-render while a native stop is actively running (elapsed is derived).
  useEffect(() => {
    if (!inShell || !nativeTimer || !nativeTimer.running || nativeTimer.paused) return;
    const iv = setInterval(() => setNowTick(Date.now()), 250);
    return () => clearInterval(iv);
  }, [inShell, nativeTimer && nativeTimer.running, nativeTimer && nativeTimer.paused]);

  // documentation of a just-ended stop
  const [pendingStop, setPendingStop] = useState(null);
  const [reason, setReason] = useState(DEFAULT_REASONS[0]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // manual stop report dialog
  const [manualOpen, setManualOpen] = useState(false);

  // recovery prompt
  const [recovered, setRecovered] = useState(null);

  // "New Shift" confirmation dialog
  const [newShiftOpen, setNewShiftOpen] = useState(false);

  // supervisor PIN gate (hash lives in shared config; unlock is session-only)
  const [supervisorPinHash, setSupervisorPinHash] = useState(null);
  const [supervisorUnlocked, setSupervisorUnlocked] = useState(false);
  // shared-config last-write clock, for config sync LWW
  const [configUpdatedAt, setConfigUpdatedAt] = useState(0);
  // server sync config (device-local): { url, token, enabled }
  const [syncCfg, setSyncCfg] = useState(null);

  // OEE: per-machine rated output (units/hour) — shared config.
  const [rates, setRates] = useState({});
  // handover email recipients — shared config.
  const [handoverEmails, setHandoverEmails] = useState([]);
  // production records (units/scrap per shift) — synced like stops.
  const [production, setProduction] = useState([]);
  // machine sessions (operator presence spans) — synced like stops.
  const [sessions, setSessions] = useState([]);
  // shift handover report dialog
  const [handoverOpen, setHandoverOpen] = useState(false);
  // backup/restore: recovery banner on an empty install + a status message
  const [needsRestore, setNeedsRestore] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState("");
  const restoreInputRef = useRef(null);

  const t = useTheme(dark);

  // The operator's chosen shift (falls back to the first configured shift).
  const activeShift = useMemo(
    () => shifts.find((s) => s.id === shiftId) || shifts[0] || { id: "shift-1", name: "Shift", start: "06:00", end: "14:00", goal: 0 },
    [shifts, shiftId],
  );

  // Latest snapshots for the sync merges, without re-creating the merge callbacks
  // on every render.
  const stopsRef = useRef(stops); stopsRef.current = stops;
  const productionRef = useRef(production); productionRef.current = production;
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions;
  const operatorRef = useRef(operator); operatorRef.current = operator;
  const machineRef = useRef(machine); machineRef.current = machine;

  // ---- machine sessions lifecycle -------------------------------------------
  // The open session on THIS device lives in a ref (its id also persists in
  // device storage so a reload can close the dangling span). Presence tracking
  // is fire-and-forget: it must never block or error the operator flow, so no
  // sync.flush here — the next background flush picks the records up.
  const openSessRef = useRef(null);

  const closeSession = useCallback(async (endTs) => {
    const s = openSessRef.current;
    if (!s) return;
    openSessRef.current = null;
    const now = Date.now();
    const closed = { ...s, end: endTs ?? now, updatedAt: now };
    await api.saveSession(closed);
    await api.setCurrentSessionId(null);
    setSessions((prev) => prev.map((x) => (x.id === closed.id ? { ...closed, key: `sess:${closed.id}` } : x)));
  }, []);

  // Opens a presence span for `mach`. No-op without an operator name — idle
  // browsing on the default machine shouldn't produce "Unnamed" sessions.
  const openSession = useCallback(async (mach, opName) => {
    const name = (opName ?? operatorRef.current).trim();
    if (!name || !mach) return;
    const now = Date.now();
    const rec = {
      id: `${now}-${Math.floor(Math.random() * 1e6)}`, kind: "session",
      operator: name, machine: mach, start: now, end: null, loggedAt: now, updatedAt: now,
    };
    openSessRef.current = rec;
    await api.saveSession(rec);
    await api.setCurrentSessionId(rec.id);
    setSessions((prev) => [...prev, { ...rec, key: `sess:${rec.id}` }]);
  }, []);

  // One-tap machine switch: closes the current span, opens the next. All
  // machine changes from the operator UI route through here.
  const switchMachine = useCallback((next) => {
    if (next === machineRef.current) return;
    closeSession();
    openSession(next);
    setMachine(next);
  }, [closeSession, openSession]);

  // Heartbeat: bump the open session's updatedAt so a crash leaves a usable
  // "last seen" for the dangling-cleanup pass on the next load.
  useEffect(() => {
    const iv = setInterval(() => {
      const s = openSessRef.current;
      if (!s) return;
      s.updatedAt = Date.now();
      api.saveSession(s);
    }, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  // ---- initial load --------------------------------------------------------
  useEffect(() => {
    (async () => {
      const cfg = await api.loadConfig();
      if (cfg) {
        if (cfg.machines?.length) { setMachines(cfg.machines); setMachine(cfg.machines[0]); }
        if (cfg.reasons?.length) { setReasons(cfg.reasons); setReason(cfg.reasons[0]); }
        if (cfg.quickStops) setQuickStops(cfg.quickStops);
        { const ls = normalizeShifts(cfg.shifts, cfg.shift); if (ls) setShifts(ls); }
        if (cfg.supervisorPinHash) setSupervisorPinHash(cfg.supervisorPinHash);
        if (cfg.rates) setRates(cfg.rates);
        if (cfg.handoverEmails) setHandoverEmails(cfg.handoverEmails);
        if (cfg.updatedAt) setConfigUpdatedAt(cfg.updatedAt);
      }
      // Server sync config is device-local; loading it also flips the outbox gate.
      let sc = await api.loadSyncConfig();
      // Inside the native StopTrack app shell (Android WebView), auto-connect to
      // the built-in bridge — the phone companion's local sync server — so watch
      // stops and supervisor config sync with zero manual setup. The shell exposes
      // window.StopTrackNative.syncUrl(); outside the shell this is a no-op.
      const native = (typeof window !== "undefined") ? window.StopTrackNative : null;
      if (native && typeof native.syncUrl === "function") {
        try {
          const url = native.syncUrl();
          if (url) {
            const token = (typeof native.token === "function" ? native.token() : "") || "";
            sc = { url, token, enabled: true };
            await api.saveSyncConfig(sc);
          }
        } catch (e) { /* fall back to any saved config */ }
      }
      // Served straight FROM a StopTrack sync server ("supervisor anywhere"):
      // prefill the Server sync URL with this page's own origin so the
      // supervisor only enters the factory token. Probes /health to confirm the
      // origin really is a StopTrack server (a 401 also proves it — it means
      // "server here, token needed"). Never auto-enables, never overwrites a
      // saved config, and silently no-ops on Cloudflare Pages / file://.
      else if (!sc && typeof window !== "undefined" && /^https?:$/.test(window.location.protocol)) {
        const probe = await fetchJSON(`${window.location.origin}/health`, { timeoutMs: 2500 });
        if ((probe.ok && probe.data && probe.data.ok === true) || probe.status === 401) {
          sc = { url: window.location.origin, token: "", enabled: false };
          await api.saveSyncConfig(sc);
        }
      }
      if (sc) { setSyncCfg(sc); api.setSyncEnabled(!!(sc.enabled && sc.url)); }
      const prefs = await api.loadPrefs();
      if (prefs) {
        if (typeof prefs.dark === "boolean") setDark(prefs.dark);
        if (prefs.lastReason) setLastReason(prefs.lastReason);
        if (prefs.clearedBefore) setClearedBefore(prefs.clearedBefore);
        if (prefs.shiftId) setShiftId(prefs.shiftId);
        // Only a *locked* setup carries the name/machine across a refresh.
        // An unlocked session intentionally starts blank each load.
        if (prefs.setupLocked) {
          setSetupLocked(true);
          if (prefs.operator) setOperator(prefs.operator);
          if (prefs.machine) setMachine(prefs.machine);
        }
      }
      const result = await api.loadStops();
      setStops(result.stops);
      // Fresh/empty install (a newly downloaded file or re-signed APK starts
      // blank): offer to restore a backup rather than silently showing empty
      // settings. Only when there's truly nothing saved yet.
      if (!cfg && result.stops.length === 0) setNeedsRestore(true);
      const prod = await api.loadProduction();
      setProduction(prod.records);

      // Sessions: close the dangling span this device left behind (reload /
      // crash), and any stale open span with no heartbeat for 15+ minutes.
      const sess = await api.loadSessions();
      const curId = await api.getCurrentSessionId();
      const nowTs = Date.now();
      const STALE_MS = 15 * 60 * 1000;
      const records = [];
      for (const s of sess.records) {
        if (!s.end && (s.id === curId || nowTs - (s.updatedAt || s.start) > STALE_MS)) {
          const closed = { ...s, end: s.updatedAt || s.start, updatedAt: nowTs };
          await api.saveSession(closed);
          records.push({ ...closed, key: s.key });
        } else records.push(s);
      }
      await api.setCurrentSessionId(null);
      setSessions(records);
      setLoading(false);

      // A locked setup means "I'm working" — presence resumes on load.
      if (prefs && prefs.setupLocked && prefs.operator) {
        openSession(prefs.machine || (cfg?.machines?.[0]) || DEFAULT_MACHINES[0], prefs.operator);
      }

      const ip = await api.loadInProgress();
      if (ip && ip.startTs) setRecovered(ip);
    })();
  }, []);

  // Supervisor view polls for fresh data (other operators' stops on the same
  // device / shared scope). When server sync is on, the sync pull supersedes
  // this local re-read, so we skip it to avoid clobbering merged state.
  const refreshStops = useCallback(async () => {
    const result = await api.loadStops();
    setStops(result.stops);
  }, []);
  const syncOn = !!(syncCfg && syncCfg.enabled && syncCfg.url);
  useEffect(() => {
    if (view !== "supervisor" || syncOn) return;
    const iv = setInterval(refreshStops, 5000);
    return () => clearInterval(iv);
  }, [view, refreshStops, syncOn]);

  // ---- sync merge callbacks -----------------------------------------------
  // Merge server records into local state + storage, last-write-wins by stamp.
  const applyRemoteStops = useCallback(async (incoming) => {
    const map = new Map(stopsRef.current.map((s) => [s.id, s]));
    const writes = [];
    for (const r of incoming) {
      const local = map.get(r.id);
      if (!local || stampOf(r) > stampOf(local)) {
        const rec = { ...r, key: `stop:${r.id}` };
        map.set(r.id, rec);
        writes.push(rec);
      }
    }
    if (!writes.length) return;
    await Promise.all(writes.map((w) => api.putLocal(w)));
    setStops([...map.values()].sort((a, b) => b.start - a.start));
  }, []);

  // Merge server production records, same LWW rule as stops.
  const applyRemoteProduction = useCallback(async (incoming) => {
    const map = new Map(productionRef.current.map((p) => [p.id, p]));
    const writes = [];
    for (const r of incoming) {
      const local = map.get(r.id);
      if (!local || stampOf(r) > stampOf(local)) {
        const rec = { ...r, key: `prod:${r.id}` };
        map.set(r.id, rec);
        writes.push(rec);
      }
    }
    if (!writes.length) return;
    await Promise.all(writes.map((w) => api.putLocal(w)));
    setProduction([...map.values()]);
  }, []);

  // Merge server session records, same LWW rule as stops/production. Never
  // clobbers this device's open session (it's newer by heartbeat anyway).
  const applyRemoteSessions = useCallback(async (incoming) => {
    const map = new Map(sessionsRef.current.map((s) => [s.id, s]));
    const writes = [];
    for (const r of incoming) {
      const local = map.get(r.id);
      if (!local || stampOf(r) > stampOf(local)) {
        const rec = { ...r, key: `sess:${r.id}` };
        map.set(r.id, rec);
        writes.push(rec);
      }
    }
    if (!writes.length) return;
    await Promise.all(writes.map((w) => api.putLocal(w)));
    setSessions([...map.values()]);
  }, []);

  // Apply a newer shared config pulled from the server (keeps its updatedAt).
  const applyRemoteConfig = useCallback((cfg) => {
    if (cfg.machines?.length) setMachines(cfg.machines);
    if (cfg.reasons?.length) setReasons(cfg.reasons);
    if (cfg.quickStops) setQuickStops(cfg.quickStops);
    { const ls = normalizeShifts(cfg.shifts, cfg.shift); if (ls) setShifts(ls); }
    setSupervisorPinHash(cfg.supervisorPinHash ?? null);
    if (cfg.rates) setRates(cfg.rates);
    if (cfg.handoverEmails) setHandoverEmails(cfg.handoverEmails);
    setConfigUpdatedAt(cfg.updatedAt || Date.now());
    api.saveConfig(cfg);
  }, []);

  const localConfig = useMemo(
    () => ({ machines, reasons, quickStops, shifts, shift: legacyShiftOf(shifts), supervisorPinHash, rates, handoverEmails, updatedAt: configUpdatedAt }),
    [machines, reasons, quickStops, shifts, supervisorPinHash, rates, handoverEmails, configUpdatedAt],
  );

  const sync = useSync({ cfg: syncCfg, onRemoteStops: applyRemoteStops, onRemoteProduction: applyRemoteProduction, onRemoteSessions: applyRemoteSessions, localConfig, onRemoteConfig: applyRemoteConfig });

  // Change device-local sync config. On first enable, seed the outbox with all
  // existing stops so history uploads, not just future changes.
  const updateSyncConfig = useCallback(async (next) => {
    await api.saveSyncConfig(next);
    if (next.enabled && next.url) {
      const cursor = await api.getCursor();
      if (!cursor) await api.seedOutboxWithAll();
    }
    setSyncCfg(next);
  }, []);

  // Keep selected machine / reason valid if the lists change.
  useEffect(() => { if (machines.length && !machines.includes(machine)) setMachine(machines[0]); }, [machines, machine]);
  useEffect(() => { if (reasons.length && !reasons.includes(reason)) setReason(reasons[0]); }, [reasons, reason]);

  // In the shell, when the native timer hands back a stop awaiting a reason, seed
  // the reason picker exactly like handleStop does in the browser.
  const nativePendingActive = !!nativePending;
  useEffect(() => {
    if (inShell && nativePendingActive) {
      setReason(lastReason && reasons.includes(lastReason) ? lastReason : reasons[0]);
      setNotes(""); setSaveError("");
    }
  }, [inShell, nativePendingActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- config + prefs writers ---------------------------------------------
  // Shared config carries an updatedAt so config sync can resolve LWW. Bumped on
  // every edit; the new value is returned so callers can push it immediately.
  const persistConfig = useCallback((patch) => {
    const updatedAt = Date.now();
    const merged = { machines, reasons, quickStops, shifts, supervisorPinHash, rates, handoverEmails, ...patch };
    // Keep the legacy single `shift` mirror in step with `shifts` for older
    // clients / the watch config (which reads only {start,end}).
    const next = { ...merged, shift: legacyShiftOf(merged.shifts), updatedAt };
    setConfigUpdatedAt(updatedAt);
    api.saveConfig(next);
    if (syncCfg && syncCfg.enabled && syncCfg.url) api.remotePutConfig(next, syncCfg);
    return next;
  }, [machines, reasons, quickStops, shifts, supervisorPinHash, rates, handoverEmails, syncCfg]);

  const persistPrefs = useCallback((patch) => {
    // operator/machine/setupLocked are persisted so a locked setup survives a
    // page refresh. When unlocked we still write them, but the loader ignores
    // operator/machine unless setupLocked is true.
    api.savePrefs({ dark, lastReason, clearedBefore, operator, machine, setupLocked, shiftId, ...patch });
  }, [dark, lastReason, clearedBefore, operator, machine, setupLocked, shiftId]);

  const updateMachines = (next) => { setMachines(next); persistConfig({ machines: next }); };
  const updateReasons = (next) => { setReasons(next); persistConfig({ reasons: next }); };
  const updateQuickStops = (next) => { setQuickStops(next); persistConfig({ quickStops: next }); };
  const updateShifts = (next) => { setShifts(next); persistConfig({ shifts: next }); };
  const selectShift = (id) => { setShiftId(id); persistPrefs({ shiftId: id }); };
  const updateRates = (next) => { setRates(next); persistConfig({ rates: next }); };
  const updateHandoverEmails = (next) => { setHandoverEmails(next); persistConfig({ handoverEmails: next }); };
  const toggleDark = () => { const n = !dark; setDark(n); persistPrefs({ dark: n }); };

  // ---- backup / restore ----------------------------------------------------
  // Download one portable JSON of everything, so it can be re-imported into a
  // freshly downloaded app (new file = empty storage) or a reinstalled APK.
  const downloadBackup = async () => {
    try {
      const data = await api.exportAll();
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      downloadFile(JSON.stringify(data), `stoptrack-backup-${stamp}.json`, "application/json");
      setRestoreMsg("");
    } catch (e) {
      setRestoreMsg("Couldn't create the backup. Try again.");
    }
  };
  const pickRestore = () => { setRestoreMsg(""); restoreInputRef.current && restoreInputRef.current.click(); };
  const handleRestoreFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await api.importAll(data);
      // Reload so every view re-reads the restored data from storage.
      if (typeof window !== "undefined" && window.location && window.location.reload) window.location.reload();
    } catch (err) {
      setRestoreMsg((err && err.message) || "Couldn't read that backup file.");
    }
  };

  // Set / change / clear the supervisor PIN. `pin` = null clears the gate.
  // Returns false if the current PIN is required but doesn't match.
  const updatePin = useCallback(async (pin, currentPin) => {
    if (supervisorPinHash) {
      const curHash = await sha256Hex(currentPin || "");
      if (curHash !== supervisorPinHash) return false;
    }
    const hash = pin ? await sha256Hex(pin) : null;
    setSupervisorPinHash(hash);
    persistConfig({ supervisorPinHash: hash });
    return true;
  }, [supervisorPinHash, persistConfig]);

  // ---- stop lifecycle ------------------------------------------------------
  const handleStop = () => {
    // In the shell End goes to native, which stashes the finished stop and pushes
    // it back as `nativePending` — the reason picker then shows via the same UI.
    if (inShell) { try { nativeApi.endStop(); } catch (e) { /* ignore */ } return; }
    const finished = timer.stop();
    setPendingStop(finished);
    setReason(lastReason && reasons.includes(lastReason) ? lastReason : reasons[0]);
    setNotes("");
    setSaveError("");
  };

  const handleSave = async () => {
    // Shell: hand the chosen reason to native, which records the stop (it then
    // syncs back into the web store via the local server) and clears the pending.
    if (inShell) {
      if (!nativePending) return;
      setSaving(true); setSaveError("");
      try { nativeApi.documentStop(reason, notes.trim()); } catch (e) { /* ignore */ }
      setLastReason(reason); persistPrefs({ lastReason: reason });
      sync.flush();
      setSaving(false);
      return;
    }
    if (!pendingStop) return;
    setSaving(true); setSaveError("");
    const id = `${pendingStop.start}-${Math.floor(Math.random() * 1e6)}`;
    const record = {
      id,
      machine: pendingStop.machine || machine, // pinned at Start; falls back for old recoveries
      operator: operator.trim() || "Unnamed",
      start: pendingStop.start, end: pendingStop.end, duration: pendingStop.duration,
      reason, notes: notes.trim(), discarded: false,
      loggedAt: Date.now(), // when the record was created; drives shift membership
      updatedAt: Date.now(), // last-write-wins clock for sync
    };
    const res = await api.saveStop(record);
    if (res.ok) {
      setStops((prev) => [record, ...prev]);
      setLastReason(reason); persistPrefs({ lastReason: reason });
      setPendingStop(null);
      sync.flush();
    } else {
      setSaveError(res.error || "The stop didn't save. Try again.");
    }
    setSaving(false);
  };

  const handleDiscardPending = () => {
    if (inShell) { try { nativeApi.discardStop(); } catch (e) { /* ignore */ } setSaveError(""); return; }
    setPendingStop(null); setSaveError("");
  };

  const applyQuickStop = (q) => {
    if (reasons.includes(q.reason)) setReason(q.reason);
    if (q.notes) setNotes(q.notes);
  };

  // ---- setup lock (locks the NAME; machine stays one-tap switchable) -------
  // Locking is the "I'm working" signal, so it also opens a presence session.
  // If one is already open under a different name (name edited while unlocked),
  // re-key it by close-and-reopen.
  const lockSetup = () => {
    setSetupLocked(true);
    persistPrefs({ setupLocked: true, operator, machine });
    const open = openSessRef.current;
    if (!open) openSession(machine, operator);
    else if (open.operator !== operator.trim()) { closeSession(); openSession(machine, operator); }
  };
  const unlockSetup = () => { setSetupLocked(false); persistPrefs({ setupLocked: false }); };

  // ---- manual stop report --------------------------------------------------
  // Logs a stop that already happened, entered by duration. End time is "now",
  // start is back-dated by the duration. `loggedAt` is when the operator saved
  // it, so it counts toward the CURRENT shift even though `start` is back-dated
  // (which otherwise could fall before the New Shift cutoff and get hidden).
  const handleManualSave = async ({ durationMs, reason: mReason, notes: mNotes, machine: mMachine }) => {
    setSaving(true); setSaveError("");
    const end = Date.now();
    const start = end - durationMs;
    const id = `${start}-${Math.floor(Math.random() * 1e6)}`;
    const record = {
      id,
      machine: mMachine || machine, // modal lets a roaming operator pick another machine
      operator: operator.trim() || "Unnamed",
      start, end, duration: durationMs,
      reason: mReason, notes: (mNotes || "").trim(), manual: true, discarded: false,
      loggedAt: end, // recorded now → belongs to the current shift
      updatedAt: end, // last-write-wins clock for sync
    };
    const res = await api.saveStop(record);
    if (res.ok) {
      setStops((prev) => [record, ...prev]);
      setLastReason(mReason); persistPrefs({ lastReason: mReason });
      setManualOpen(false);
      sync.flush();
    } else {
      setSaveError(res.error || "The stop didn't save. Try again.");
    }
    setSaving(false);
    return res.ok;
  };

  // ---- shift output (production for OEE) -----------------------------------
  // One record per (machine, shift, operator), upserted — re-entering counts
  // updates the same row rather than stacking duplicates.
  const handleSaveProduction = async ({ unitsProduced, scrapCount }) => {
    const now = Date.now();
    const op = operator.trim() || "Unnamed";
    const id = `${machineSlug(machine)}|${clearedBefore}|${op}`;
    const record = {
      id, kind: "production", machine, operator: op,
      shiftStart: clearedBefore,
      unitsProduced: Math.max(0, Math.floor(Number(unitsProduced) || 0)),
      scrapCount: Math.max(0, Math.floor(Number(scrapCount) || 0)),
      loggedAt: now, updatedAt: now,
    };
    const res = await api.saveProduction(record);
    if (res.ok) {
      setProduction((prev) => {
        const rest = prev.filter((p) => p.id !== id);
        return [...rest, { ...record, key: `prod:${id}` }];
      });
      sync.flush();
    }
    return res;
  };

  // The operator's own production entry for the current shift + machine.
  const myProduction = useMemo(() => {
    const op = operator.trim() || "Unnamed";
    return production.find((p) => p.id === `${machineSlug(machine)}|${clearedBefore}|${op}`) || null;
  }, [production, machine, clearedBefore, operator]);

  // ---- recovery ------------------------------------------------------------
  const recoverResume = () => {
    const d = recovered;
    const mach = machines.includes(d.machine) ? d.machine : machines[0];
    setOperator(d.operator || "");
    setMachine(mach);
    timer.restore(d);
    setRecovered(null);
    // Resuming work is presence too (no-op if a session is already open).
    if (!openSessRef.current) openSession(mach, d.operator || "");
  };
  const recoverFinalize = () => {
    const d = recovered;
    // If the app closed while paused (or mid-pause with no live segment), the
    // banked `accumulated` is the whole duration. Otherwise add the last live
    // segment up to the final autosave. Clamp so a stale/odd timestamp can
    // never yield a negative or NaN duration.
    const banked = Math.max(0, d.accumulated || 0);
    const liveSeg = (d.paused || !d.segStart) ? 0 : Math.max(0, (d.savedAt || d.segStart) - d.segStart);
    const dur = banked + liveSeg;
    setOperator(d.operator || "");
    setMachine(machines.includes(d.machine) ? d.machine : machines[0]);
    setPendingStop({ start: d.startTs, end: d.savedAt, duration: dur, machine: d.machine });
    setReason(lastReason && reasons.includes(lastReason) ? lastReason : reasons[0]);
    setNotes("");
    setRecovered(null);
    api.clearInProgress();
  };
  const recoverDiscard = () => { setRecovered(null); api.clearInProgress(); };

  // ---- supervisor: discard (soft, recoverable, kept in CSV) ---------------
  const discardStop = async (stop, explanation) => {
    const now = Date.now();
    const updated = { ...stop, discarded: true, discardReason: explanation, discardedAt: now, updatedAt: now };
    const res = await api.updateStop(updated);
    if (res.ok) { setStops((prev) => prev.map((s) => (s.id === stop.id ? updated : s))); sync.flush(); }
    return res.ok;
  };

  // ---- supervisor: permanent delete (writes a tombstone that syncs, then
  // auto-purges after 60 days). Kept in state as a tombstone so it disappears
  // from every view via the !s.deleted filters. -----------------------------
  const deleteStop = async (stop) => {
    const res = await api.deleteStop(stop);
    if (res.ok) { setStops((prev) => prev.map((s) => (s.id === stop.id ? { ...s, ...res.tombstone } : s))); sync.flush(); }
    return res.ok;
  };

  // ---- "New Shift" — hides current stops from view without deleting them ---
  // Sets the clearedBefore cutoff so logged stops drop out of the operator's
  // live list for a fresh shift. Records stay in storage and remain visible in
  // the supervisor view and in CSV/JSON exports.
  const startNewShift = () => {
    const cutoff = Date.now();
    setClearedBefore(cutoff);
    setShowAll(false); // a new shift starts in the hidden (fresh) view
    persistPrefs({ clearedBefore: cutoff });
    setNewShiftOpen(false);
    // Split presence at the shift boundary so manned time lands in one shift.
    if (openSessRef.current) { closeSession(cutoff); openSession(machine); }
  };
  // "Show all" / "Hide again" toggles the reveal without touching the cutoff,
  // so the operator can always return to the fresh-shift view.
  const toggleShowAll = () => setShowAll((v) => !v);

  // Visible-to-operator stops: their own, not discarded. Shift membership uses
  // when the stop was logged (loggedAt), not its start — so a manual stop with a
  // back-dated start still counts toward the shift it was entered in. Falls back
  // to end/start for records saved before loggedAt existed.
  const myStops = useMemo(() => stops.filter((s) => {
    const stamp = s.loggedAt ?? s.end ?? s.start;
    return (!operator.trim() || s.operator === operator.trim()) && !s.discarded && !s.deleted &&
      (showAll || stamp > clearedBefore);
  }), [stops, operator, clearedBefore, showAll]);

  // Slow tick so the open session's manned time (and the OEE built on it)
  // stays current even when nothing else re-renders.
  const [slowTick, setSlowTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setSlowTick((n) => n + 1), 30000);
    return () => clearInterval(iv);
  }, []);

  // ---- shift-wide operator picture (roaming-aware OEE) ----------------------
  // Manned time per machine comes from this operator's sessions clipped to the
  // shift window; downtime from their stops; units/scrap from their production
  // records. Performance is judged against time actually AT each machine, not
  // the whole shift — the honest denominator for an operator who roams.
  const myShift = useMemo(() => {
    const op = operator.trim() || "Unnamed";
    const now = Date.now();
    const winStart = clearedBefore || 0;

    const bag = {}; // machine -> { mannedMs, downtimeMs, stops, units, scrap }
    const entry = (m) => (bag[m] = bag[m] || { machine: m, mannedMs: 0, downtimeMs: 0, stops: 0, units: 0, scrap: 0 });

    for (const s of sessions) {
      if (s.operator !== op) continue;
      const end = Math.min(s.end ?? now, now);
      const start = Math.max(s.start, winStart);
      if (end > start) entry(s.machine).mannedMs += end - start;
    }
    for (const s of myStops) { const e = entry(s.machine); e.downtimeMs += s.duration; e.stops += 1; }
    for (const p of production) {
      if (p.operator !== op || p.shiftStart !== clearedBefore) continue;
      const e = entry(p.machine); e.units += p.unitsProduced || 0; e.scrap += p.scrapCount || 0;
    }

    const rows = Object.values(bag);
    const hasSessions = rows.some((r) => r.mannedMs > 0);

    let overall;
    if (hasSessions) {
      let planned = 0, down = 0, units = 0, scrap = 0, theoretical = 0;
      for (const r of rows) {
        const plannedM = r.mannedMs; // manned time is the plan for a roamer
        const downM = Math.min(r.downtimeMs, plannedM || r.downtimeMs);
        planned += plannedM; down += downM; units += r.units; scrap += r.scrap;
        const rate = rates?.[r.machine];
        if (rate && plannedM > 0) theoretical += rate * (Math.max(0, plannedM - downM) / HOUR_MS);
        r.oee = computeOEE({ plannedMs: plannedM, downtimeMs: r.downtimeMs, unitsProduced: r.units, scrapCount: r.scrap, ratePerHour: rate });
      }
      overall = computeOEE({ plannedMs: planned, downtimeMs: down, unitsProduced: units, scrapCount: scrap, ratePerHour: 0 });
      if (theoretical > 0) {
        overall.p = Math.min(1, Math.max(0, units / theoretical));
        const fs = [overall.a, overall.p, overall.q].filter((f) => f != null);
        overall.oee = fs.length ? fs.reduce((x, y) => x * y, 1) : null;
        overall.partial = overall.a == null || overall.p == null || overall.q == null;
      }
    } else {
      // No presence data (old records / name not set) — fall back to the
      // single-machine framing against the configured shift length.
      const downtimeMs = myStops.reduce((a, s) => a + s.duration, 0);
      overall = computeOEE({
        plannedMs: shiftLengthMs(activeShift), downtimeMs,
        unitsProduced: myProduction?.unitsProduced, scrapCount: myProduction?.scrapCount,
        ratePerHour: rates?.[machine],
      });
    }
    rows.sort((a, b) => b.mannedMs - a.mannedMs);
    return { rows, overall, hasSessions };
  }, [sessions, myStops, production, rates, activeShift, clearedBefore, operator, machine, myProduction, slowTick]);

  // ---- shift output goal (achievability) -----------------------------------
  // Per-machine: the current machine's units produced this shift vs that
  // machine's goal, projected against its rate and time left in the shift.
  const goalStatus = useMemo(() => {
    const goal = activeShift.goals?.[machine] || 0;
    const produced = myShift.rows.find((r) => r.machine === machine)?.units || 0;
    return computeGoalStatus({
      goal, produced, machine,
      ratePerHour: rates?.[machine], shiftEndMs: shiftEndAt(activeShift), now: Date.now(),
    });
  }, [myShift, activeShift, rates, machine, slowTick]);

  // In the shell the operator timer is a view over the native timer: display from
  // the pushed state, buttons drive native. In a browser it's the local useTimer.
  const effectivePending = inShell ? nativePending : pendingStop;
  const effectiveTimer = inShell ? {
    state: nativeTimer || emptyTimer,
    elapsed: nativeElapsed(nativeTimer, nowTick),
    start: () => { try { nativeApi.startStop(machine); } catch (e) { /* ignore */ } },
    pause: () => { try { nativeApi.pauseStop(); } catch (e) { /* ignore */ } },
    resume: () => { try { nativeApi.resumeStop(); } catch (e) { /* ignore */ } },
  } : timer;

  return (
    <div className={`min-h-screen ${t.app} transition-colors`}>
      <header className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className="bg-emerald-500/20 rounded-lg p-1.5"><Factory size={20} className="text-emerald-400" /></div>
          <div>
            <h1 className="font-bold text-lg leading-none">StopTrack</h1>
            <span className="text-[10px] text-slate-400 uppercase tracking-wide">Machine downtime</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggleDark} className="p-2 text-slate-300 hover:text-white" title="Toggle theme" aria-label="Toggle theme">
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <div className="flex bg-slate-700 rounded-lg p-1 text-sm">
            {/* Leaving the supervisor view re-locks it, so the PIN is asked again next time. */}
            <button onClick={() => { setView("operator"); setSupervisorUnlocked(false); }} className={`px-3 py-1.5 rounded-md transition ${view === "operator" ? "bg-emerald-500 text-white font-semibold" : "text-slate-300"}`}>Operator</button>
            <button onClick={() => setView("supervisor")} className={`px-3 py-1.5 rounded-md flex items-center gap-1 transition ${view === "supervisor" ? "bg-emerald-500 text-white font-semibold" : "text-slate-300"}`}>{supervisorPinHash && <Lock size={12} />} Supervisor</button>
          </div>
        </div>
      </header>

      {/* Hidden picker used by both the recovery banner and Supervisor settings. */}
      <input ref={restoreInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleRestoreFile} />

      {/* Recovery banner on an empty install — turns a silent wipe into one tap. */}
      {needsRestore && (
        <div className="bg-amber-500/15 border-b border-amber-500/40 px-4 py-2.5">
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-3 flex-wrap">
            <span className="text-sm">
              <b>Fresh install?</b> Restore your machines, shifts &amp; stops from a backup file.
            </span>
            <div className="flex items-center gap-2">
              <button onClick={pickRestore} className="bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold px-3 py-1.5 rounded-lg">Restore backup</button>
              <button onClick={() => setNeedsRestore(false)} className={`text-sm ${t.sub} px-2 py-1.5`}>Not now</button>
            </div>
          </div>
          {restoreMsg && <p className="max-w-3xl mx-auto text-xs text-red-500 mt-1">{restoreMsg}</p>}
        </div>
      )}

      <main className="max-w-3xl mx-auto p-4 pb-24">
        {view === "operator" ? (
          <OperatorView
            t={t} operator={operator} setOperator={setOperator} machine={machine} setMachine={switchMachine}
            timer={effectiveTimer} onStop={handleStop}
            pendingStop={effectivePending} reason={reason} setReason={setReason} notes={notes} setNotes={setNotes}
            onSave={handleSave} onDiscardPending={handleDiscardPending} saving={saving} saveError={saveError}
            myStops={myStops} machines={machines} reasons={reasons} quickStops={quickStops}
            applyQuickStop={applyQuickStop} lastReason={lastReason}
            shift={activeShift} shifts={shifts} shiftId={shiftId} onSelectShift={selectShift}
            clearedBefore={clearedBefore} onNewShift={() => setNewShiftOpen(true)} showAll={showAll} onToggleShowAll={toggleShowAll}
            setupLocked={setupLocked} onLockSetup={lockSetup} onUnlockSetup={unlockSetup}
            onOpenManual={() => { setSaveError(""); setManualOpen(true); }}
            syncStatus={sync.status} syncOn={syncOn}
            rates={rates} myProduction={myProduction} onSaveProduction={handleSaveProduction}
            myShift={myShift} goalStatus={goalStatus}
            onOpenHandover={() => setHandoverOpen(true)}
          />
        ) : (supervisorPinHash && !supervisorUnlocked) ? (
          <PinGate t={t} pinHash={supervisorPinHash} onUnlock={() => setSupervisorUnlocked(true)} />
        ) : (
          <SupervisorView
            t={t} stops={stops} loading={loading} onRefresh={refreshStops}
            machines={machines} reasons={reasons} quickStops={quickStops} shifts={shifts}
            updateMachines={updateMachines} updateReasons={updateReasons} updateQuickStops={updateQuickStops}
            updateShifts={updateShifts} discardStop={discardStop} deleteStop={deleteStop}
            hasPin={!!supervisorPinHash} updatePin={updatePin}
            syncCfg={syncCfg} updateSyncConfig={updateSyncConfig} syncStatus={sync.status} onSyncNow={sync.flush}
            rates={rates} updateRates={updateRates} production={production} sessions={sessions}
            handoverEmails={handoverEmails} updateHandoverEmails={updateHandoverEmails}
            onDownloadBackup={downloadBackup} onRestore={pickRestore} restoreMsg={restoreMsg}
          />
        )}
      </main>

      {recovered && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-30">
          <div className={`${dark ? "bg-slate-900" : "bg-white"} rounded-xl shadow-xl p-5 max-w-sm w-full space-y-3`}>
            <div className="flex items-center gap-2 font-bold"><RotateCcw size={18} className="text-amber-500" /> Unfinished stop found</div>
            <p className={`text-sm ${t.sub}`}>A stop on <b>{recovered.machine || "a machine"}</b> started {fmtTime(recovered.startTs)} was still running when the app closed.</p>
            <div className="flex flex-col gap-2">
              <button onClick={recoverResume} className="bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-3 rounded-lg">Resume timing</button>
              <button onClick={recoverFinalize} className="bg-slate-700 hover:bg-slate-800 text-white font-bold py-3 rounded-lg">Finalize &amp; document now</button>
              <button onClick={recoverDiscard} className={`${t.sub} hover:text-red-500 font-semibold py-1`}>Discard it</button>
            </div>
          </div>
        </div>
      )}

      {newShiftOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-30" onClick={() => setNewShiftOpen(false)}>
          <div className={`${dark ? "bg-slate-900" : "bg-white"} rounded-xl shadow-xl p-5 max-w-sm w-full space-y-3`} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 font-bold"><Sparkles size={18} className="text-emerald-500" /> Start a new shift?</div>
            <p className={`text-sm ${t.sub}`}>This will hide all current stops from view for the new shift. Data remains saved and can still be viewed by the supervisor and exported.</p>
            <div className="flex gap-2">
              <button onClick={startNewShift} className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-3 rounded-lg">Start new shift</button>
              <button onClick={() => setNewShiftOpen(false)} className={`px-4 ${t.sub} font-semibold`}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {manualOpen && (
        <ManualStopModal
          t={t} dark={dark} machine={machine} machines={machines} reasons={reasons} quickStops={quickStops}
          lastReason={lastReason} saving={saving} saveError={saveError}
          onSave={handleManualSave} onClose={() => setManualOpen(false)}
        />
      )}

      {handoverOpen && (
        <ShiftHandoverModal
          t={t} dark={dark}
          report={buildShiftReport({ operator, machine, myStops, myShift, clearedBefore, activeShift, goalStatus })}
          handoverEmails={handoverEmails} syncCfg={syncCfg}
          onClose={() => setHandoverOpen(false)}
        />
      )}
    </div>
  );
}

/* ============================================================================
   OPERATOR VIEW
   ========================================================================== */
function OperatorView(props) {
  const {
    t, operator, setOperator, machine, setMachine, timer, onStop,
    pendingStop, reason, setReason, notes, setNotes, onSave, onDiscardPending, saving, saveError,
    myStops, machines, reasons, quickStops, applyQuickStop, lastReason,
    shift, shifts, shiftId, onSelectShift, clearedBefore, onNewShift, showAll, onToggleShowAll,
    setupLocked, onLockSetup, onUnlockSetup, onOpenManual,
    syncStatus, syncOn,
    rates, myProduction, onSaveProduction, myShift, goalStatus, onOpenHandover,
  } = props;

  const { state, elapsed, start, pause, resume } = timer;
  const { running, paused } = state;

  // ---- current-shift stats (from myStops: own, non-discarded, since New Shift) --
  // Total downtime shown on the current board.
  const downtimeMs = useMemo(() => myStops.reduce((a, s) => a + s.duration, 0), [myStops]);
  // Stops in the last hour.
  const lastHourCount = useMemo(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return myStops.filter((s) => s.end > cutoff).length;
  }, [myStops]);
  // Shift-wide OEE (all machines worked, manned-time denominators) from App.
  const oee = myShift.overall;
  // Downtime grouped by reason, largest first.
  const byReason = useMemo(() => {
    const map = {};
    myStops.forEach((s) => { map[s.reason] = (map[s.reason] || 0) + s.duration; });
    const list = Object.entries(map).sort((a, b) => b[1] - a[1]);
    return { list, max: list[0]?.[1] || 1 };
  }, [myStops]);

  const canLock = operator.trim().length > 0; // need a name before locking

  return (
    <div className="space-y-4">
      {/* current-shift stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard t={t} label="Stops" value={myStops.length} icon={<List size={16} />} />
        <StatCard t={t} label="Downtime" value={fmtDur(downtimeMs)} icon={<Clock size={16} />} />
        <StatCard t={t} label="Last Hour" value={lastHourCount} icon={<AlertCircle size={16} />} />
        <StatCard t={t} label={oee.partial ? "OEE (partial)" : "OEE"} value={pct(oee.oee)} icon={<TrendingUp size={16} />}
          accent={oeeAccent(oee.oee)} />
      </div>
      {/* A / P / Q factor breakdown for the OEE card */}
      <div className={`text-[11px] ${t.sub} text-center -mt-2`}>
        Availability {pct(oee.a)} · Performance {pct(oee.p)} · Quality {pct(oee.q)}
        {oee.p == null && " — set a machine rate in Supervisor → Settings"}
        {oee.p != null && oee.q == null && " — enter shift output below"}
      </div>

      {/* shift output goal — is it still reachable given downtime so far? */}
      {goalStatus && goalStatus.state !== "na" && (
        <div className={`${t.card} rounded-xl px-4 py-3 flex items-center justify-between gap-3`}>
          <div className="flex items-center gap-2 min-w-0">
            <Target size={18} className={goalAccent(goalStatus.state)} />
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                {goalStatus.state === "met" ? "Goal met"
                  : goalStatus.state === "missed" ? "Goal not achievable"
                  : goalStatus.state === "risk" ? "Goal at risk" : "On track for goal"}
                <span className={`font-normal ${t.sub}`}> · {machine}</span>
              </div>
              <div className={`text-[11px] ${t.sub}`}>
                {goalStatus.produced} / {goalStatus.goal} units
                {(goalStatus.state === "track" || goalStatus.state === "risk") && goalStatus.slackMs != null
                  && ` · up to ${fmtDur(goalStatus.slackMs)} more downtime OK`}
                {goalStatus.state === "missed" && ` · short by ${goalStatus.need} (need ${goalStatus.need}, time's too short)`}
              </div>
            </div>
          </div>
          <div className={`text-right font-bold ${goalAccent(goalStatus.state)}`}>
            {Math.min(999, Math.round((goalStatus.produced / Math.max(1, goalStatus.goal)) * 100))}%
          </div>
        </div>
      )}

      {/* machines worked this shift (only interesting once roaming) */}
      {myShift.hasSessions && myShift.rows.length > 0 && (
        <div className="flex flex-wrap gap-1.5 justify-center -mt-1">
          {myShift.rows.map((r) => (
            <span key={r.machine} className={`${t.chip} rounded-full px-3 py-1 text-[11px]`}>
              <span className="font-semibold">{r.machine}</span>
              {" · "}{fmtDur(r.mannedMs)}
              {r.stops > 0 && <> · {r.stops} stop{r.stops === 1 ? "" : "s"} · <span className="text-red-500 font-mono">{fmtDur(r.downtimeMs)}</span></>}
            </span>
          ))}
        </div>
      )}

      {/* operator (lockable) + one-tap machine switcher */}
      <div className={`${t.card} rounded-xl p-4 space-y-3`}>
        <label className="flex flex-col gap-1">
          <span className={`text-xs font-semibold ${t.sub} flex items-center gap-1`}><User size={13} /> OPERATOR</span>
          <input value={operator} maxLength={40} disabled={setupLocked} onChange={(e) => setOperator(e.target.value)} placeholder="Your name"
            className={`border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:opacity-70 disabled:cursor-not-allowed ${t.input}`} />
        </label>
        <div className="flex flex-col gap-1">
          <span className={`text-xs font-semibold ${t.sub} flex items-center gap-1`}><Factory size={13} /> MACHINE — tap to switch</span>
          {machines.length <= 8 ? (
            <div className="flex flex-wrap gap-1.5">
              {machines.map((m) => {
                const activeChip = m === machine;
                const timingHere = (running || paused) && state.machine === m;
                return (
                  <button key={m} onClick={() => setMachine(m)}
                    className={`relative px-3 py-2.5 rounded-lg text-sm font-semibold transition active:scale-95 ${activeChip ? "bg-emerald-500 text-white shadow" : t.chip}`}>
                    {m}
                    {timingHere && <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" title="Stop being timed here" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <select value={machine} onChange={(e) => setMachine(e.target.value)}
              className={`border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`}>
              {machines.map((m) => <option key={m}>{m}</option>)}
            </select>
          )}
        </div>
        {shifts && shifts.length > 1 && (
          <div className="flex flex-col gap-1">
            <span className={`text-xs font-semibold ${t.sub} flex items-center gap-1`}><Clock size={13} /> SHIFT — tap to switch</span>
            <div className="flex flex-wrap gap-1.5">
              {shifts.map((s) => (
                <button key={s.id} onClick={() => onSelectShift(s.id)}
                  className={`px-3 py-2 rounded-lg text-sm font-semibold transition active:scale-95 ${s.id === shiftId ? "bg-emerald-500 text-white shadow" : t.chip}`}>
                  {s.name} <span className="opacity-70 font-normal">{s.start}–{s.end}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!setupLocked ? (
          <button onClick={onLockSetup} disabled={!canLock}
            className={`w-full flex items-center justify-center gap-2 font-bold py-2.5 rounded-lg transition ${canLock ? "bg-slate-800 hover:bg-slate-900 text-white" : `${t.muted} ${t.sub} cursor-not-allowed`}`}>
            <Lock size={16} /> Lock name
          </button>
        ) : (
          <button onClick={onUnlockSetup}
            className="w-full flex items-center justify-center gap-2 font-bold py-2.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition">
            <Unlock size={16} /> Unlock name
          </button>
        )}
        {setupLocked && <p className={`text-[11px] ${t.sub} text-center`}>Name is locked and survives a refresh. Switching machines stays one tap — it never needs unlocking.</p>}
      </div>

      {/* storage status — only shown when data won't persist or won't sync.
          Server sync fixes the "device only" case, so suppress that note when on. */}
      {(!STORAGE_INFO.persistent || (!STORAGE_INFO.shared && !syncOn)) && (
        <div className={`text-xs rounded-lg px-3 py-2 flex items-center gap-2 ${STORAGE_INFO.persistent ? "bg-amber-500/10 text-amber-600" : "bg-red-500/10 text-red-600"}`}>
          <AlertCircle size={14} />
          {STORAGE_INFO.persistent
            ? "Stops are saved on this device only — turn on Server sync (Supervisor → Settings) to share with the supervisor."
            : "Storage is unavailable, so stops are kept only until you close this tab. Export before leaving."}
        </div>
      )}

      {/* server-sync status — only shown when sync is configured */}
      {syncOn && <SyncStatusBadge t={t} status={syncStatus} />}

      {/* timer */}
      <div className={`${t.card} rounded-xl p-6 flex flex-col items-center`}>

        <div className={`text-xs font-semibold tracking-wide ${t.sub} mb-1`}>
          {paused ? `PAUSED — ${state.machine || machine}` : running ? `${(state.machine || machine).toUpperCase()} STOPPED — TIMING` : "READY"}
        </div>
        <div className={`text-6xl font-mono font-bold mb-5 tabular-nums ${paused ? "text-amber-500" : running ? "text-red-500" : t.sub}`}>
          {fmtClock(elapsed)}
        </div>
        {!running ? (
          <button onClick={start} disabled={!!pendingStop}
            className="flex items-center gap-2 bg-red-500 hover:bg-red-600 disabled:opacity-40 text-white font-bold text-lg px-12 py-5 rounded-full shadow-lg transition active:scale-95">
            <Play size={24} fill="white" /> Start Stop
          </button>
        ) : (
          <div className="flex gap-3">
            {!paused ? (
              <button onClick={pause} className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white font-bold px-7 py-5 rounded-full shadow-lg transition active:scale-95"><Pause size={20} fill="white" /> Pause</button>
            ) : (
              <button onClick={resume} className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-white font-bold px-7 py-5 rounded-full shadow-lg transition active:scale-95"><Play size={20} fill="white" /> Resume</button>
            )}
            <button onClick={onStop} className="flex items-center gap-2 bg-slate-800 hover:bg-slate-900 text-white font-bold px-7 py-5 rounded-full shadow-lg transition active:scale-95"><Square size={20} fill="white" /> End Stop</button>
          </div>
        )}
        <p className={`text-xs ${t.sub} mt-3 text-center max-w-xs`}>Tap “Start Stop” when the machine stops. Pause for short interruptions; “End Stop” when it runs again.</p>
        {!running && !pendingStop && (
          <button onClick={onOpenManual} className={`mt-4 flex items-center gap-2 text-sm font-semibold ${t.chip} px-4 py-2.5 rounded-full active:scale-95 transition`}>
            <PencilLine size={16} /> Report a stop manually
          </button>
        )}
      </div>

      {/* document pending stop */}
      {pendingStop && (
        <div className={`${t.card} rounded-xl border-2 border-emerald-400 p-4 space-y-3`}>
          <div className="flex items-center gap-2 text-emerald-500 font-bold"><AlertCircle size={18} /> Document this stop</div>
          <div className={`grid grid-cols-2 gap-2 text-sm ${t.muted} rounded-lg p-3`}>
            <div><span className={`${t.sub} text-xs`}>DURATION</span><div className="font-mono font-bold text-lg">{fmtDur(pendingStop.duration)}</div></div>
            {/* the machine the stop was PINNED to at Start, not the current selection */}
            <div><span className={`${t.sub} text-xs`}>MACHINE</span><div className="font-semibold">{pendingStop.machine || machine}</div></div>
            <div><span className={`${t.sub} text-xs`}>START</span><div>{fmtTime(pendingStop.start)}</div></div>
            <div><span className={`${t.sub} text-xs`}>END</span><div>{fmtTime(pendingStop.end)}</div></div>
          </div>

          {/* quick stops + last reason */}
          <div className="flex flex-wrap gap-2">
            {lastReason && reasons.includes(lastReason) && (
              <button onClick={() => setReason(lastReason)} className="flex items-center gap-1 text-xs bg-emerald-100 text-emerald-700 rounded-full px-3 py-1.5 font-semibold hover:bg-emerald-200"><RotateCcw size={12} /> Last: {lastReason}</button>
            )}
            {quickStops.map((q, i) => (
              <button key={i} onClick={() => applyQuickStop(q)} className={`flex items-center gap-1 text-xs ${t.chip} rounded-full px-3 py-1.5 font-semibold hover:opacity-80`}><Zap size={12} className="text-amber-500" /> {q.label}</button>
            ))}
          </div>

          <label className="flex flex-col gap-1">
            <span className={`text-xs font-semibold ${t.sub}`}>REASON</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)} className={`border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`}>{reasons.map((r) => <option key={r}>{r}</option>)}</select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={`text-xs font-semibold ${t.sub}`}>NOTES (optional)</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Add detail…" className={`border rounded-lg px-3 py-2.5 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
          </label>
          <div className="flex gap-2">
            <button onClick={onSave} disabled={saving} className="flex-1 flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold py-3.5 rounded-lg transition">{saving ? <RefreshCw size={18} className="animate-spin" /> : <CheckCircle size={18} />} Save stop</button>
            <button onClick={onDiscardPending} disabled={saving} className={`px-4 ${t.sub} hover:text-red-500 font-semibold`}>Discard</button>
          </div>
          {saveError && <div className="flex items-center gap-2 text-sm text-red-500 bg-red-500/10 rounded-lg px-3 py-2"><AlertCircle size={15} /> {saveError}</div>}
        </div>
      )}

      {/* shift output (units + scrap) for OEE */}
      <ShiftOutputCard t={t} myProduction={myProduction} onSaveProduction={onSaveProduction} machine={machine}
        otherEntries={myShift.rows.filter((r) => (r.units > 0 || r.scrap > 0) && r.machine !== machine)}
        onJump={setMachine} />

      {/* shift summary + handover + New Shift */}
      <div className={`${t.card} rounded-xl p-4`}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className={`text-xs font-semibold ${t.sub}`}>THIS SHIFT</div>
            <div className="font-bold text-lg leading-tight">{myStops.length} stop{myStops.length === 1 ? "" : "s"} · <span className="font-mono text-red-500">{fmtDur(downtimeMs)}</span></div>
          </div>
          <div className="flex gap-2">
            <button onClick={onOpenHandover}
              className={`flex items-center gap-2 ${t.accentBtn} font-bold px-4 py-3 rounded-xl shadow active:scale-95 transition`}>
              <PencilLine size={18} /> Handover
            </button>
            <button onClick={onNewShift} disabled={!!pendingStop}
              className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white font-bold px-5 py-3 rounded-xl shadow active:scale-95 transition">
              <Sparkles size={18} /> New Shift
            </button>
          </div>
        </div>
        {clearedBefore > 0 && (
          <div className={`text-xs ${t.sub} ${t.muted} rounded-lg px-3 py-2 mt-3 flex items-center justify-between gap-2`}>
            <span className="flex items-center gap-1">
              <Archive size={13} />
              {showAll
                ? "Showing all stops, including earlier shifts."
                : `New shift started ${fmtTime(clearedBefore)}. Earlier stops are hidden but saved.`}
            </span>
            <button onClick={onToggleShowAll} className="text-emerald-500 font-semibold hover:underline whitespace-nowrap">
              {showAll ? "Hide earlier" : "Show all"}
            </button>
          </div>
        )}
      </div>

      {/* recent stops */}
      <div className={`${t.card} rounded-xl p-4`}>
        <div className="flex items-center gap-2 font-bold mb-3"><List size={18} /> Recent stops {operator.trim() && <span className={`text-xs font-normal ${t.sub}`}>({operator.trim()})</span>}</div>
        {myStops.length === 0 ? <p className={`${t.sub} text-sm text-center py-4`}>No stops logged yet. Start the timer when the machine stops.</p> : (
          <div className="space-y-2">
            {myStops.slice(0, 8).map((s) => (
              <div key={s.id} className={`flex items-center justify-between border ${t.border} rounded-lg px-3 py-2.5 text-sm`}>
                <div><div className="font-semibold">{s.machine}</div><div className={`${t.sub} text-xs`}>{fmtTime(s.start)} · {s.reason}</div></div>
                <div className="font-mono font-bold text-red-500">{fmtDur(s.duration)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* downtime by reason (current shift) */}
      <div className={`${t.card} rounded-xl p-4`}>
        <h3 className="font-bold mb-3 flex items-center gap-2"><BarChart3 size={18} /> Downtime by reason</h3>
        {byReason.list.length === 0 ? <p className={`${t.sub} text-sm text-center py-4`}>No downtime logged this shift.</p> : (
          <div className="space-y-2">
            {byReason.list.map(([r, d]) => (
              <div key={r}>
                <div className="flex justify-between text-xs mb-1"><span className="font-medium">{r}</span><span className={`font-mono ${t.sub}`}>{fmtDur(d)}</span></div>
                <div className={`h-2 ${t.muted} rounded-full overflow-hidden`}><div className="h-full bg-emerald-500 rounded-full" style={{ width: `${(d / byReason.max) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
   MANUAL STOP MODAL — log a stop that already happened, entered by duration.
   ========================================================================== */
function ManualStopModal({ t, dark, machine, machines, reasons, quickStops, lastReason, saving, saveError, onSave, onClose }) {
  const [mins, setMins] = useState("");
  const [secs, setSecs] = useState("");
  // Roaming operators often report a stop on a machine other than the one they're
  // standing at — the machine is selectable, defaulting to the current one.
  const [mMachine, setMMachine] = useState(machine);
  const [reason, setReason] = useState(lastReason && reasons.includes(lastReason) ? lastReason : reasons[0]);
  const [notes, setNotes] = useState("");
  const [localErr, setLocalErr] = useState("");

  const durationMs = (Math.max(0, parseInt(mins || "0", 10)) * 60 + Math.max(0, parseInt(secs || "0", 10))) * 1000;

  const submit = async () => {
    if (durationMs <= 0) { setLocalErr("Enter a duration greater than zero."); return; }
    setLocalErr("");
    await onSave({ durationMs, reason, notes, machine: mMachine });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-30" onClick={onClose}>
      <div className={`${dark ? "bg-slate-900" : "bg-white"} rounded-xl shadow-xl p-5 max-w-sm w-full space-y-3 max-h-[90vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 font-bold"><PencilLine size={18} className="text-emerald-500" /> Report a stop manually</div>
        <p className={`text-sm ${t.sub}`}>For a stop that already happened. Enter how long it lasted.</p>

        <label className="flex flex-col gap-1">
          <span className={`text-xs font-semibold ${t.sub}`}>MACHINE</span>
          <select value={mMachine} onChange={(e) => setMMachine(e.target.value)} className={`border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`}>
            {(machines || [machine]).map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>

        <div>
          <span className={`text-xs font-semibold ${t.sub}`}>DURATION</span>
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 flex items-center gap-1">
              <input type="number" inputMode="numeric" min="0" value={mins} onChange={(e) => setMins(e.target.value)} placeholder="0"
                className={`w-full text-center text-2xl font-mono font-bold border rounded-lg py-2 focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
              <span className={`text-sm ${t.sub}`}>min</span>
            </div>
            <div className="flex-1 flex items-center gap-1">
              <input type="number" inputMode="numeric" min="0" max="59" value={secs} onChange={(e) => setSecs(e.target.value)} placeholder="0"
                className={`w-full text-center text-2xl font-mono font-bold border rounded-lg py-2 focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
              <span className={`text-sm ${t.sub}`}>sec</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            {[5, 10, 15, 30].map((m) => (
              <button key={m} onClick={() => { setMins(String(m)); setSecs(""); }} className={`text-xs ${t.chip} rounded-full px-3 py-1.5 font-semibold active:scale-95`}>{m} min</button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {lastReason && reasons.includes(lastReason) && (
            <button onClick={() => setReason(lastReason)} className="flex items-center gap-1 text-xs bg-emerald-100 text-emerald-700 rounded-full px-3 py-1.5 font-semibold hover:bg-emerald-200"><RotateCcw size={12} /> Last: {lastReason}</button>
          )}
          {quickStops.map((q, i) => (
            <button key={i} onClick={() => { if (reasons.includes(q.reason)) setReason(q.reason); if (q.notes) setNotes(q.notes); }} className={`flex items-center gap-1 text-xs ${t.chip} rounded-full px-3 py-1.5 font-semibold hover:opacity-80`}><Zap size={12} className="text-amber-500" /> {q.label}</button>
          ))}
        </div>

        <label className="flex flex-col gap-1">
          <span className={`text-xs font-semibold ${t.sub}`}>REASON</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)} className={`border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`}>{reasons.map((r) => <option key={r}>{r}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={`text-xs font-semibold ${t.sub}`}>NOTES (optional)</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Add detail…" className={`border rounded-lg px-3 py-2.5 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
        </label>

        {(localErr || saveError) && <div className="flex items-center gap-2 text-sm text-red-500 bg-red-500/10 rounded-lg px-3 py-2"><AlertCircle size={15} /> {localErr || saveError}</div>}

        <div className="flex gap-2">
          <button onClick={submit} disabled={saving} className="flex-1 flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold py-3.5 rounded-lg transition">{saving ? <RefreshCw size={18} className="animate-spin" /> : <CheckCircle size={18} />} Save stop</button>
          <button onClick={onClose} disabled={saving} className={`px-4 ${t.sub} hover:text-red-500 font-semibold`}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
   SUPERVISOR VIEW
   ========================================================================== */
function SupervisorView({ t, stops, loading, onRefresh, machines, reasons, quickStops, shifts, updateMachines, updateReasons, updateQuickStops, updateShifts, discardStop, deleteStop, hasPin, updatePin, syncCfg, updateSyncConfig, syncStatus, onSyncNow, rates, updateRates, production, sessions, handoverEmails, updateHandoverEmails, onDownloadBackup, onRestore, restoreMsg }) {
  // Uptime/OEE assume a shift length; with several shifts the supervisor picks
  // which one frames the analytics (defaults to the first).
  const [analyticsShiftId, setAnalyticsShiftId] = useState(shifts?.[0]?.id);
  const shift = useMemo(
    () => shifts?.find((s) => s.id === analyticsShiftId) || shifts?.[0] || { start: "06:00", end: "14:00" },
    [shifts, analyticsShiftId],
  );
  const [tab, setTab] = useState("log");
  const [filterMachine, setFilterMachine] = useState("All");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [discardTarget, setDiscardTarget] = useState(null);
  const [discardText, setDiscardText] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null); // permanent delete confirm

  const rangeBounds = useMemo(() => {
    const now = Date.now();
    if (range === "7") return [now - 7 * DAY, now];
    if (range === "30") return [now - 30 * DAY, now];
    if (range === "custom") {
      const from = customFrom ? new Date(customFrom).getTime() : 0;
      const to = customTo ? new Date(customTo).getTime() + DAY : now;
      return [from, to];
    }
    return [0, Infinity];
  }, [range, customFrom, customTo]);

  const logFiltered = useMemo(() => stops.filter((s) => {
    if (s.deleted) return false; // delete tombstones never appear in any view or export
    if (filterMachine !== "All" && s.machine !== filterMachine) return false;
    if (s.start < rangeBounds[0] || s.start > rangeBounds[1]) return false;
    if (query.trim()) {
      const q = query.toLowerCase();
      if (!`${s.machine} ${s.reason} ${s.operator} ${s.notes || ""}`.toLowerCase().includes(q)) return false;
    }
    return true;
  }), [stops, filterMachine, rangeBounds, query]);

  const active = useMemo(() => logFiltered.filter((s) => !s.discarded), [logFiltered]);

  const stats = useMemo(() => {
    const totalDowntime = active.reduce((a, s) => a + s.duration, 0);
    const byReason = {}, byMachine = {};
    active.forEach((s) => {
      byReason[s.reason] = (byReason[s.reason] || 0) + s.duration;
      byMachine[s.machine] = (byMachine[s.machine] || 0) + s.duration;
    });
    const topReasons = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
    const topMachines = Object.entries(byMachine).sort((a, b) => b[1] - a[1]);
    return { totalDowntime, topReasons, topMachines, maxReason: topReasons[0]?.[1] || 1 };
  }, [active]);

  const trend = useMemo(() => {
    const now = Date.now();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const dStart = new Date(now - i * DAY); dStart.setHours(0, 0, 0, 0);
      const dEnd = dStart.getTime() + DAY;
      const total = stops
        .filter((s) => !s.discarded && !s.deleted && (filterMachine === "All" || s.machine === filterMachine) && s.start >= dStart.getTime() && s.start < dEnd)
        .reduce((a, s) => a + s.duration, 0);
      days.push({ label: dayKey(dStart.getTime()), ms: total });
    }
    return days;
  }, [stops, filterMachine]);
  const maxTrend = Math.max(1, ...trend.map((d) => d.ms));

  const uptime = useMemo(() => {
    const shiftMs = shiftLengthMs(shift);
    if (!shiftMs) return null;
    const dayset = new Set(active.map((s) => new Date(s.start).toDateString()));
    const days = Math.max(1, dayset.size);
    const planned = shiftMs * days;
    const up = Math.max(0, planned - stats.totalDowntime);
    return Math.min(100, Math.max(0, (up / planned) * 100));
  }, [active, shift, stats.totalDowntime]);

  const liveCount = useMemo(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return active.filter((s) => s.end > cutoff).length;
  }, [active]);

  // Per-machine (and overall) OEE across the active date range. Downtime comes
  // from the filtered stops; units/scrap from synced production records in the
  // same window; planned time = configured shift length × the distinct days a
  // machine actually reported anything (so idle machines don't drag the number).
  const machineOEE = useMemo(() => {
    const shiftMs = shiftLengthMs(shift);
    const nowTs = Date.now();
    const prodInRange = production.filter((p) => {
      const ts = p.loggedAt ?? p.shiftStart ?? 0;
      return ts >= rangeBounds[0] && ts <= rangeBounds[1];
    });
    // Manned time per machine (any operator) from sessions overlapping the range
    // — shown as coverage context next to the planned-time OEE.
    const mannedByMachine = {};
    (sessions || []).forEach((s) => {
      const end = Math.min(s.end ?? nowTs, rangeBounds[1] === Infinity ? nowTs : rangeBounds[1]);
      const start = Math.max(s.start, rangeBounds[0]);
      if (end > start) mannedByMachine[s.machine] = (mannedByMachine[s.machine] || 0) + (end - start);
    });
    const downByMachine = {};
    active.forEach((s) => { downByMachine[s.machine] = (downByMachine[s.machine] || 0) + s.duration; });
    const rows = [];
    let sum = { planned: 0, down: 0, units: 0, scrap: 0, theoretical: 0 };
    for (const m of machines) {
      const prod = prodInRange.filter((p) => p.machine === m);
      const units = prod.reduce((a, p) => a + (p.unitsProduced || 0), 0);
      const scrap = prod.reduce((a, p) => a + (p.scrapCount || 0), 0);
      const down = downByMachine[m] || 0;
      const manned = mannedByMachine[m] || 0;
      if (!units && !down && !manned) continue; // nothing reported for this machine in range
      const days = new Set([
        ...active.filter((s) => s.machine === m).map((s) => new Date(s.start).toDateString()),
        ...prod.map((p) => new Date(p.loggedAt ?? p.shiftStart).toDateString()),
      ]).size || 1;
      const plannedMs = shiftMs * days;
      const oee = computeOEE({ plannedMs, downtimeMs: down, unitsProduced: units, scrapCount: scrap, ratePerHour: rates?.[m] });
      rows.push({ machine: m, units, scrap, mannedMs: manned, plannedMs, ...oee });
      sum.planned += plannedMs; sum.down += down; sum.units += units; sum.scrap += scrap;
      if (rates?.[m]) sum.theoretical += (rates[m] || 0) * (Math.max(0, plannedMs - down) / HOUR_MS);
    }
    // Overall: aggregate factors over everything that reported.
    const overall = computeOEE({
      plannedMs: sum.planned, downtimeMs: sum.down,
      unitsProduced: sum.units, scrapCount: sum.scrap,
      ratePerHour: 0, // performance recomputed below from the summed theoretical
    });
    if (sum.theoretical > 0) {
      overall.p = Math.min(1, Math.max(0, sum.units / sum.theoretical));
      const fs = [overall.a, overall.p, overall.q].filter((f) => f != null);
      overall.oee = fs.length ? fs.reduce((x, y) => x * y, 1) : null;
      overall.partial = overall.a == null || overall.p == null || overall.q == null;
    }
    rows.sort((a, b) => (a.oee ?? 2) - (b.oee ?? 2)); // worst first
    return { rows, overall };
  }, [active, production, sessions, machines, rates, shift, rangeBounds]);

  // Downtime grouped by operator — who was fighting the most downtime in range.
  const byOperator = useMemo(() => {
    const map = {};
    active.forEach((s) => {
      const op = s.operator || "Unnamed";
      const e = (map[op] = map[op] || { down: 0, stops: 0 });
      e.down += s.duration; e.stops += 1;
    });
    const list = Object.entries(map).sort((a, b) => b[1].down - a[1].down);
    return { list, max: list[0]?.[1].down || 1 };
  }, [active]);

  const confirmDiscard = async () => {
    if (!discardText.trim()) return;
    const ok = await discardStop(discardTarget, discardText.trim());
    if (ok) { setDiscardTarget(null); setDiscardText(""); }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const ok = await deleteStop(deleteTarget);
    if (ok) setDeleteTarget(null);
  };

  const exportCSV = () => {
    const rows = [["Machine", "Reason", "Operator", "Start", "End", "Duration (s)", "Entry", "Notes", "Discarded", "Discard Reason"]];
    logFiltered.forEach((s) => rows.push([s.machine, s.reason, s.operator, new Date(s.start).toISOString(), new Date(s.end).toISOString(), Math.round(s.duration / 1000), s.manual ? "manual" : "timed", s.notes || "", s.discarded ? "yes" : "no", s.discardReason || ""]));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    downloadFile(csv, `stoptrack_export_${Date.now()}.csv`, "text/csv");
  };
  const exportJSON = () => {
    downloadFile(JSON.stringify(logFiltered.map(({ key, ...rest }) => rest), null, 2), `stoptrack_export_${Date.now()}.json`, "application/json");
  };

  return (
    <div className="space-y-4">
      {/* First-run nudge: without a PIN, anyone can open this view. */}
      {!hasPin && (
        <div className="text-xs rounded-lg px-3 py-2 flex items-center gap-2 bg-amber-500/10 text-amber-600">
          <Lock size={14} /> No supervisor PIN set — any operator can open this view. Set one under Settings to restrict it.
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard t={t} label="Stops" value={active.length} icon={<List size={16} />} />
        <StatCard t={t} label="Downtime" value={fmtDur(stats.totalDowntime)} icon={<Clock size={16} />} />
        <StatCard t={t} label="Last Hour" value={liveCount} icon={<AlertCircle size={16} />} />
        <StatCard t={t} label="Uptime" value={uptime == null ? "—" : `${uptime.toFixed(1)}%`} icon={<TrendingUp size={16} />}
          accent={uptime == null ? "" : uptime > 90 ? "text-emerald-500" : uptime > 75 ? "text-amber-500" : "text-red-500"} />
      </div>

      {/* controls */}
      <div className={`${t.card} rounded-xl p-3 space-y-3`}>
        <div className="flex items-center gap-2 flex-wrap">
          <div className={`flex items-center gap-2 border rounded-lg px-2 ${t.input} flex-1 min-w-[160px]`}>
            <Search size={15} className={t.sub} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search machine, reason, operator, notes…" className="bg-transparent py-2 text-sm flex-1 focus:outline-none" />
            {query && <button onClick={() => setQuery("")} aria-label="Clear search"><X size={14} className={t.sub} /></button>}
          </div>
          <select value={filterMachine} onChange={(e) => setFilterMachine(e.target.value)} className={`border rounded-lg px-3 py-2 text-sm ${t.input}`}>
            <option>All</option>{machines.map((m) => <option key={m}>{m}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className={`flex ${t.muted} rounded-lg p-1 text-xs`}>
            {[["all", "All time"], ["7", "7 days"], ["30", "30 days"], ["custom", "Custom"]].map(([v, l]) => (
              <button key={v} onClick={() => setRange(v)} className={`px-2.5 py-1 rounded-md ${range === v ? "bg-emerald-500 text-white" : t.sub}`}>{l}</button>
            ))}
          </div>
          {range === "custom" && (
            <div className="flex items-center gap-1 text-xs">
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className={`border rounded-lg px-2 py-1 ${t.input}`} />
              <span className={t.sub}>→</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className={`border rounded-lg px-2 py-1 ${t.input}`} />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className={`flex ${t.muted} rounded-lg p-1 text-sm`}>
            <TabBtn t={t} active={tab === "log"} onClick={() => setTab("log")} icon={<List size={14} />}>Log</TabBtn>
            <TabBtn t={t} active={tab === "analytics"} onClick={() => setTab("analytics")} icon={<BarChart3 size={14} />}>Analytics</TabBtn>
            <TabBtn t={t} active={tab === "manage"} onClick={() => setTab("manage")} icon={<Settings size={14} />}>Settings</TabBtn>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={exportCSV} className={`flex items-center gap-1 text-xs ${t.accentBtn} px-2.5 py-1.5 rounded-lg`}><Download size={13} /> CSV</button>
            <button onClick={exportJSON} className={`flex items-center gap-1 text-xs ${t.accentBtn} px-2.5 py-1.5 rounded-lg`}><Download size={13} /> JSON</button>
            <button onClick={onRefresh} className="flex items-center gap-1 text-sm text-emerald-500 font-semibold" aria-label="Refresh"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></button>
          </div>
        </div>
        <p className={`text-[11px] ${t.sub}`}>Export includes every record in the current filter — discarded stops too. Nothing here is ever permanently deleted by operators.</p>
      </div>

      {tab === "log" && (
        <div className={`${t.card} rounded-xl overflow-hidden`}>
          {loading ? <p className={`${t.sub} text-center py-8 text-sm`}>Loading…</p> : logFiltered.length === 0 ? <p className={`${t.sub} text-center py-8 text-sm`}>No stops match your filters.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className={`${t.thead} text-xs uppercase`}><tr>
                  <th className="text-left px-3 py-2">Machine</th><th className="text-left px-3 py-2">Reason</th><th className="text-left px-3 py-2">Operator</th><th className="text-left px-3 py-2">Start</th><th className="text-right px-3 py-2">Duration</th><th className="px-3 py-2"></th>
                </tr></thead>
                <tbody>
                  {logFiltered.map((s) => (
                    <tr key={s.id} className={`border-t ${t.border} ${s.discarded ? "opacity-50" : t.rowHover}`}>
                      <td className={`px-3 py-2 font-semibold ${s.discarded ? "line-through" : ""}`}>{s.machine}</td>
                      <td className="px-3 py-2"><span className={s.discarded ? "line-through" : ""}>{s.reason}</span>{s.manual && <span className="ml-1 text-[10px] uppercase tracking-wide bg-slate-400/20 text-slate-400 rounded px-1.5 py-0.5 align-middle">manual</span>}{s.notes && <div className={`text-xs ${t.sub}`}>{s.notes}</div>}{s.discarded && <div className="text-xs text-amber-500 mt-0.5">Discarded: {s.discardReason}</div>}</td>
                      <td className={`px-3 py-2 ${t.sub}`}>{s.operator}</td>
                      <td className={`px-3 py-2 ${t.sub} text-xs whitespace-nowrap`}>{fmtTime(s.start)}</td>
                      <td className={`px-3 py-2 text-right font-mono font-bold whitespace-nowrap ${s.discarded ? `${t.sub} line-through` : "text-red-500"}`}>{fmtDur(s.duration)}</td>
                      <td className="px-3 py-2 text-right">{s.discarded
                        ? <button onClick={() => setDeleteTarget(s)} title="Delete permanently" className="text-slate-400 hover:text-red-600"><X size={16} /></button>
                        : <button onClick={() => { setDiscardTarget(s); setDiscardText(""); }} title="Discard from analytics" className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "analytics" && (
        <div className="space-y-4">
          <div className={`${t.card} rounded-xl p-4`}>
            <h3 className="font-bold mb-1 flex items-center gap-2"><TrendingUp size={16} /> OEE {machineOEE.overall.partial && <span className={`text-xs font-normal ${t.sub}`}>(partial)</span>}</h3>
            <p className={`text-xs ${t.sub} mb-3`}>Availability × Performance × Quality, from logged downtime and shift output over the selected range.</p>
            <div className="flex items-end gap-4 mb-4">
              <div className={`text-4xl font-bold ${oeeAccent(machineOEE.overall.oee)}`}>{pct(machineOEE.overall.oee)}</div>
              <div className={`text-xs ${t.sub} pb-1`}>A {pct(machineOEE.overall.a)} · P {pct(machineOEE.overall.p)} · Q {pct(machineOEE.overall.q)}</div>
            </div>
            {machineOEE.rows.length === 0 ? <p className={`${t.sub} text-sm`}>No downtime or shift output reported in this range.</p> : (
              <div className="space-y-2">{machineOEE.rows.map((r) => (
                <div key={r.machine}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium">{r.machine}{r.partial ? " *" : ""}</span>
                    <span className={`font-mono font-bold ${oeeAccent(r.oee)}`}>{pct(r.oee)}</span>
                  </div>
                  <div className={`h-2 ${t.muted} rounded-full overflow-hidden`}><div className={`h-full rounded-full ${r.oee == null ? "bg-slate-400" : r.oee > 0.85 ? "bg-emerald-500" : r.oee > 0.6 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${(r.oee ?? 0) * 100}%` }} /></div>
                  <div className={`text-[10px] ${t.sub} mt-0.5`}>A {pct(r.a)} · P {pct(r.p)} · Q {pct(r.q)} · {r.units} units / {r.scrap} scrap{r.mannedMs > 0 && <> · manned {fmtDur(r.mannedMs)} of {fmtDur(r.plannedMs)}</>}</div>
                </div>
              ))}</div>
            )}
            {machineOEE.rows.some((r) => r.partial) && <p className={`text-[10px] ${t.sub} mt-2`}>* partial — missing a machine rate (Settings) or shift output, so only the known factors are multiplied.</p>}
          </div>

          <div className={`${t.card} rounded-xl p-4`}>
            <h3 className="font-bold mb-3 flex items-center gap-2"><TrendingUp size={16} /> Downtime trend — last 7 days</h3>
            <div className="flex items-end gap-2 h-36">
              {trend.map((d, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
                  <span className={`text-[10px] ${t.sub} font-mono`}>{d.ms > 0 ? fmtDur(d.ms) : ""}</span>
                  <div className="w-full bg-emerald-500 rounded-t transition-all" style={{ height: `${(d.ms / maxTrend) * 100}%`, minHeight: d.ms > 0 ? "4px" : "0" }} />
                  <span className={`text-[10px] ${t.sub}`}>{d.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className={`${t.card} rounded-xl p-4`}>
            <h3 className="font-bold mb-3 flex items-center gap-2"><AlertCircle size={16} /> Top 3 problem machines</h3>
            {stats.topMachines.length === 0 ? <p className={`${t.sub} text-sm`}>No data.</p> : (
              <div className="space-y-2">
                {stats.topMachines.slice(0, 3).map(([m, d], i) => (
                  <div key={m} className={`flex items-center gap-3 ${t.muted} rounded-lg p-3`}>
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-white ${i === 0 ? "bg-red-500" : i === 1 ? "bg-amber-500" : "bg-slate-400"}`}>{i + 1}</div>
                    <div className="flex-1"><div className="font-semibold">{m}</div><div className={`text-xs ${t.sub}`}>{active.filter((s) => s.machine === m).length} stops</div></div>
                    <div className="font-mono font-bold text-red-500">{fmtDur(d)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={`${t.card} rounded-xl p-4`}>
            <h3 className="font-bold mb-3 flex items-center gap-2"><BarChart3 size={16} /> Downtime by reason</h3>
            {stats.topReasons.length === 0 ? <p className={`${t.sub} text-sm`}>No data.</p> : (
              <div className="space-y-2">{stats.topReasons.map(([r, d]) => (
                <div key={r}><div className="flex justify-between text-xs mb-1"><span className="font-medium">{r}</span><span className={`font-mono ${t.sub}`}>{fmtDur(d)}</span></div><div className={`h-2 ${t.muted} rounded-full overflow-hidden`}><div className="h-full bg-emerald-500 rounded-full" style={{ width: `${(d / stats.maxReason) * 100}%` }} /></div></div>
              ))}</div>
            )}
          </div>

          <div className={`${t.card} rounded-xl p-4`}>
            <h3 className="font-bold mb-3 flex items-center gap-2"><User size={16} /> Downtime by operator</h3>
            {byOperator.list.length === 0 ? <p className={`${t.sub} text-sm`}>No data.</p> : (
              <div className="space-y-2">{byOperator.list.map(([op, e]) => (
                <div key={op}><div className="flex justify-between text-xs mb-1"><span className="font-medium">{op} <span className={t.sub}>· {e.stops} stop{e.stops === 1 ? "" : "s"}</span></span><span className={`font-mono ${t.sub}`}>{fmtDur(e.down)}</span></div><div className={`h-2 ${t.muted} rounded-full overflow-hidden`}><div className="h-full bg-emerald-500 rounded-full" style={{ width: `${(e.down / byOperator.max) * 100}%` }} /></div></div>
              ))}</div>
            )}
          </div>
          {shifts && shifts.length > 1 && (
            <div className="flex items-center justify-center gap-2 text-xs">
              <span className={t.sub}>Frame uptime by shift:</span>
              <select value={analyticsShiftId} onChange={(e) => setAnalyticsShiftId(e.target.value)}
                className={`border rounded-lg px-2 py-1 ${t.input}`}>
                {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start}–{s.end})</option>)}
              </select>
            </div>
          )}
          <p className={`text-center text-xs ${t.sub}`}>Analytics exclude discarded stops. Uptime % assumes a {shift.start}–{shift.end} shift.</p>
        </div>
      )}

      {tab === "manage" && (
        <div className="space-y-4">
          <ShiftsManager t={t} shifts={shifts} machines={machines} onChange={updateShifts} />
          <ListManager t={t} title="Machines" icon={<Factory size={16} />} items={machines} onChange={updateMachines} placeholder="e.g. Line 1 - Packaging" />
          <ListManager t={t} title="Stop reasons" icon={<AlertCircle size={16} />} items={reasons} onChange={updateReasons} placeholder="e.g. Sensor calibration" />
          <QuickStopManager t={t} quickStops={quickStops} reasons={reasons} onChange={updateQuickStops} />
          <RatesManager t={t} machines={machines} rates={rates} onChange={updateRates} />
          <HandoverEmailsManager t={t} emails={handoverEmails} onChange={updateHandoverEmails} />
          <PinManager t={t} hasPin={hasPin} updatePin={updatePin} />
          <ServerSyncManager t={t} syncCfg={syncCfg} updateSyncConfig={updateSyncConfig} syncStatus={syncStatus} onSyncNow={onSyncNow} />

          <div className={`${t.card} rounded-xl p-4`}>
            <h3 className="font-bold mb-1 flex items-center gap-2"><Archive size={16} /> Backup &amp; Restore</h3>
            <p className={`text-xs ${t.sub} mb-3`}>
              Carry your data to a new version. <b>Download a backup before you update the app</b>, then
              Restore it afterwards. Brings back machines, reasons, shifts, rates &amp; every logged stop.
              Restore merges (keeps the newest of each record), so it's safe to run any time.
            </p>
            <div className="flex flex-wrap gap-2">
              <button onClick={onDownloadBackup} className={`flex items-center gap-1.5 text-sm font-semibold ${t.accentBtn} px-3 py-2 rounded-lg`}><Download size={15} /> Download backup</button>
              <button onClick={onRestore} className={`flex items-center gap-1.5 text-sm font-semibold ${t.chip} px-3 py-2 rounded-lg active:scale-95`}><RotateCcw size={15} /> Restore from backup</button>
            </div>
            {restoreMsg && <p className="text-xs text-red-500 mt-2">{restoreMsg}</p>}
          </div>

          <p className={`text-center text-xs ${t.sub}`}>Machines, reasons &amp; quick stops sync to all operators in real time.</p>
        </div>
      )}

      {discardTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-20" onClick={() => setDiscardTarget(null)}>
          <div className={`${t.card} rounded-xl p-5 max-w-sm w-full space-y-3`} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 font-bold"><Trash2 size={18} className="text-red-500" /> Discard stop</div>
            <div className={`text-sm ${t.muted} rounded-lg p-3`}><div className="font-semibold">{discardTarget.machine}</div><div className={`${t.sub} text-xs`}>{discardTarget.reason} · {fmtDur(discardTarget.duration)} · {fmtTime(discardTarget.start)}</div></div>
            <p className={`text-xs ${t.sub}`}>Removes it from analytics but keeps it on record and in exports (auto-deleted after 60 days). Explanation required.</p>
            <textarea value={discardText} onChange={(e) => setDiscardText(e.target.value)} rows={3} placeholder="Reason for discarding (required)…" className={`w-full border rounded-lg px-3 py-2 resize-none text-sm focus:outline-none focus:ring-2 focus:ring-red-400 ${t.input}`} />
            <div className="flex gap-2"><button onClick={confirmDiscard} disabled={!discardText.trim()} className="flex-1 bg-red-500 hover:bg-red-600 disabled:opacity-40 text-white font-bold py-2.5 rounded-lg">Discard stop</button><button onClick={() => setDiscardTarget(null)} className={`px-4 ${t.sub} font-semibold`}>Cancel</button></div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-20" onClick={() => setDeleteTarget(null)}>
          <div className={`${t.card} rounded-xl p-5 max-w-sm w-full space-y-3`} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 font-bold text-red-600"><X size={18} /> Delete permanently</div>
            <div className={`text-sm ${t.muted} rounded-lg p-3`}><div className="font-semibold">{deleteTarget.machine}</div><div className={`${t.sub} text-xs`}>{deleteTarget.reason} · {fmtDur(deleteTarget.duration)} · {fmtTime(deleteTarget.start)}</div></div>
            <p className={`text-xs ${t.sub}`}>This erases the record from storage for good. It won't appear in future exports. This can't be undone.</p>
            <div className="flex gap-2"><button onClick={confirmDelete} className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-2.5 rounded-lg">Delete forever</button><button onClick={() => setDeleteTarget(null)} className={`px-4 ${t.sub} font-semibold`}>Cancel</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
   SHARED SUB-COMPONENTS
   ========================================================================== */
function TabBtn({ t, active, onClick, icon, children }) {
  return <button onClick={onClick} className={`px-3 py-1.5 rounded-md flex items-center gap-1 ${active ? `${t.card} shadow font-semibold` : t.sub}`}>{icon} {children}</button>;
}

function StatCard({ t, label, value, icon, accent }) {
  return <div className={`${t.card} rounded-xl p-3 text-center`}><div className={`flex items-center justify-center gap-1 ${t.sub} text-xs mb-1`}>{icon} {label}</div><div className={`font-bold text-lg leading-tight ${accent || ""}`}>{value}</div></div>;
}

function ListManager({ t, title, icon, items, onChange, placeholder }) {
  const [input, setInput] = useState("");
  const add = () => { const v = input.trim().slice(0, 60); if (!v || items.includes(v)) return; onChange([...items, v]); setInput(""); };
  const remove = (item) => onChange(items.filter((i) => i !== item));
  return (
    <div className={`${t.card} rounded-xl p-4`}>
      <h3 className="font-bold mb-3 flex items-center gap-2">{icon} {title}</h3>
      <div className="flex gap-2 mb-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder={placeholder} className={`flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
        <button onClick={add} className="flex items-center gap-1 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold px-4 rounded-lg text-sm"><Plus size={16} /> Add</button>
      </div>
      <div className="flex flex-wrap gap-2">{items.map((item) => (
        <span key={item} className={`flex items-center gap-1 ${t.chip} rounded-full pl-3 pr-1 py-1 text-sm`}>{item}<button onClick={() => remove(item)} disabled={items.length <= 1} className="text-slate-400 hover:text-red-500 disabled:opacity-30 p-0.5" aria-label={`Remove ${item}`}><X size={14} /></button></span>
      ))}</div>
    </div>
  );
}

function QuickStopManager({ t, quickStops, reasons, onChange }) {
  const [label, setLabel] = useState("");
  const [reason, setReason] = useState(reasons[0] || "");
  const [notes, setNotes] = useState("");
  const add = () => { const l = label.trim().slice(0, 40); if (!l) return; onChange([...quickStops, { label: l, reason, notes: notes.trim().slice(0, 200) }]); setLabel(""); setNotes(""); };
  const remove = (i) => onChange(quickStops.filter((_, idx) => idx !== i));
  return (
    <div className={`${t.card} rounded-xl p-4`}>
      <h3 className="font-bold mb-3 flex items-center gap-2"><Zap size={16} /> Quick stops</h3>
      <p className={`text-xs ${t.sub} mb-3`}>One-tap buttons operators see when documenting a stop.</p>
      <div className="space-y-2 mb-3">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Button label (e.g. Tooling change)" className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
        <div className="flex gap-2 flex-wrap">
          <select value={reason} onChange={(e) => setReason(e.target.value)} className={`border rounded-lg px-3 py-2 text-sm ${t.input}`}>{reasons.map((r) => <option key={r}>{r}</option>)}</select>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Default notes (optional)" className={`flex-1 min-w-[140px] border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
          <button onClick={add} className="bg-emerald-500 hover:bg-emerald-600 text-white font-semibold px-4 rounded-lg text-sm"><Plus size={16} /></button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">{quickStops.length === 0 ? <span className={`text-xs ${t.sub}`}>No quick stops yet.</span> : quickStops.map((q, i) => (
        <span key={i} className={`flex items-center gap-1 ${t.chip} rounded-lg px-3 py-1.5 text-sm`}><Zap size={13} className="text-amber-500" /><span className="font-semibold">{q.label}</span><span className={`text-xs ${t.sub}`}>· {q.reason}</span><button onClick={() => remove(i)} className="text-slate-400 hover:text-red-500 p-0.5 ml-1" aria-label={`Remove ${q.label}`}><X size={14} /></button></span>
      ))}</div>
    </div>
  );
}

/* ============================================================================
   SUPERVISOR PIN GATE + MANAGER
   ========================================================================== */
// Full-view lock shown instead of the supervisor when a PIN is set. A deterrent,
// not hardened auth — it stops operators wandering into destructive screens.
function PinGate({ t, pinHash, onUnlock }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const submit = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const h = await sha256Hex(pin);
    if (h && h === pinHash) onUnlock();
    else { setError(true); setPin(""); }
  };
  return (
    <div className="flex justify-center pt-8">
      <form onSubmit={submit} className={`${t.card} rounded-xl p-6 max-w-xs w-full space-y-4 text-center`}>
        <div className="flex flex-col items-center gap-2">
          <div className="bg-emerald-500/15 rounded-full p-3"><Lock size={22} className="text-emerald-500" /></div>
          <h2 className="font-bold text-lg">Supervisor locked</h2>
          <p className={`text-xs ${t.sub}`}>Enter the supervisor PIN to view the log, analytics and settings.</p>
        </div>
        <input autoFocus type="password" inputMode="numeric" value={pin}
          onChange={(e) => { setPin(e.target.value); setError(false); }}
          placeholder="PIN"
          className={`w-full text-center text-2xl tracking-widest border rounded-lg px-3 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
        {error && <p className="text-xs text-red-500">Incorrect PIN. Try again.</p>}
        <button type="submit" disabled={!pin} className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white font-bold py-3 rounded-lg">Unlock</button>
      </form>
    </div>
  );
}

// Settings card to set / change / clear the supervisor PIN. Changing or clearing
// requires the current PIN.
function PinManager({ t, hasPin, updatePin }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState(null);

  const save = async () => {
    setMsg(null);
    if (next && next !== confirm) { setMsg({ err: true, text: "New PIN and confirmation don't match." }); return; }
    if (next && !/^\d{4,}$/.test(next)) { setMsg({ err: true, text: "Use at least 4 digits." }); return; }
    const ok = await updatePin(next || null, current);
    if (!ok) { setMsg({ err: true, text: "Current PIN is incorrect." }); return; }
    setCurrent(""); setNext(""); setConfirm("");
    setMsg({ err: false, text: next ? "PIN saved." : "PIN cleared — the supervisor view is now open." });
  };
  const clear = async () => {
    setMsg(null);
    const ok = await updatePin(null, current);
    if (!ok) { setMsg({ err: true, text: "Current PIN is incorrect." }); return; }
    setCurrent(""); setNext(""); setConfirm("");
    setMsg({ err: false, text: "PIN cleared — the supervisor view is now open." });
  };

  return (
    <div className={`${t.card} rounded-xl p-4`}>
      <h3 className="font-bold mb-1 flex items-center gap-2"><Lock size={16} /> Supervisor PIN</h3>
      <p className={`text-xs ${t.sub} mb-3`}>
        {hasPin ? "A PIN is required to open the supervisor view. Change or remove it below." : "Set a PIN so operators can't open the supervisor view. Basic deterrent, not strong security."}
      </p>
      <div className="space-y-2">
        {hasPin && (
          <input type="password" inputMode="numeric" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current PIN"
            className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
        )}
        <input type="password" inputMode="numeric" value={next} onChange={(e) => setNext(e.target.value)} placeholder={hasPin ? "New PIN" : "PIN (4+ digits)"}
          className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
        <input type="password" inputMode="numeric" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm new PIN"
          className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
      </div>
      {msg && <p className={`text-xs mt-2 ${msg.err ? "text-red-500" : "text-emerald-600"}`}>{msg.text}</p>}
      <div className="flex gap-2 mt-3">
        <button onClick={save} disabled={!next} className="flex items-center gap-1 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white font-semibold px-4 py-2 rounded-lg text-sm"><CheckCircle size={15} /> {hasPin ? "Change PIN" : "Set PIN"}</button>
        {hasPin && <button onClick={clear} disabled={!current} className="flex items-center gap-1 bg-slate-500 hover:bg-slate-600 disabled:opacity-40 text-white font-semibold px-4 py-2 rounded-lg text-sm"><Unlock size={15} /> Remove PIN</button>}
      </div>
    </div>
  );
}

/* ============================================================================
   SERVER SYNC — settings card + status badge
   ========================================================================== */
function ServerSyncManager({ t, syncCfg, updateSyncConfig, syncStatus, onSyncNow }) {
  const [url, setUrl] = useState(syncCfg?.url || "");
  const [token, setToken] = useState(syncCfg?.token || "");
  const [enabled, setEnabled] = useState(!!syncCfg?.enabled);
  const [test, setTest] = useState(null); // null | "testing" | "ok" | error string

  useEffect(() => { setUrl(syncCfg?.url || ""); setToken(syncCfg?.token || ""); setEnabled(!!syncCfg?.enabled); }, [syncCfg]);

  const cleanUrl = () => url.trim().replace(/\/$/, "");
  const save = () => updateSyncConfig({ url: cleanUrl(), token: token.trim(), enabled });
  const testConn = async () => {
    setTest("testing");
    const res = await api.remoteHealth({ url: cleanUrl(), token: token.trim() });
    setTest(res.ok ? "ok" : (res.error || "Connection failed"));
  };

  return (
    <div className={`${t.card} rounded-xl p-4`}>
      <h3 className="font-bold mb-1 flex items-center gap-2"><RefreshCw size={16} /> Server sync</h3>
      <p className={`text-xs ${t.sub} mb-3`}>
        Optional. Push stops to a shared server so every device — and this supervisor view — sees the same data. Stays fully offline until enabled; changes queue locally and upload when online.
      </p>
      <div className="space-y-2">
        <label className="flex flex-col gap-1 text-xs"><span className={t.sub}>SERVER URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://factory-server.local:4000"
            className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} /></label>
        <label className="flex flex-col gap-1 text-xs"><span className={t.sub}>FACTORY TOKEN</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Shared secret"
            className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} /></label>
        <label className="flex items-center gap-2 text-sm py-1">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4 accent-emerald-500" />
          Enable background sync on this device
        </label>
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        <button onClick={save} className="flex items-center gap-1 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold px-4 py-2 rounded-lg text-sm"><CheckCircle size={15} /> Save</button>
        <button onClick={testConn} disabled={!url.trim()} className={`flex items-center gap-1 ${t.accentBtn} disabled:opacity-40 font-semibold px-4 py-2 rounded-lg text-sm`}><RefreshCw size={15} /> Test connection</button>
        {syncCfg?.enabled && <button onClick={onSyncNow} className={`flex items-center gap-1 ${t.chip} font-semibold px-4 py-2 rounded-lg text-sm`}><RefreshCw size={15} /> Sync now</button>}
      </div>
      {test && (
        <p className={`text-xs mt-2 flex items-center gap-1 ${test === "ok" ? "text-emerald-600" : test === "testing" ? t.sub : "text-red-500"}`}>
          {test === "testing" ? <><RefreshCw size={13} className="animate-spin" /> Testing…</> : test === "ok" ? <><CheckCircle size={13} /> Server reachable</> : <><AlertCircle size={13} /> {test}</>}
        </p>
      )}
      {syncCfg?.enabled && <div className="mt-3"><SyncStatusBadge t={t} status={syncStatus} /></div>}
    </div>
  );
}

// Compact one-line sync state, shared by the operator banner and the settings card.
function SyncStatusBadge({ t, status }) {
  const { online, syncing, lastSync, pending, error } = status || {};
  const plural = (n) => `${n} change${n === 1 ? "" : "s"}`;
  let tone, icon, text;
  if (!online) {
    tone = "bg-amber-500/10 text-amber-600"; icon = <AlertCircle size={14} />;
    text = pending ? `Offline — ${plural(pending)} waiting to sync` : "Offline — will sync when back online";
  } else if (syncing) {
    tone = `bg-slate-500/10 ${t.sub}`; icon = <RefreshCw size={14} className="animate-spin" />; text = "Syncing…";
  } else if (error) {
    tone = "bg-red-500/10 text-red-600"; icon = <AlertCircle size={14} />; text = `Sync issue: ${error}`;
  } else {
    tone = "bg-emerald-500/10 text-emerald-600"; icon = <CheckCircle size={14} />;
    text = pending ? `${plural(pending)} pending` : `Synced · ${relTime(lastSync)}`;
  }
  return <div className={`text-xs rounded-lg px-3 py-2 flex items-center gap-2 ${tone}`}>{icon}{text}</div>;
}

/* ============================================================================
   OEE — shift output entry + machine rates settings
   ========================================================================== */
// Operator's units/scrap entry for the current shift. Upserts one record per
// (machine, shift, operator) — saving again replaces the counts, not stacks them.
function ShiftOutputCard({ t, myProduction, onSaveProduction, machine, otherEntries, onJump }) {
  const [units, setUnits] = useState("");
  const [scrap, setScrap] = useState("");
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState("");

  // Prefill from the stored record; also refreshes after a sync pulls an update.
  useEffect(() => {
    setUnits(myProduction ? String(myProduction.unitsProduced) : "");
    setScrap(myProduction ? String(myProduction.scrapCount) : "");
  }, [myProduction]);

  const save = async () => {
    setError("");
    const res = await onSaveProduction({ unitsProduced: units, scrapCount: scrap });
    if (res.ok) setSavedAt(Date.now());
    else setError(res.error || "Couldn't save. Try again.");
  };
  const dirty = units !== (myProduction ? String(myProduction.unitsProduced) : "") ||
                scrap !== (myProduction ? String(myProduction.scrapCount) : "");

  return (
    <div className={`${t.card} rounded-xl p-4`}>
      <h3 className="font-bold mb-1 flex items-center gap-2"><Factory size={16} /> Shift output</h3>
      <p className={`text-xs ${t.sub} mb-3`}>Units and scrap for this shift on {machine}. Used for the OEE score — update it whenever, it overwrites the previous entry.</p>
      <div className="flex gap-3 items-end flex-wrap">
        <label className="flex flex-col gap-1 flex-1 min-w-[110px]">
          <span className={`text-xs font-semibold ${t.sub}`}>UNITS PRODUCED</span>
          <input type="number" inputMode="numeric" min="0" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="0"
            className={`border rounded-lg px-3 py-2.5 text-lg font-mono focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
        </label>
        <label className="flex flex-col gap-1 flex-1 min-w-[110px]">
          <span className={`text-xs font-semibold ${t.sub}`}>SCRAP / REJECT</span>
          <input type="number" inputMode="numeric" min="0" value={scrap} onChange={(e) => setScrap(e.target.value)} placeholder="0"
            className={`border rounded-lg px-3 py-2.5 text-lg font-mono focus:outline-none focus:ring-2 focus:ring-amber-400 ${t.input}`} />
        </label>
        <button onClick={save} disabled={units === "" || !dirty}
          className="flex items-center gap-1 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white font-bold px-5 py-3 rounded-lg">
          <CheckCircle size={16} /> Save
        </button>
      </div>
      {error && <p className="text-xs text-red-500 mt-2 flex items-center gap-1"><AlertCircle size={13} /> {error}</p>}
      {!error && savedAt && !dirty && <p className="text-xs text-emerald-600 mt-2 flex items-center gap-1"><CheckCircle size={13} /> Saved {relTime(savedAt)}</p>}
      {(otherEntries || []).length > 0 && (
        <p className={`text-xs ${t.sub} mt-2`}>
          This shift:{" "}
          {otherEntries.map((r, i) => (
            <span key={r.machine}>
              {i > 0 && " · "}
              <button onClick={() => onJump?.(r.machine)} className="underline decoration-dotted hover:text-emerald-500">
                {r.machine} {r.units}u/{r.scrap}s
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

// Supervisor settings: rated output (units/hour) per machine, for OEE Performance.
function RatesManager({ t, machines, rates, onChange }) {
  const setRate = (m, v) => {
    const next = { ...(rates || {}) };
    const n = Math.max(0, Number(v) || 0);
    if (n > 0) next[m] = n; else delete next[m];
    onChange(next);
  };
  return (
    <div className={`${t.card} rounded-xl p-4`}>
      <h3 className="font-bold mb-1 flex items-center gap-2"><TrendingUp size={16} /> Machine output rates</h3>
      <p className={`text-xs ${t.sub} mb-3`}>Rated output in units/hour per machine — the theoretical maximum used for the OEE Performance factor. Leave blank to skip Performance for that machine.</p>
      <div className="space-y-2">
        {machines.map((m) => (
          <label key={m} className="flex items-center gap-2 text-sm">
            <span className="flex-1 font-medium">{m}</span>
            <input type="number" inputMode="numeric" min="0" value={rates?.[m] ?? ""} onChange={(e) => setRate(m, e.target.value)} placeholder="—"
              className={`w-28 border rounded-lg px-3 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
            <span className={`text-xs ${t.sub} w-16`}>units/h</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// Supervisor settings: the shifts operators pick from. Each has a name, time
// frame, and a per-machine output goal ({ machine: units }) used for the
// operator's achievability check.
function ShiftsManager({ t, shifts, machines, onChange }) {
  const update = (id, patch) => onChange(shifts.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const remove = (id) => { if (shifts.length > 1) onChange(shifts.filter((s) => s.id !== id)); };
  const add = () => onChange([...shifts, { id: `shift-${Date.now().toString(36)}`, name: `Shift ${shifts.length + 1}`, start: "06:00", end: "14:00", goals: {} }]);
  // Set (or clear, when blank/0) one machine's goal within a shift.
  const setGoal = (s, m, v) => {
    const n = Math.max(0, Math.round(Number(v) || 0));
    const goals = { ...(s.goals || {}) };
    if (n > 0) goals[m] = n; else delete goals[m];
    update(s.id, { goals });
  };
  return (
    <div className={`${t.card} rounded-xl p-4`}>
      <h3 className="font-bold mb-1 flex items-center gap-2"><Clock size={16} /> Shifts</h3>
      <p className={`text-xs ${t.sub} mb-3`}>Time frames operators pick from. Used for uptime %, operator pace, and a per-machine output goal (units) that drives the operator's achievability check. Leave a machine blank for no goal.</p>
      <div className="space-y-3">
        {shifts.map((s) => (
          <div key={s.id} className={`${t.muted} rounded-lg p-3 space-y-3`}>
            <div className="flex items-center gap-2">
              <input value={s.name} maxLength={24} onChange={(e) => update(s.id, { name: e.target.value })} placeholder="Shift name"
                className={`flex-1 border rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
              {shifts.length > 1 && (
                <button onClick={() => remove(s.id)} className="text-red-500 hover:text-red-600 p-1" title="Remove shift"><Trash2 size={16} /></button>
              )}
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex flex-col gap-1 text-xs"><span className={t.sub}>START</span><input type="time" value={s.start} onChange={(e) => update(s.id, { start: e.target.value })} className={`border rounded-lg px-3 py-2 ${t.input}`} /></label>
              <label className="flex flex-col gap-1 text-xs"><span className={t.sub}>END</span><input type="time" value={s.end} onChange={(e) => update(s.id, { end: e.target.value })} className={`border rounded-lg px-3 py-2 ${t.input}`} /></label>
              <span className={`text-sm ${t.sub} self-end pb-2`}>= {fmtDur(shiftLengthMs(s))}</span>
            </div>
            <div>
              <span className={`text-xs font-semibold ${t.sub}`}>OUTPUT GOALS (units per machine)</span>
              <div className="mt-1 space-y-1.5">
                {machines.map((m) => (
                  <label key={m} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 truncate">{m}</span>
                    <input type="number" inputMode="numeric" min="0" value={s.goals?.[m] ?? ""} onChange={(e) => setGoal(s, m, e.target.value)} placeholder="none"
                      className={`w-24 border rounded-lg px-3 py-1.5 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
                    <span className={`text-xs ${t.sub} w-10`}>units</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      <button onClick={add} className={`mt-3 w-full flex items-center justify-center gap-2 text-sm font-semibold py-2 rounded-lg ${t.chip} active:scale-95`}><Plus size={16} /> Add shift</button>
    </div>
  );
}

/* ============================================================================
   SHIFT HANDOVER — recipients settings + report modal
   ========================================================================== */
function HandoverEmailsManager({ t, emails, onChange }) {
  const [input, setInput] = useState((emails || []).join(", "));
  useEffect(() => { setInput((emails || []).join(", ")); }, [emails]);
  const save = () => {
    const list = input.split(/[,;\s]+/).map((e) => e.trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    onChange(list);
    setInput(list.join(", "));
  };
  return (
    <div className={`${t.card} rounded-xl p-4`}>
      <h3 className="font-bold mb-1 flex items-center gap-2"><PencilLine size={16} /> Handover email recipients</h3>
      <p className={`text-xs ${t.sub} mb-3`}>Who receives the shift handover report when an operator taps “Email report”. Requires the sync server with SMTP configured. Comma-separated.</p>
      <div className="flex gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="supervisor@factory.com, lead@factory.com"
          className={`flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
        <button onClick={save} className="flex items-center gap-1 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold px-4 rounded-lg text-sm"><CheckCircle size={15} /> Save</button>
      </div>
      {(emails || []).length > 0 && <p className={`text-xs ${t.sub} mt-2`}>{emails.length} recipient{emails.length === 1 ? "" : "s"} saved.</p>}
    </div>
  );
}

function ShiftHandoverModal({ t, dark, report, handoverEmails, syncCfg, onClose }) {
  const [copied, setCopied] = useState(false);
  const [mailState, setMailState] = useState(null); // null | "sending" | "sent" | error string
  const text = formatReportText(report);
  const canEmail = !!(syncCfg && syncCfg.enabled && syncCfg.url) && (handoverEmails || []).length > 0;

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2500); }
    catch {
      // Clipboard API can be blocked (permissions / non-secure context); fall
      // back to a temp textarea + execCommand, which works on file:// too.
      try {
        const ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
        setCopied(true); setTimeout(() => setCopied(false), 2500);
      } catch { /* leave button as-is */ }
    }
  };

  const email = async () => {
    setMailState("sending");
    const res = await api.sendReport({
      to: handoverEmails,
      subject: `StopTrack handover — ${report.machine} — ${report.operator}`,
      text,
    }, syncCfg);
    setMailState(res.ok ? "sent" : (res.error || "Send failed"));
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-30" onClick={onClose}>
      <div className={`${dark ? "bg-slate-900" : "bg-white"} rounded-xl shadow-xl p-5 max-w-md w-full space-y-3 max-h-[85vh] overflow-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold"><PencilLine size={18} className="text-emerald-500" /> Shift handover</div>
          <button onClick={onClose} aria-label="Close" className={`${t.sub} hover:text-red-500 p-1`}><X size={18} /></button>
        </div>
        <pre className={`${t.muted} rounded-lg p-3 text-xs whitespace-pre-wrap font-mono leading-relaxed`}>{text}</pre>
        <div className="flex flex-col gap-2">
          <button onClick={copy} className="flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-3 rounded-lg">
            {copied ? <><CheckCircle size={17} /> Copied</> : <><PencilLine size={17} /> Copy summary</>}
          </button>
          <button onClick={email} disabled={!canEmail || mailState === "sending" || mailState === "sent"}
            className={`flex items-center justify-center gap-2 ${t.accentBtn} disabled:opacity-40 font-bold py-3 rounded-lg`}>
            {mailState === "sending" ? <><RefreshCw size={17} className="animate-spin" /> Sending…</>
              : mailState === "sent" ? <><CheckCircle size={17} /> Sent</>
              : <><RefreshCw size={17} /> Email report{(handoverEmails || []).length ? ` (${handoverEmails.length})` : ""}</>}
          </button>
          {!canEmail && <p className={`text-[11px] ${t.sub} text-center`}>Email needs Server sync enabled and recipients set in Supervisor → Settings. Copy works offline.</p>}
          {mailState && mailState !== "sending" && mailState !== "sent" && <p className="text-xs text-red-500 text-center flex items-center justify-center gap-1"><AlertCircle size={13} /> {mailState}</p>}
        </div>
      </div>
    </div>
  );
}
