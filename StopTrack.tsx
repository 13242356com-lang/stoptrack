import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Play, Square, Pause, Clock, Factory, AlertCircle, BarChart3, List, User,
  RefreshCw, Trash2, CheckCircle, Settings, Plus, X, Download, Search,
  Moon, Sun, TrendingUp, RotateCcw, Zap, Archive, Sparkles, Lock, Unlock, PencilLine, Target,
  Share2, LogOut,
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
  "Operator break", "Electrical fault", "No operator", "Other",
];
// The reason written by the "Off machine" button. These machines only produce
// while they run, and they only run with someone at them — so an operator being
// away IS downtime, recorded as an ordinary stop rather than a separate bucket.
const OFF_MACHINE_REASON = "No operator";
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

// How long after a shift ends its stops still count as that shift's — an operator
// finishing up or running over shouldn't have the board reset under them.
const SHIFT_OVERTIME_GRACE_MS = 2 * 60 * 60 * 1000;

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

/**
 * The occurrence of `shift` that CONTAINS `now` (or, if the shift hasn't started
 * yet today, the one that started yesterday) as `{start, end}` epoch ms.
 *
 * This is what "this shift" means. It rolls over on the clock, so an operator who
 * forgets to tap "New Shift" doesn't accumulate a multi-day window — the bug that
 * had a night operator credited with 21 hours of manned time on one machine.
 * Overnight shifts wrap correctly because shiftLengthMs already handles them.
 */
function shiftWindowAt(shift, now = Date.now()) {
  if (!shift?.start) return null;
  const [sh, sm] = shift.start.split(":").map(Number);
  if (Number.isNaN(sh) || Number.isNaN(sm)) return null;
  const d = new Date(now);
  d.setHours(sh, sm, 0, 0);
  let start = d.getTime();
  if (start > now) start -= 24 * 60 * 60 * 1000; // today's start is still ahead → yesterday's occurrence
  const len = shiftLengthMs(shift) || 24 * 60 * 60 * 1000;
  return { start, end: start + len };
}

// Coerce a shifts array (or a legacy single `shift`) into a valid, non-empty list
// of {id,name,start,end,goal}. Returns null if there's nothing usable.
function normalizeShifts(shiftsArr, legacyShift) {
  // A per-machine goals map: { machine: units } with positive integers only.
  const cleanGoals = (raw) => {
    const out = Object.create(null); // keyed by machine NAME — user string
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

// A duration that arrived from somewhere else. Anything non-finite or negative
// becomes 0: a bad value must never poison the totals it is summed into, and
// downtime the app cannot vouch for is better reported as none than as NaN or as
// a negative that quietly cancels out real minutes.
const sanitizeDuration = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
// Is this the same operator? Names are typed by hand, shift after shift, so
// "bob", "Bob" and " Bob " are one person. Matching them exactly emptied the
// whole board — 0 stops, 0 downtime — with no hint that the name was the reason.
const sameOperator = (a, b) =>
  String(a == null ? "" : a).trim().toLowerCase() === String(b == null ? "" : b).trim().toLowerCase();
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
function buildShiftReport({ operator, machine, myStops, myShift, clearedBefore, activeShift, goalStatus, note, flags }) {
  const downtimeMs = myStops.reduce((a, s) => a + s.duration, 0);
  const byReason = Object.create(null); // see the operator breakdown: "__proto__" as a reason
  myStops.forEach((s) => { byReason[s.reason] = (byReason[s.reason] || 0) + s.duration; });
  const topReasons = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
  const longest = myStops.reduce((best, s) => (!best || s.duration > best.duration ? s : best), null);

  // Per-machine reasons. Without this the handout is one blended total: a
  // roaming operator's three machines all read the same downtime, and the next
  // shift can't tell which one is actually in trouble. Worst machine first,
  // because that's the one they need to know about.
  const perMachine = Object.create(null); // keyed by machine NAME — user string
  myStops.forEach((s) => {
    const bag = (perMachine[s.machine] = perMachine[s.machine] || Object.create(null));
    bag[s.reason] = (bag[s.reason] || 0) + s.duration;
  });
  const machines = (myShift.rows || []).map((row) => {
    const top = Object.entries(perMachine[row.machine] || {}).sort((a, b) => b[1] - a[1])[0];
    return { ...row, topReason: top ? top[0] : null, topReasonMs: top ? top[1] : 0 };
  }).sort((a, b) => (b.downtimeMs - a.downtimeMs) || (b.mannedMs - a.mannedMs));

  return {
    operator: operator.trim() || "Unnamed", machine,
    shiftName: activeShift?.name || null,
    windowStart: clearedBefore || null, windowEnd: Date.now(),
    stopCount: myStops.length, downtimeMs, topReasons, longest,
    machines, hasSessions: myShift.hasSessions,
    oee: myShift.overall, goal: goalStatus || null,
    notes: myStops.filter((s) => s.notes).map((s) => ({ reason: s.reason, notes: s.notes })),
    // The human layer, written by the operator at handover time.
    note: (note || "").trim(),
    flags: (flags || []).filter((f) => f && f.text && f.text.trim()),
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
      if (m.topReason) bits.push(`mostly ${m.topReason} (${fmtDur(m.topReasonMs)})`);
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
  // The operator's own handover message + carry-forward flags go last: they're
  // what the next shift actually acts on.
  if (r.note) { lines.push(""); lines.push("For the next shift:"); lines.push(`  ${r.note}`); }
  if (r.flags && r.flags.length) {
    lines.push("");
    lines.push("Flagged:");
    r.flags.forEach((f) => lines.push(`  - [${FLAG_LEVELS[f.level]?.word || "Note"}] ${f.text}`));
  }
  return lines.join("\n");
}

/* ============================================================================
   SHIFT HANDOUT — the shareable card.
   ----------------------------------------------------------------------------
   The handover leaves the app as ONE image (that's how operators actually send
   it), so the card is drawn straight onto a <canvas>: no library, works offline
   and inside the APK's WebView, and the preview shown in the modal IS the PNG
   that gets shared — one source of truth, no HTML/canvas drift.
   ========================================================================== */

// Operator-chosen severity for a flag. The operator writes the words; the level
// only decides the colour so a supervisor can triage at a glance.
const FLAG_LEVELS = {
  fix:   { word: "Fix",   label: "Fix",   ink: "#f39a9a", bg: "rgba(239,68,68,.13)",  line: "rgba(239,68,68,.34)",  mark: "⚑" },
  watch: { word: "Watch", label: "Watch", ink: "#f6c265", bg: "rgba(245,158,11,.14)", line: "rgba(245,158,11,.34)", mark: "⚠" },
  info:  { word: "Info",  label: "Info",  ink: "#c2cbe0", bg: "rgba(148,163,208,.12)", line: "#26324a",             mark: "●" },
};
const FLAG_ORDER = ["watch", "fix", "info"];

const HANDOUT = {
  W: 440, PAD: 24, PADR: 20,
  bg1: "#0d1524", bg2: "#0b1220", surf2: "#0f1826", line: "#26324a",
  ink: "#f2f6fc", ink2: "#aeb9cd", ink3: "#6b7690",
  brand: "#10b981", down: "#ef4444", warn: "#f59e0b",
  sans: '-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  mono: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace',
};

// Compact time/duration just for the card: a handout is read at a glance, so
// "23:03" and "22m" beat "Jul 26, 11:03:41 PM" and "22m 0s".
function shortTime(ms) {
  try { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }); }
  catch { return fmtTime(ms); }
}
function shortDur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return `${sec >= 30 ? m + 1 : m}m`;
  return `${sec}s`;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Shorten `text` with an ellipsis until it fits `maxW` at the ctx's current font.
function ellipsize(ctx, text, maxW) {
  let s = String(text || "");
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

// Greedy word wrap. Returns the lines that fit `maxW` at the ctx's current font.
function wrapText(ctx, text, maxW) {
  const out = [];
  String(text || "").split(/\n+/).forEach((para) => {
    let line = "";
    para.split(/\s+/).filter(Boolean).forEach((word) => {
      // A single token longer than the line (a pasted ticket URL, a part number)
      // is broken on characters — never allowed to run off the card.
      let w = word;
      while (ctx.measureText(w).width > maxW && w.length > 1) {
        let cut = w.length;
        while (cut > 1 && ctx.measureText(w.slice(0, cut)).width > maxW) cut--;
        if (line) { out.push(line); line = ""; }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width <= maxW || !line) line = test;
      else { out.push(line); line = w; }
    });
    if (line) out.push(line);
  });
  return out;
}

// Lay flag chips out into rows that fit the content width. A chip is never wider
// than the box it sits in: the operator's words get clipped with an ellipsis
// rather than running off the edge of the image the next shift receives.
function layoutFlags(ctx, flags, maxW) {
  ctx.font = `600 11.5px ${HANDOUT.sans}`;
  const rows = [];
  let row = [], rowW = 0;
  (flags || []).forEach((f) => {
    const lv = FLAG_LEVELS[f.level] || FLAG_LEVELS.info;
    const text = ellipsize(ctx, f.text, maxW - 22 - ctx.measureText(`${lv.mark}  `).width);
    const w = ctx.measureText(`${lv.mark}  ${text}`).width + 22;
    if (row.length && rowW + w + 7 > maxW) { rows.push(row); row = []; rowW = 0; }
    row.push({ text, w, lv });
    rowW += w + 7;
  });
  if (row.length) rows.push(row);
  return rows;
}

/**
 * Draw the handout and return { dataUrl, width, height }.
 * `scale` is the pixel density of the exported PNG (2.5 → ~1100px wide, which
 * looks crisp in a chat app without being a huge file).
 */
function drawHandout(r, scale = 2.5) {
  const H = HANDOUT;
  const contentW = H.W - H.PAD - H.PADR;
  const meas = document.createElement("canvas").getContext("2d");

  // ---- measure the variable blocks so the canvas is exactly tall enough -----
  meas.font = `13.5px ${H.sans}`;
  const noteLines = r.note ? wrapText(meas, r.note, contentW - 32) : [];
  const flagRows = r.flags && r.flags.length ? layoutFlags(meas, r.flags, contentW - 32) : [];
  const reasons = (r.topReasons || []).slice(0, 5);

  // Per-machine rows, worst first. Only when the operator actually roamed —
  // for a single machine the tiles above already say everything.
  const machineRows = (r.machines || []).length > 1 ? r.machines.slice(0, 6) : [];

  const showGoal = r.goalPct != null;
  const hHeader = 74, hWho = 40, hTiles = 2 * 74 + 1, hGoal = showGoal ? 92 : 0;
  const hMachines = machineRows.length ? 34 + machineRows.length * 32 + 12 : 0;
  const hReasons = reasons.length ? 34 + reasons.length * 23 + (r.longest ? 22 : 0) + 12 : 0;
  const hNoteBox = (noteLines.length || flagRows.length)
    ? 16 + 24 + noteLines.length * 19 + (flagRows.length ? 8 + flagRows.length * 27 : 0) + 14
    : 0;
  const hNote = hNoteBox ? hNoteBox + 26 : 0;
  const hFoot = 42;
  const total = hHeader + hWho + hTiles + hGoal + hMachines + hReasons + hNote + hFoot;

  const cv = document.createElement("canvas");
  cv.width = Math.round(H.W * scale);
  cv.height = Math.round(total * scale);
  const c = cv.getContext("2d");
  c.scale(scale, scale);
  c.textBaseline = "alphabetic";

  const goalState = (r.goal && r.goal.state) || "na";
  const health = goalState === "missed" ? H.down : goalState === "risk" ? H.warn : H.brand;
  const goalColor = health;

  // ---- ground ---------------------------------------------------------------
  const grad = c.createLinearGradient(0, 0, 0, total);
  grad.addColorStop(0, H.bg1); grad.addColorStop(0.4, H.bg2); grad.addColorStop(1, H.bg2);
  c.fillStyle = grad; c.fillRect(0, 0, H.W, total);
  c.fillStyle = health; c.fillRect(0, 0, 5, total);   // health stripe

  const rule = (y) => { c.fillStyle = H.line; c.fillRect(0, y, H.W, 1); };
  const label = (txt, x, y, color) => {
    c.font = `700 10.5px ${H.sans}`; c.fillStyle = color || H.ink3;
    c.fillText(String(txt).toUpperCase(), x, y);
  };
  let y = 0;

  // ---- header ---------------------------------------------------------------
  c.fillStyle = "rgba(16,185,129,.16)";
  roundRect(c, H.PAD, 18, 38, 38, 11); c.fill();
  c.strokeStyle = H.brand; c.lineWidth = 2.2; c.lineJoin = "round"; c.lineCap = "round";
  c.beginPath();                                     // little factory glyph
  c.moveTo(H.PAD + 9, 45); c.lineTo(H.PAD + 29, 45);
  c.moveTo(H.PAD + 11, 45); c.lineTo(H.PAD + 11, 30); c.lineTo(H.PAD + 17, 34);
  c.lineTo(H.PAD + 17, 30); c.lineTo(H.PAD + 23, 34); c.lineTo(H.PAD + 23, 27);
  c.lineTo(H.PAD + 29, 31); c.lineTo(H.PAD + 29, 45);
  c.stroke();
  label("StopTrack", H.PAD + 49, 32);
  c.font = `800 19px ${H.sans}`; c.fillStyle = H.ink;
  c.fillText("Shift Handout", H.PAD + 49, 51);
  // Date + shift window sit on their own right-hand column; the window uses
  // 24h times so it can never grow into the title.
  c.textAlign = "right";
  c.font = `700 12.5px ${H.sans}`; c.fillStyle = H.ink;
  c.fillText(r.dateLabel || "", H.W - H.PADR, 34);
  c.font = `11.5px ${H.sans}`; c.fillStyle = H.ink2;
  c.fillText(r.shiftLabel || "", H.W - H.PADR, 51);
  c.textAlign = "left";
  y = hHeader;

  // ---- who → who ------------------------------------------------------------
  const av = H.PAD + 13;
  c.fillStyle = H.brand; c.beginPath(); c.arc(av, y + 13, 13, 0, Math.PI * 2); c.fill();
  c.font = `800 12px ${H.sans}`; c.fillStyle = "#04140e"; c.textAlign = "center";
  c.fillText((r.operator || "?").trim().charAt(0).toUpperCase(), av, y + 17);
  c.textAlign = "left";
  // The machine pill is measured FIRST so the operator name gets a real width
  // budget — a long name (or a long machine label) must never overprint it.
  const nameX = H.PAD + 34;
  let pillX = H.W - H.PADR;
  {
    c.font = `11.5px ${H.sans}`;
    const mt = ellipsize(c, r.machineLabel || r.machine || "", 150);
    const w = c.measureText(mt).width + 28;
    pillX = H.W - H.PADR - w;
    c.fillStyle = H.surf2; roundRect(c, pillX, y + 2, w, 24, 12); c.fill();
    c.strokeStyle = H.line; c.lineWidth = 1; c.stroke();
    c.fillStyle = H.brand; c.beginPath(); c.arc(pillX + 12, y + 14, 3, 0, Math.PI * 2); c.fill();
    c.fillStyle = H.ink2; c.fillText(mt, pillX + 20, y + 18);
  }
  {
    const budget = pillX - 10 - nameX;
    c.font = `14px ${H.sans}`;
    const tailW = c.measureText(" →  next shift").width;
    c.font = `700 14px ${H.sans}`; c.fillStyle = H.ink;
    // Drop the "→ next shift" tail before ever truncating the operator's name.
    const showTail = c.measureText(r.operator).width + tailW <= budget;
    const name = ellipsize(c, r.operator, showTail ? budget - tailW : budget);
    c.fillText(name, nameX, y + 18);
    if (showTail) {
      let x = nameX + c.measureText(name).width + 8;
      c.fillStyle = H.brand; c.fillText("→", x, y + 18); x += 18;
      c.font = `14px ${H.sans}`; c.fillStyle = H.ink2; c.fillText("next shift", x, y + 18);
    }
  }
  y += hWho;

  // ---- 2×2 metric tiles -----------------------------------------------------
  rule(y);
  const tiles = r.tiles || [];
  const colW = H.W / 2;
  tiles.slice(0, 4).forEach((tl, i) => {
    const tx = (i % 2 === 0 ? H.PAD : colW + 16);
    const ty = y + 1 + Math.floor(i / 2) * 74;
    label(tl.lab, tx, ty + 22);
    c.font = `600 27px ${H.mono}`; c.fillStyle = tl.color || H.ink;
    c.fillText(tl.val, tx, ty + 52);
    if (tl.unit) {
      const w = c.measureText(tl.val).width;
      c.font = `500 14px ${H.mono}`; c.fillStyle = H.ink2; c.fillText(tl.unit, tx + w + 3, ty + 52);
    }
    if (tl.sub) { c.font = `11px ${H.sans}`; c.fillStyle = H.ink3; c.fillText(tl.sub, tx, ty + 67); }
  });
  c.fillStyle = H.line;
  c.fillRect(colW, y + 1, 1, hTiles - 2);            // vertical divider
  c.fillRect(0, y + 1 + 74, H.W, 1);                 // horizontal divider
  y += hTiles; rule(y);

  // ---- goal -----------------------------------------------------------------
  if (showGoal) {
    label("Goal", H.PAD, y + 24);
    const cx = H.PAD + 23, cy = y + 56, rad = 15;
    c.lineWidth = 5; c.strokeStyle = H.surf2;
    c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = goalColor; c.lineCap = "round";
    c.beginPath(); c.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.001, r.goalPct / 100)); c.stroke();
    c.font = `600 11px ${H.mono}`; c.fillStyle = H.ink; c.textAlign = "center";
    c.fillText(`${Math.round(r.goalPct)}%`, cx, cy + 4); c.textAlign = "left";
    const gx = H.PAD + 52;
    { // status pill
      c.font = `700 11px ${H.sans}`;
      const w = c.measureText(r.goalLabel).width + 18;
      c.fillStyle = goalState === "missed" ? "rgba(239,68,68,.15)" : goalState === "risk" ? "rgba(245,158,11,.15)" : "rgba(16,185,129,.15)";
      roundRect(c, gx, y + 34, w, 20, 10); c.fill();
      c.fillStyle = goalState === "missed" ? "#fb8a8a" : goalState === "risk" ? "#facc6b" : "#4ee0af";
      c.fillText(r.goalLabel, gx + 9, y + 48);
      c.font = `600 13px ${H.mono}`; c.fillStyle = H.ink;
      c.fillText(r.goalNum || "", gx + w + 8, y + 48);
    }
    if (r.goalSlack) { c.font = `11.5px ${H.sans}`; c.fillStyle = H.ink3; c.fillText(r.goalSlack, gx, y + 64); }
    const bw = H.W - H.PADR - gx;
    c.fillStyle = H.surf2; roundRect(c, gx, y + 72, bw, 8, 4); c.fill();
    c.fillStyle = goalColor; roundRect(c, gx, y + 72, Math.max(3, bw * Math.min(1, r.goalPct / 100)), 8, 4); c.fill();
    y += hGoal; rule(y);
  }

  // ---- per machine ----------------------------------------------------------
  // The fix for a roaming operator's handout: without this every machine reads
  // the same blended downtime and the next shift can't tell which one is sick.
  if (machineRows.length) {
    label("Downtime by machine", H.PAD, y + 24);
    const maxDown = machineRows.reduce((mx, m) => Math.max(mx, m.downtimeMs || 0), 0) || 1;
    const nameW = 132, valW = 50;
    const barX = H.PAD + nameW + 10;
    const barW = H.W - H.PADR - valW - 8 - barX;
    machineRows.forEach((m, i) => {
      const ry = y + 34 + i * 32;
      c.font = `700 12.5px ${H.sans}`; c.fillStyle = H.ink;
      c.fillText(ellipsize(c, m.machine, nameW), H.PAD, ry + 11);
      // What actually happened on THIS machine, not the shift average.
      const bits = [`${m.stops} stop${m.stops === 1 ? "" : "s"}`];
      if (r.hasSessions && m.mannedMs) bits.push(shortDur(m.mannedMs));
      if (m.topReason) bits.push(m.topReason);
      c.font = `10.5px ${H.sans}`; c.fillStyle = H.ink3;
      c.fillText(ellipsize(c, bits.join(" · "), nameW + 40), H.PAD, ry + 25);

      c.fillStyle = H.surf2; roundRect(c, barX, ry, barW, 14, 4); c.fill();
      c.strokeStyle = H.line; c.lineWidth = 1; c.stroke();
      const w = Math.max(3, barW * ((m.downtimeMs || 0) / maxDown));
      const g3 = c.createLinearGradient(barX, 0, barX + w, 0);
      g3.addColorStop(0, "#b23636"); g3.addColorStop(1, H.down);
      c.fillStyle = g3; roundRect(c, barX, ry, w, 14, 4); c.fill();
      c.font = `12px ${H.mono}`; c.fillStyle = H.ink2; c.textAlign = "right";
      c.fillText(shortDur(m.downtimeMs || 0), H.W - H.PADR, ry + 11); c.textAlign = "left";
    });
    y += hMachines; rule(y);
  }

  // ---- downtime by reason ---------------------------------------------------
  if (reasons.length) {
    label("Downtime by reason", H.PAD, y + 24);
    const max = reasons[0][1] || 1;
    const nameW = 112, valW = 50;
    const barX = H.PAD + nameW + 10;
    const barW = H.W - H.PADR - valW - 8 - barX;
    reasons.forEach(([name, ms], i) => {
      const ry = y + 34 + i * 23;
      c.font = `12.5px ${H.sans}`; c.fillStyle = H.ink;
      let nm = name;
      while (c.measureText(nm).width > nameW && nm.length > 3) nm = nm.slice(0, -2);
      if (nm !== name) nm += "…";
      c.fillText(nm, H.PAD, ry + 11);
      c.fillStyle = H.surf2; roundRect(c, barX, ry, barW, 14, 4); c.fill();
      c.strokeStyle = H.line; c.lineWidth = 1; c.stroke();
      const w = Math.max(3, barW * (ms / max));
      const g2 = c.createLinearGradient(barX, 0, barX + w, 0);
      g2.addColorStop(0, "#b23636"); g2.addColorStop(1, H.down);
      c.fillStyle = g2; roundRect(c, barX, ry, w, 14, 4); c.fill();
      c.font = `12px ${H.mono}`; c.fillStyle = H.ink2; c.textAlign = "right";
      c.fillText(shortDur(ms), H.W - H.PADR, ry + 11); c.textAlign = "left";
    });
    if (r.longest) {
      const ly = y + 34 + reasons.length * 23 + 12;
      c.font = `12px ${H.sans}`; c.fillStyle = H.ink2;
      // Name the machine when there was more than one — "Longest: Tooling
      // change, 40m" is useless to the next shift if they don't know where.
      const lw = machineRows.length ? `${r.longest.machine} · ` : "";
      c.fillText(ellipsize(c, `Longest: ${lw}${r.longest.reason} · ${shortDur(r.longest.duration)} · ${shortTime(r.longest.start)}`, contentW), H.PAD, ly);
    }
    y += hReasons; rule(y);
  }

  // ---- the operator's message + flags ---------------------------------------
  if (hNoteBox) {
    const bx = H.PAD, bw = H.W - H.PADR - H.PAD, by = y + 14;
    c.fillStyle = "rgba(16,185,129,.055)";
    roundRect(c, bx, by, bw, hNoteBox, 14); c.fill();
    c.strokeStyle = "rgba(16,185,129,.28)"; c.lineWidth = 1; c.stroke();
    label("For the next shift", bx + 16, by + 24, "#5fd8ac");
    let ny = by + 24;
    c.font = `13.5px ${H.sans}`; c.fillStyle = H.ink;
    noteLines.forEach((ln) => { ny += 19; c.fillText(ln, bx + 16, ny); });
    if (flagRows.length) {
      ny += 8;
      flagRows.forEach((row) => {
        ny += 27;
        let fx = bx + 16;
        row.forEach((f) => {
          c.fillStyle = f.lv.bg; roundRect(c, fx, ny - 15, f.w, 21, 7); c.fill();
          c.strokeStyle = f.lv.line; c.lineWidth = 1; c.stroke();
          c.font = `600 11.5px ${H.sans}`; c.fillStyle = f.lv.ink;
          c.fillText(`${f.lv.mark}  ${f.text}`, fx + 11, ny);
          fx += f.w + 7;
        });
      });
    }
    y += hNote;
  }

  // ---- footer ---------------------------------------------------------------
  rule(y);
  c.font = `11px ${H.sans}`; c.fillStyle = H.ink3;
  c.fillText(`Generated ${shortTime(r.windowEnd)} · via StopTrack`, H.PAD, y + 26);

  return { dataUrl: cv.toDataURL("image/png"), width: cv.width, height: cv.height };
}

// Shape the raw report into the handout's display fields (tiles, labels, goal).
function handoutViewModel(r) {
  const a = r.oee || {};
  const goal = r.goal && r.goal.state !== "na" ? r.goal : null;
  const produced = goal ? goal.produced : null;
  const tiles = [
    { lab: "Stops", val: String(r.stopCount) },
    { lab: "Downtime", val: shortDur(r.downtimeMs), color: r.downtimeMs ? HANDOUT.down : HANDOUT.ink },
    { lab: "Availability", val: a.a != null ? String(Math.round(a.a * 100)) : "—", unit: a.a != null ? "%" : "",
      color: a.a == null ? HANDOUT.ink : a.a >= 0.9 ? HANDOUT.brand : a.a >= 0.75 ? HANDOUT.warn : HANDOUT.down,
      sub: `OEE ${a.partial ? "partial · " : ""}${pct(a.oee)}` },
    goal
      ? { lab: "Output", val: String(produced), unit: ` / ${goal.goal}`, sub: "units",
          color: goal.state === "met" ? HANDOUT.brand : goal.state === "missed" ? HANDOUT.down : HANDOUT.warn }
      : { lab: "Machines", val: String((r.machines || []).length || 1), sub: (r.machines || []).map((m) => m.machine).join(", ").slice(0, 30) },
  ];
  const goalPct = goal && goal.goal ? Math.max(0, Math.min(100, (goal.produced / goal.goal) * 100)) : null;
  const goalLabel = !goal ? "" : goal.state === "met" ? "Goal met" : goal.state === "missed" ? "Goal not achievable"
    : goal.state === "risk" ? "Goal at risk" : "On track for goal";
  return {
    ...r,
    tiles,
    dateLabel: new Date(r.windowEnd).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
    shiftLabel: `${r.shiftName ? `${r.shiftName} · ` : ""}${r.windowStart ? shortTime(r.windowStart) : "start"}–${shortTime(r.windowEnd)}`,
    machineLabel: (r.machines || []).length > 1 ? `${r.machines.length} machines` : ((r.machines || [])[0]?.machine || r.machine),
    goalPct, goalLabel,
    goalNum: goal ? `${goal.produced} / ${goal.goal}` : "",
    goalSlack: !goal ? ""
      : goal.state === "met" ? "Goal met for this shift"
      : `Need ${goal.need} more${goal.slackMs != null ? ` · up to ${shortDur(goal.slackMs)} more downtime OK` : ""}`,
  };
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

// --- sharing an image (the shift handout) -----------------------------------
// A handout is sent, not filed, so "Share" is the primary action: the Android
// shell opens the system share sheet (WhatsApp / Teams / email), a modern browser
// uses the Web Share API, and anything else falls back to a plain download.
const dataUrlToBase64 = (dataUrl) => String(dataUrl || "").split(",")[1] || "";

function dataUrlToBlob(dataUrl) {
  const b64 = dataUrlToBase64(dataUrl);
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: "image/png" });
}

async function shareImage(dataUrl, filename, text) {
  const n = (typeof window !== "undefined") ? window.StopTrackNative : null;
  if (n && typeof n.shareImage === "function") {
    try { n.shareImage(filename, dataUrlToBase64(dataUrl), text || ""); return { ok: true, how: "native" }; }
    catch (e) { /* fall through */ }
  }
  try {
    const file = new File([dataUrlToBlob(dataUrl)], filename, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: text || "" });
      return { ok: true, how: "web-share" };
    }
  } catch (e) {
    if (e && e.name === "AbortError") return { ok: true, cancelled: true }; // user dismissed
  }
  return saveImage(dataUrl, filename);
}

function saveImage(dataUrl, filename) {
  const n = (typeof window !== "undefined") ? window.StopTrackNative : null;
  if (n && typeof n.saveImage === "function") {
    try { n.saveImage(filename, dataUrlToBase64(dataUrl)); return { ok: true, how: "native" }; }
    catch (e) { /* fall through */ }
  }
  try {
    const url = URL.createObjectURL(dataUrlToBlob(dataUrl));
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, how: "download" };
  } catch (e) { return { ok: false, error: "Couldn't save the image." }; }
}

// The last-write-wins clock for a stop record. Newer records were mutated more
// recently. Falls back through older fields for records saved before updatedAt
// existed, so mixed-vintage data still merges sanely.
// The record's last-write clock, CLAMPED to this device's own now. A phone with a
// wrong clock stamps its records far in the future; without the clamp it never
// accepts a supervisor's later edit (its local copy always looks newer), and it
// re-pushes that stale copy on every outbox reseed — so a discard would come back
// from the dead one round trip later. The server clamps too; both sides must, or
// the loop stays open. Only the future side is clamped, so a device that has
// merely been offline still merges correctly.
const stampOf = (s) => Math.min(s.updatedAt ?? s.loggedAt ?? s.end ?? s.start ?? 0, Date.now());

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

// Storage failures are shown to the OPERATOR verbatim, so they have to be words
// someone in gloves can act on. localStorage throws (it doesn't return falsy), so
// the exception used to reach the banner raw: "QuotaExceededError" told them
// nothing and looked like the stop was gone. It isn't — the finished stop is kept
// and Save can be tapped again — so say that, and say what to do about the cause.
function storageErrorMessage(e, what = "stop") {
  const raw = (e && (e.name || e.message)) || "";
  if (/quota|exceeded|full|NS_ERROR_DOM_QUOTA/i.test(String(raw))) {
    return `This device's storage is full, so the ${what} wasn't saved. It's still here — ask your supervisor to export and clear old stops, then tap Save again.`;
  }
  return `The ${what} didn't save, but it isn't lost — tap Save again. If it keeps failing, tell your supervisor.`;
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
        } else if (s.deleted) {
          survivors.push(s); // a tombstone has no measurement to coerce
        } else {
          // Coerce the duration at the READ boundary, so no consumer has to. A
          // record can arrive from a sync pull, a restored backup, the Android
          // shell, or a future producer speaking the contract — one value of
          // "45000", -600000 or "abc" made every aggregate NaN (the supervisor's
          // cards read "NaNs" / "NaN%") and exported -600s. Reporting downtime the
          // app cannot vouch for as 0 is honest; NaN and negatives are not.
          const clean = sanitizeDuration(s.duration);
          survivors.push(clean === s.duration ? s : { ...s, duration: clean });
        }
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
      // NEVER SHORTEN A MEASUREMENT. Ids for timed and off-machine stops are
      // derived from the measurement itself (see the id sites), so two tabs
      // documenting the ONE parked stop — or a frozen tab replaying an
      // off-machine close — land on this same key instead of inventing a second
      // record. Whoever writes last must not be able to trim the stop: a stale
      // tab finalizing a 1.2s snapshot of a 3.8s stop would otherwise silently
      // shorten real downtime. Take the widest window either side measured, and
      // never un-discard something a supervisor already discarded.
      let toWrite = record;
      try {
        const prevRaw = await STORE.get(key, SHARED).catch(() => STORE.get(key));
        const prev = prevRaw && prevRaw.value ? JSON.parse(prevRaw.value) : null;
        // A tombstone has no measurement to widen. Merging one produced a
        // malformed record ({deleted:true, start:null} carrying the resurrected
        // end/duration) that then synced to every peer — restoring a backup that
        // contained a delete was enough to create it. Either side being a
        // tombstone means write the incoming record verbatim.
        if (prev && !prev.deleted && !record.deleted) {
          toWrite = {
            ...record,
            start: Math.min(Number(prev.start) || record.start, record.start),
            end: Math.max(Number(prev.end) || 0, Number(record.end) || 0),
            duration: Math.max(Number(prev.duration) || 0, Number(record.duration) || 0),
            discarded: prev.discarded || record.discarded || false,
            discardReason: prev.discardReason ?? record.discardReason,
            discardedAt: prev.discardedAt ?? record.discardedAt,
          };
        }
      } catch (e) { /* unreadable previous value → just write ours */ }
      record = toWrite;
      try { await STORE.set(key, JSON.stringify(record), SHARED); }
      catch { await STORE.set(key, JSON.stringify(record)); } // some builds reject the scope flag
      const check = await STORE.get(key, SHARED).catch(() => STORE.get(key));
      if (!check || !check.value) return { ok: false, error: "The stop didn't save. Check storage and try again." };
      await this._enqueue(key);
      return { ok: true, record };
    } catch (e) {
      return { ok: false, error: storageErrorMessage(e, "stop") };
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

  // --- shift handovers -------------------------------------------------------
  // Each handout is kept as a record so the supervisor gets a history and the
  // next operator can carry forward whatever was still open. Synced like the
  // other collections via /handovers, so the supervisor sees every device's.
  async loadHandovers() {
    try {
      const res = await STORE.list("hand:", SHARED);
      const keys = res?.keys || [];
      const items = await Promise.all(keys.map(async (k) => {
        try { const r = await STORE.get(k, SHARED); return r ? { key: k, ...JSON.parse(r.value) } : null; }
        catch { return null; }
      }));
      const now = Date.now();
      const survivors = [];
      for (const h of items.filter(Boolean)) {
        if (h.createdAt && now - h.createdAt > RETENTION_MS) {
          try { await STORE.delete(h.key, SHARED); } catch { /* ignore */ }
        } else survivors.push(h);
      }
      survivors.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return { ok: true, records: survivors };
    } catch { return { ok: false, records: [] }; }
  },

  async saveHandover(record) {
    const key = `hand:${record.id}`;
    try {
      try { await STORE.set(key, JSON.stringify(record), SHARED); }
      catch { await STORE.set(key, JSON.stringify(record)); }
      await this._enqueue(key);
      return { ok: true, record };
    } catch (e) { return { ok: false, error: e?.message || "Couldn't save the handover." }; }
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
    const [config, prefs, stops, production, sessions, handovers] = await Promise.all([
      this.loadConfig(), this.loadPrefs(), this.loadStops(), this.loadProduction(), this.loadSessions(),
      this.loadHandovers(),
    ]);
    const strip = (arr) => (arr || []).map(({ key, ...rest }) => rest);
    return {
      app: "stoptrack", schema: 1, exportedAt: Date.now(),
      config: config || null,
      prefs: prefs || null,
      stops: strip(stops.stops),
      production: strip(production.records),
      sessions: strip(sessions.records),
      handovers: strip(handovers.records),
    };
  },
  async importAll(data) {
    if (!data || data.app !== "stoptrack") throw new Error("Not a StopTrack backup file.");
    const counts = { stops: 0, production: 0, sessions: 0, handovers: 0, configApplied: false };
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
      // SESSION-SCOPED prefs are not portable and must not ride in on a backup.
      // An `offMachine` span from the backed-up device became a LIVE span here:
      // one tap recorded 45 minutes of "No operator" downtime on a machine nobody
      // left, under the other device's operator name, below the 90-minute
      // confirmation threshold — the app inventing minutes through the documented
      // recovery flow. Restore one backup onto three new phones and each invents
      // its own copy. Who is standing here and which machine they are at is also
      // this device's business, not the backup's.
      const { offMachine, offMachineClosed, operator, machine, setupLocked, ...portable } = data.prefs;
      const merged = { ...cur, ...portable };
      // The New Shift cutoff only ever moves FORWARD — the same rule the cross-tab
      // reconciler follows. Restoring an older backup used to move it backwards,
      // re-merging the previous shift's stops into the current board and its
      // handout.
      merged.clearedBefore = Math.max(Number(cur.clearedBefore) || 0, Number(data.prefs.clearedBefore) || 0);
      await this.savePrefs(merged);
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
    counts.handovers = await mergeInto(data.handovers, (await this.loadHandovers()).records, (r) => this.saveHandover(r));
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
  // Drop ONLY the keys that were just pushed, re-reading the outbox first so
  // anything enqueued during the round trip survives. Clearing the whole outbox
  // after a push deleted those records permanently: nothing re-enqueues them and
  // seedOutboxWithAll only runs before the first poll, so a stop saved while a
  // push was in flight never reached the server — behind a green "Synced" badge.
  async clearFromOutbox(pushedKeys) {
    try {
      const done = new Set(pushedKeys || []);
      const keys = await this.getOutbox();
      await this.setOutbox(keys.filter((k) => !done.has(k)));
    } catch { /* ignore — a failed trim just re-pushes next flush, which is safe */ }
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
      const hand = await STORE.list("hand:", SHARED).catch(() => ({ keys: [] }));
      await this.setOutbox([...(stops?.keys || []), ...(prods?.keys || []), ...(sess?.keys || []), ...(hand?.keys || [])]);
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
    return res.ok ? { ok: true, serverTime: this._serverTime(res.data) } : res;
  },
  // A 200 whose body isn't the sync contract (captive-portal sign-in page, proxy
  // error, truncated response) parsed to {} and then `|| Date.now()` handed back
  // the CLIENT's clock as the server's time. The pull cursor only moves forward,
  // so one portal hit advanced it past everything on the server and that device
  // never saw the factory's downtime again — with a green "Synced" badge. A
  // serverTime we did not actually receive is null, and the caller must not
  // advance the cursor on it.
  _serverTime(data) {
    const t = Number(data && data.serverTime);
    return Number.isFinite(t) && t > 0 ? t : null;
  },
  async remotePull(since, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/stops?since=${since || 0}`, { token: cfg.token });
    return res.ok ? { ok: true, stops: res.data?.stops || [], serverTime: this._serverTime(res.data) } : res;
  },
  async remotePushProduction(records, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/production`, { token: cfg.token, method: "POST", body: { records } });
    return res.ok ? { ok: true, serverTime: this._serverTime(res.data) } : res;
  },
  async remotePullProduction(since, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/production?since=${since || 0}`, { token: cfg.token });
    return res.ok ? { ok: true, records: res.data?.records || [], serverTime: this._serverTime(res.data) } : res;
  },
  async remotePushSessions(records, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/sessions`, { token: cfg.token, method: "POST", body: { records } });
    return res.ok ? { ok: true, serverTime: this._serverTime(res.data) } : res;
  },
  async remotePushHandovers(records, cfg) {
    if (!records.length) return { ok: true };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/handovers`, { token: cfg.token, method: "POST", body: { records } });
    return res.ok ? { ok: true } : { ok: false, error: res.error || `HTTP ${res.status}` };
  },

  async remotePullHandovers(since, cfg) {
    if (!cfg?.url) return { ok: false, records: [] };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/handovers?since=${since || 0}`, { token: cfg.token });
    if (!res.ok) return { ok: false, records: [], error: res.error || `HTTP ${res.status}` };
    return { ok: true, records: res.data?.records || [], serverTime: this._serverTime(res.data) };
  },

  async remotePullSessions(since, cfg) {
    if (!cfg?.url) return { ok: false, error: "No server URL" };
    const res = await fetchJSON(`${cfg.url.replace(/\/$/, "")}/sessions?since=${since || 0}`, { token: cfg.token });
    return res.ok ? { ok: true, records: res.data?.records || [], serverTime: this._serverTime(res.data) } : res;
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
  // Same for the name, so the ended-but-undocumented autosave below is attributed
  // even though stop() is a stable callback.
  const operatorRef = useRef(operator);
  operatorRef.current = operator;

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
    // A device clock can move WHILE a stop is timing (NTP catching up when the
    // phone finds signal, someone fixing the date). Unclamped, a backwards jump
    // stored a NEGATIVE duration with end < start: it then subtracted from the
    // shift total, fmtDur rendered the negative sum as "0s", and 21 real minutes
    // of downtime reported as 0s with 100.0% uptime — better than reality, so
    // nobody would question it. It synced that way to every peer too.
    // Every other measurement path here already clamps (endOffMachine,
    // recoverFinalize, the manual modal); this was the one that didn't.
    const rawEnd = Date.now();
    const end = Math.max(Number(s.startTs) || rawEnd, rawEnd);
    const duration = Math.max(0, s.paused ? s.accumulated : s.accumulated + (end - s.segStart));
    setState(emptyTimer);
    // The finished stop is NOT cleared here: between "End Stop" and "Save stop"
    // it used to live only in React state, so a refresh while the reason picker
    // was open threw away real measured downtime with nothing to recover from.
    // Keep it in the same autosave slot, flagged `ended`, and the load path puts
    // the operator straight back in the document-stop card. No reason is invented
    // — documenting it is still their tap.
    api.saveInProgress({
      operator: operatorRef.current, machine: s.machine || machineRef.current,
      running: false, paused: false, ended: true,
      startTs: s.startTs, accumulated: duration, segStart: null,
      end, duration, savedAt: end,
    });
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
      // BANK what was already measured before the interruption. A running timer
      // autosaves `accumulated: 0` with an open segment, so resuming with the
      // raw `accumulated` threw away `savedAt - segStart` — every minute counted
      // before the tab was reloaded or discarded. A 10-minute breakdown resumed
      // and ended a minute later recorded 60s, keeping the original `start`, so
      // the record even disagreed with itself (end - start = 11m, duration = 1m).
      // `savedAt` is the last moment the page is known to have been alive; the
      // gap after it is NOT counted, so this under-counts rather than invents.
      // Same rule as the Android Timer.restore (8f1cdb5) and as recoverFinalize.
      const acc = Number(d.accumulated) || 0;
      const alive = Number(d.savedAt) || 0;
      const banked = alive > d.segStart ? acc + (alive - d.segStart) : acc;
      setState({ running: true, paused: false, startTs: d.startTs, accumulated: banked, segStart: Date.now(), machine: d.machine });
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

function useSync({ cfg, onRemoteStops, onRemoteProduction, onRemoteSessions, onRemoteHandovers, localConfig, onRemoteConfig }) {
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
  const onHandRef = useRef(onRemoteHandovers); onHandRef.current = onRemoteHandovers;
  const localCfgRef = useRef(localConfig); localCfgRef.current = localConfig;
  const onCfgRef = useRef(onRemoteConfig); onCfgRef.current = onRemoteConfig;
  const runningRef = useRef(false); // guards against overlapping flushes
  const configRejectedRef = useRef(false); // server refused our last settings write
  const badBodyRef = useRef(false); // a 200 arrived that wasn't the sync contract

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
        const handRows = records.filter((r) => r.key.startsWith("hand:"));
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
        if (handRows.length) {
          const res = await api.remotePushHandovers(handRows, c);
          if (!res.ok) { setStatus((s) => ({ ...s, syncing: false, error: res.error || "Push failed", pending: keys.length })); runningRef.current = false; return; }
        }
        // Clear only what we actually pushed, and only after every push
        // confirmed. `keys` was captured before the awaits above, so a stop saved
        // mid-flight is still queued — setOutbox([]) used to erase it for good.
        await api.clearFromOutbox(keys);
      }

      // 2) CONFIG — last-write-wins both directions.
      const localCfg = localCfgRef.current;
      const remoteCfg = await api.remoteGetConfig(c);
      const clampAt = (v) => Math.min(Number(v) || 0, Date.now());
      if (remoteCfg.ok && remoteCfg.config && clampAt(remoteCfg.updatedAt) > clampAt(localCfg?.updatedAt)) {
        onCfgRef.current?.(remoteCfg.config);
      } else if (localCfg && clampAt(localCfg.updatedAt) > (remoteCfg.ok ? clampAt(remoteCfg.updatedAt) : 0)) {
        const put = await api.remotePutConfig(localCfg, c);
        // The server reports when a write lost last-write-wins. Say so rather
        // than letting the supervisor's settings edit vanish without a word.
        if (put.ok && put.data && put.data.applied === false) configRejectedRef.current = true;
        else configRejectedRef.current = false;
      }

      // 3) PULL — stops and production, each behind its own cursor.
      // Only advance a cursor on a serverTime the SERVER actually sent. A null
      // means the 200 wasn't the sync contract (portal page, proxy error), and
      // moving the cursor on it would skip everything already on the server —
      // permanently, since cursors only move forward.
      const since = await api.getCursor();
      const pull = await api.remotePull(since, c);
      if (pull.ok) {
        if (pull.stops.length) await onStopsRef.current?.(pull.stops);
        if (pull.serverTime) await api.setCursor(pull.serverTime);
        else badBodyRef.current = true;
      }
      const prodSince = await api.getCursor("prod");
      const prodPull = await api.remotePullProduction(prodSince, c);
      if (prodPull.ok) {
        if (prodPull.records.length) await onProdRef.current?.(prodPull.records);
        if (prodPull.serverTime) await api.setCursor(prodPull.serverTime, "prod");
        else badBodyRef.current = true;
      }
      const sessSince = await api.getCursor("sess");
      const sessPull = await api.remotePullSessions(sessSince, c);
      if (sessPull.ok) {
        if (sessPull.records.length) await onSessRef.current?.(sessPull.records);
        if (sessPull.serverTime) await api.setCursor(sessPull.serverTime, "sess");
        else badBodyRef.current = true;
      }

      const handSince = await api.getCursor("hand");
      const handPull = await api.remotePullHandovers(handSince, c);
      if (handPull.ok) {
        if (handPull.records.length) await onHandRef.current?.(handPull.records);
        if (handPull.serverTime) await api.setCursor(handPull.serverTime, "hand");
        else badBodyRef.current = true;
      }

      const pending = (await api.getOutbox()).length;
      if (configRejectedRef.current) {
        setStatus({ online: true, lastSync: Date.now(), pending, syncing: false,
          error: "The server has newer settings — your last settings change wasn't applied." });
        runningRef.current = false;
        return;
      }
      const pullErr = !pull.ok ? (pull.error || "Pull failed") : !prodPull.ok ? (prodPull.error || "Pull failed") : !sessPull.ok ? (sessPull.error || "Pull failed") : !handPull.ok ? (handPull.error || "Pull failed") : null;
      // Say so when a 200 came back that wasn't the sync contract. Silence here is
      // how a captive-portal page read as "Synced - just now" while nothing synced.
      const bodyErr = badBodyRef.current
        ? "That address answered, but not like a StopTrack server — check the URL, or sign in to the Wi-Fi and try again."
        : null;
      badBodyRef.current = false;
      setStatus({ online: true, lastSync: Date.now(), pending, syncing: false, error: pullErr || bodyErr });
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

  // ...and actually CALL it. It was declared, exported and never invoked, so
  // `pending` only ever changed at the end of a completed flush — which is
  // exactly what cannot happen offline. The badge therefore read the generic
  // "Offline — will sync when back online" while a queue sat there, instead of
  // "N changes waiting to sync". Offline is when an operator most needs to know
  // the count, so poll it while sync is on: one storage read, no network.
  useEffect(() => {
    if (!enabled) return;
    refreshPending();
    const iv = setInterval(refreshPending, 10000);
    return () => clearInterval(iv);
  }, [enabled, refreshPending]);

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
  // Signature of the last stop saved, to dedupe a double-tap on Save in the shell
  // (whose reason picker is native-owned and clears a moment after recording).
  const lastSavedSigRef = useRef(null);
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
  // An open "off machine" span: the operator has stepped away from every
  // machine. Closing it writes an ordinary stop, so downtime, the reason
  // breakdown, exports and the handout all pick it up with no new plumbing.
  // { machine, operator, start } | null
  const [offMachine, setOffMachine] = useState(null);
  // `start` of the most recently CLOSED span, persisted alongside it. A second
  // tab that loaded during a span holds the same span in state, so when this tab
  // closes it, the peer's reconcile sees "no span" and would re-assert the dead
  // one — logging the same minutes a second time. This marker is how the peer
  // tells "never saw it" (re-assert) from "already recorded" (adopt the close).
  // A ref, not state: it must be readable from persistPrefs without churning its
  // dependencies.
  const offClosedRef = useRef(0);
  // shift handover report dialog + the log of handouts already given
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [handovers, setHandovers] = useState([]);
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

  // Slow tick so the shift window (and the OEE built on it) stays current even
  // when nothing else re-renders.
  const [slowTick, setSlowTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setSlowTick((n) => n + 1), 30000);
    return () => clearInterval(iv);
  }, []);

  // ---- what "this shift" means ---------------------------------------------
  // The window is driven by the CLOCK — the occurrence of the operator's chosen
  // shift that contains now — so it rolls over on its own. "New Shift" is a
  // manual "start early" on top of that, never the only thing that moves the
  // window. (Before this, the cutoff moved only when someone tapped the button,
  // so a forgotten tap produced a multi-day "shift".)
  const shiftWindow = useMemo(
    () => shiftWindowAt(activeShift, Date.now()),
    [activeShift, slowTick],
  );
  // Between shifts the clock resolves to the shift that has most recently STARTED,
  // which just before the next one begins is nearly 24h old — so the board would
  // show all of yesterday. Once we're past the shift end (plus a grace window for
  // overtime, during which stops still belong to the shift), the board goes fresh
  // instead: an operator arriving at 05:45 for an 06:00 shift starts clean, and a
  // stop logged in that gap is still visible because it lands after the boundary.
  const shiftStart = useMemo(() => {
    if (!shiftWindow) return clearedBefore || 0;
    const overtimeEnd = shiftWindow.end + SHIFT_OVERTIME_GRACE_MS;
    const base = Date.now() > overtimeEnd ? overtimeEnd : shiftWindow.start;
    return Math.max(base, clearedBefore || 0);
  }, [shiftWindow, clearedBefore, slowTick]);


  // Latest snapshots for the sync merges, without re-creating the merge callbacks
  // on every render.
  const stopsRef = useRef(stops); stopsRef.current = stops;
  const productionRef = useRef(production); productionRef.current = production;
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions;
  const handoversRef = useRef(handovers); handoversRef.current = handovers;
  const operatorRef = useRef(operator); operatorRef.current = operator;
  const machineRef = useRef(machine); machineRef.current = machine;

  // ---- prefs writer --------------------------------------------------------
  // Declared up here (not down with persistConfig) because the machine-switch
  // callbacks below have to persist through it, and a useCallback dependency is
  // read at render time — referencing it later in the file would be a TDZ error.
  const persistPrefs = useCallback((patch) => {
    // operator/machine/setupLocked are persisted so a locked setup survives a
    // page refresh. When unlocked we still write them, but the loader ignores
    // operator/machine unless setupLocked is true.
    // EVERY persisted pref must be listed here: savePrefs REPLACES the blob, so
    // anything missing from this base is erased by an unrelated write. (An open
    // `offMachine` span used to vanish the moment someone tapped the dark-mode
    // toggle, losing the operator's away time silently.)
    // And a patch must carry the NEW value of anything it is changing — the base
    // reads React state, which is still the old value in the same tick.
    api.savePrefs({ dark, lastReason, clearedBefore, operator, machine, setupLocked, shiftId, offMachine, offMachineClosed: offClosedRef.current, ...patch });
  }, [dark, lastReason, clearedBefore, operator, machine, setupLocked, shiftId, offMachine]);

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
    // Persist it, or a reload silently puts a locked operator back on the OLD
    // machine — and the next stop plus the presence span are then attributed to
    // a machine they aren't standing at. The patch carries the new value because
    // persistPrefs' base still reads the pre-switch state.
    persistPrefs({ machine: next });
    // Tell native too. The notification and the floating bubble keep their own
    // machine, so without this a stop started from either surface after a switch
    // was attributed to the machine the operator LEFT. Optional call: a plain
    // browser has no shell, and an older shell has no setMachine.
    try { nativeApi?.setMachine?.(next); } catch (e) { /* shell too old — ignore */ }
  }, [closeSession, openSession, persistPrefs]);

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
        // An open off-machine span survives a reload. It carries its own
        // operator/machine so it stays correctly attributed even when the setup
        // wasn't locked; a span older than this shift is dropped further down.
        // `restored` marks it for the one-time staleness check below; a live
        // span never carries it, so New Shift can't discard one.
        offClosedRef.current = Number(prefs.offMachineClosed) || 0;
        if (prefs.offMachine && prefs.offMachine.start) setOffMachine({ ...prefs.offMachine, restored: true });
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

      // Past handouts — newest first, so the handover dialog can offer the last
      // shift's still-open flags for carry-forward.
      const hand = await api.loadHandovers();
      setHandovers(hand.records);

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

      // A locked setup means "I'm working" — presence resumes on load. Not while
      // an off-machine span is being restored, though: the operator is away from
      // every machine, and opening presence here would credit manned time to a
      // machine they aren't standing at.
      if (prefs && prefs.setupLocked && prefs.operator && !(prefs.offMachine && prefs.offMachine.start)) {
        openSession(prefs.machine || (cfg?.machines?.[0]) || DEFAULT_MACHINES[0], prefs.operator);
      }

      const ip = await api.loadInProgress();
      if (ip && ip.startTs && ip.ended) {
        // A stop that was ENDED but never documented (the app closed while the
        // reason picker was open). The measurement is real and finished, so don't
        // ask "resume or finalize?" — put it straight back in the document-stop
        // card so the operator only has to pick a reason. No reason is invented.
        // The shell keeps its own `pending` natively, so this is browser-only.
        if (!(native && typeof native.startStop === "function")) {
          if (ip.operator) setOperator(ip.operator);
          setPendingStop({ start: ip.startTs, end: ip.end || ip.savedAt, duration: ip.duration || ip.accumulated || 0, machine: ip.machine });
          setReason((prefs && prefs.lastReason && (cfg?.reasons || DEFAULT_REASONS).includes(prefs.lastReason))
            ? prefs.lastReason : (cfg?.reasons?.[0] || DEFAULT_REASONS[0]));
          setNotes("");
        }
      } else if (ip && ip.startTs) setRecovered(ip);
    })();
  }, []);

  // Supervisor view polls for fresh data (other operators' stops on the same
  // device / shared scope). When server sync is on, the sync pull supersedes
  // this local re-read, so we skip it to avoid clobbering merged state.
  const refreshStops = useCallback(async () => {
    const result = await api.loadStops();
    setStops(result.stops);
  }, []);
  // Everything a board or a handout is computed from. Used by the cross-tab
  // storage listener, which is the only signal a peer tab gets.
  const refreshRecords = useCallback(async () => {
    const [st, prod, sess] = await Promise.all([api.loadStops(), api.loadProduction(), api.loadSessions()]);
    if (st.ok) setStops(st.stops);
    if (prod.ok && prod.records) setProduction(prod.records);
    if (sess.ok && sess.records) setSessions(sess.records);
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
        // The server stores records opaquely and any producer can speak the sync
        // contract (the watch, the phone bridge, a future PLC feed). One record
        // with duration "45000" or -600000 made every aggregate NaN — the
        // supervisor's Downtime and Uptime cards read "NaNs" / "NaN%" and the
        // export carried -600s — and it persisted locally, surviving reloads.
        // Coerce here, at the seam, rather than hardening every consumer.
        const rec = { ...r, key: `stop:${r.id}`, duration: sanitizeDuration(r.duration) };
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

  // Handovers pulled from other devices — this is what makes the supervisor's
  // handover log show the whole factory rather than only the phone in their hand.
  const applyRemoteHandovers = useCallback(async (incoming) => {
    const map = new Map(handoversRef.current.map((h) => [h.id, h]));
    const writes = [];
    for (const r of incoming) {
      const local = map.get(r.id);
      if (!local || stampOf(r) > stampOf(local)) {
        const rec = { ...r, key: `hand:${r.id}` };
        map.set(r.id, rec);
        writes.push(rec);
      }
    }
    if (!writes.length) return;
    await Promise.all(writes.map((w) => api.putLocal(w)));
    setHandovers([...map.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
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

  const sync = useSync({ cfg: syncCfg, onRemoteStops: applyRemoteStops, onRemoteProduction: applyRemoteProduction, onRemoteSessions: applyRemoteSessions, onRemoteHandovers: applyRemoteHandovers, localConfig, onRemoteConfig: applyRemoteConfig });

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

  const updateMachines = (next) => { setMachines(next); persistConfig({ machines: next }); };
  const updateReasons = (next) => { setReasons(next); persistConfig({ reasons: next }); };
  const updateQuickStops = (next) => { setQuickStops(next); persistConfig({ quickStops: next }); };
  const updateShifts = (next) => { setShifts(next); persistConfig({ shifts: next }); };
  const selectShift = (id) => { setShiftId(id); persistPrefs({ shiftId: id }); };
  const updateRates = (next) => { setRates(next); persistConfig({ rates: next }); };
  const updateHandoverEmails = (next) => { setHandoverEmails(next); persistConfig({ handoverEmails: next }); };
  const toggleDark = () => { const n = !dark; setDark(n); persistPrefs({ dark: n }); };

  // ---- another tab wrote our storage ---------------------------------------
  // `config:prefs` and `config:lists` are each ONE blob that every write REPLACES,
  // so a second tab on the same phone (easy to end up with: a bookmark, a link
  // from the supervisor) silently reverted this one. Reported consequences, all
  // from a single unrelated write like the dark-mode toggle: an open off-machine
  // span disappeared (real downtime never logged), a New Shift cutoff came undone
  // (the previous shift's stops re-merged and inflated the new shift and its
  // handout), and a supervisor's settings edit was dropped.
  //
  // The `storage` event fires only in the OTHER tabs, so it's the one place we can
  // notice. Reconcile rather than trust: view prefs follow the other tab, the
  // shift cutoff only ever moves FORWARD, and anything the incoming blob dropped
  // is written straight back — EXCEPT a span the peer has recorded.
  //
  // An incoming "no span" is not automatically the stale side: a tab that LOADED
  // during a span restores it into its own state, so both tabs can hold the same
  // span and either can tap "Back on". If the peer closed it, re-asserting here
  // resurrects a span already written as a stop, and the next return logs the
  // same minutes again — the app inventing downtime, which is worse than the
  // clobber this reconciler exists to prevent. `offMachineClosed` (the `start` of
  // the last closed span) is what tells the two cases apart.
  // Reads go through `api`, and non-localStorage backends simply never fire this.
  const reconcilePrefs = useCallback(async () => {
    const p = await api.loadPrefs();
    if (!p) return;
    if (typeof p.dark === "boolean") setDark(p.dark);
    if (p.lastReason) setLastReason(p.lastReason);
    if (p.shiftId) setShiftId(p.shiftId);
    const theirCut = p.clearedBefore || 0;
    const ourCut = clearedBefore || 0;
    if (theirCut > ourCut) { setClearedBefore(theirCut); setShowAll(false); }
    const theirClosed = Number(p.offMachineClosed) || 0;
    // Adopt the peer's marker VERBATIM — never Math.max. A max latch cannot
    // represent a retraction, so a failed save that re-opens its span (marker
    // back to 0) was silently re-closed by the peer's next write, and the
    // operator lost the away time the banner promised to keep.
    offClosedRef.current = theirClosed;
    const theirSpan = !!(p.offMachine && p.offMachine.start);
    // The peer closed THE VERY SPAN we are holding — it recorded that stop, so
    // adopt the close. Compared by IDENTITY, not `>=`: with ordering, one clock
    // correction backwards (NTP, manual set) leaves every later span starting
    // below the marker, and the reconciler eats live spans forever.
    const peerClosedOurs = !!offMachine && !theirSpan && theirClosed === offMachine.start;
    if (peerClosedOurs) setOffMachine(null);
    const lostSpan = !!offMachine && !theirSpan && !peerClosedOurs;
    if (lostSpan || ourCut > theirCut) {
      // Write our side back. The adopted values are passed explicitly because the
      // state setters above haven't landed yet — the base object would undo them.
      persistPrefs({
        clearedBefore: Math.max(ourCut, theirCut),
        dark: typeof p.dark === "boolean" ? p.dark : dark,
        lastReason: p.lastReason || lastReason,
        shiftId: p.shiftId || shiftId,
        offMachine: peerClosedOurs ? null : offMachine,
        offMachineClosed: offClosedRef.current,
      });
    }
  }, [clearedBefore, offMachine, dark, lastReason, shiftId, persistPrefs]);

  // Shared config is already last-write-wins by `updatedAt` for server sync —
  // reuse exactly that rule between tabs. Adopting needs no re-save (the other tab
  // already wrote it); losing means our newer edit was clobbered, so put it back.
  const reconcileConfig = useCallback(async () => {
    const cfg = await api.loadConfig();
    if (!cfg) return;
    const clampAt = (v) => Math.min(Number(v) || 0, Date.now());
    const theirs = clampAt(cfg.updatedAt);
    const ours = clampAt(configUpdatedAt);
    if (theirs > ours) {
      if (cfg.machines?.length) setMachines(cfg.machines);
      if (cfg.reasons?.length) setReasons(cfg.reasons);
      if (cfg.quickStops) setQuickStops(cfg.quickStops);
      { const ls = normalizeShifts(cfg.shifts, cfg.shift); if (ls) setShifts(ls); }
      setSupervisorPinHash(cfg.supervisorPinHash ?? null);
      if (cfg.rates) setRates(cfg.rates);
      if (cfg.handoverEmails) setHandoverEmails(cfg.handoverEmails);
      setConfigUpdatedAt(theirs);
    } else if (ours > theirs) persistConfig({});
  }, [configUpdatedAt, persistConfig]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e) => {
      const key = e && e.key;
      if (key === "config:prefs" || key == null) reconcilePrefs();
      if (key === "config:lists" || key == null) reconcileConfig();
      // The parked stop is a SHARED slot. Once a peer documents or discards it,
      // this tab's document card is offering to save a stop that no longer
      // exists — take it off screen rather than leave a live Save button on a
      // stale measurement. (The merge in saveStop is the backstop if they race.)
      if ((key === "inprogress:current" || key == null) && !inShell && e && e.newValue == null) {
        setPendingStop(null);
        setRecovered(null);
      }
      // A RECORD written by another tab. The 5s re-read only runs in the
      // supervisor view, so a second tab left on the operator view showed the
      // state it loaded with, forever — and a handover filed from it went out
      // reading "0 stops · 0s" for a worked shift, a confidently wrong document
      // leaving the building under the operator's name.
      if (key == null || /^(stop|prod|sess|hand):/.test(key)) refreshRecords();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reconcilePrefs, reconcileConfig, inShell, refreshRecords]);

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
    // The finished stop comes from the native timer in the shell, or the local
    // useTimer in a browser — same shape either way ({start,end,duration,machine}).
    // Recording is ALWAYS done here, locally + immediately (api.saveStop + setStops),
    // so the stop shows in the operator list the instant it's saved — no dependence
    // on a sync round-trip. In the shell we then tell native to drop its pending
    // (the web owns the record). This is the proven v0.5 recording path.
    const finished = inShell ? nativePending : pendingStop;
    if (!finished) return;
    // Guard a double-tap: the shell's reason picker is native-owned and clears a
    // beat after save, so block re-recording the same finished stop.
    const sig = `${finished.start}-${finished.end}-${finished.duration}`;
    if (lastSavedSigRef.current === sig) return;
    setSaving(true); setSaveError("");
    // Derived from the MEASUREMENT, not random: the ended-but-undocumented stop
    // lives in the shared `inprogress:current` slot, so every open tab is handed
    // the same one and each used to mint its own id — one 4s stop became two
    // records and 8s of downtime on the board and in the supervisor log. Same
    // key + saveStop's never-shorten merge = one record, widest measurement.
    const id = `${finished.start}-${machineSlug(finished.machine || machine)}`;
    const record = {
      id,
      machine: finished.machine || machine, // pinned at Start; falls back for old recoveries
      operator: operator.trim() || "Unnamed",
      start: finished.start, end: finished.end, duration: finished.duration,
      reason, notes: notes.trim(), discarded: false,
      loggedAt: Date.now(), // when the record was created; drives shift membership
      updatedAt: Date.now(), // last-write-wins clock for sync
    };
    const res = await api.saveStop(record);
    if (res.ok) {
      lastSavedSigRef.current = sig;
      setStops((prev) => [record, ...prev]);
      setLastReason(reason); persistPrefs({ lastReason: reason });
      setPendingStop(null);
      // Documented — the ended-stop autosave has done its job. (On a failure it
      // deliberately stays, so a refresh mid-retry still recovers the stop.)
      api.clearInProgress();
      // Native recorded nothing; just clear its pending now the web has the record.
      if (inShell) { try { nativeApi.discardStop(); } catch (e) { /* ignore */ } }
      sync.flush();
    } else {
      setSaveError(res.error || "The stop didn't save. Try again.");
    }
    setSaving(false);
  };

  const handleDiscardPending = () => {
    if (inShell) { try { nativeApi.discardStop(); } catch (e) { /* ignore */ } setSaveError(""); return; }
    setPendingStop(null); setSaveError("");
    api.clearInProgress(); // deliberately dropped — don't offer it again on the next load
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
    // While off machine there is deliberately no open span: opening presence
    // here would put manned time on a machine the operator isn't standing at.
    if (offMachine) return;
    const open = openSessRef.current;
    if (!open) openSession(machine, operator);
    else if (open.operator !== operator.trim()) { closeSession(); openSession(machine, operator); }
  };
  const unlockSetup = () => { setSetupLocked(false); persistPrefs({ setupLocked: false }); };

  // ---- manual stop report --------------------------------------------------
  // Re-entrancy latch, same shape as offSavingRef: `saving` state already blocks
  // the button, but two dispatches inside one task would both get through it and
  // log the stop twice. (Not reachable with real taps — React 18 flushes the
  // disable synchronously — so this is belt-and-braces, not a fix for a live bug.)
  const manualSavingRef = useRef(false);
  // Logs a stop that already happened, entered by duration. End time is "now",
  // start is back-dated by the duration. `loggedAt` is when the operator saved
  // it, so it counts toward the CURRENT shift even though `start` is back-dated
  // (which otherwise could fall before the New Shift cutoff and get hidden).
  const handleManualSave = async ({ durationMs, reason: mReason, notes: mNotes, machine: mMachine }) => {
    if (manualSavingRef.current) return false;
    manualSavingRef.current = true;
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
    manualSavingRef.current = false;
    return res.ok;
  };

  // ---- off machine ---------------------------------------------------------
  // "I'm not at any machine." For equipment that only produces while it runs and
  // only runs while someone is there, that absence is downtime — so ending the
  // span writes a normal stop on the machine that was left, reason "No operator".
  // Nothing is ever inferred from silence: only an explicit tap opens or closes
  // this, because under this model a false "absent" reading would FABRICATE
  // downtime on a machine, and downtime is the number the app exists to be
  // trusted on.
  // Is a stop being timed right now? In the Android shell the live timer is the
  // NATIVE one. Before the first state push `nativeTimer` is still null, and an
  // unknown timer must count as BUSY: a cold start from the notification while a
  // stop is already running would otherwise let a span open on top of it.
  const timerBusy = inShell
    ? (nativeTimer == null || nativeTimer.running || nativeTimer.paused || !!nativePending)
    : (timer.state.running || timer.state.paused || !!pendingStop);

  const [offError, setOffError] = useState("");
  const offSavingRef = useRef(false);

  const startOffMachine = useCallback(() => {
    // A timed stop already accounts for this machine being down; opening an
    // off-machine span on top of it would double-count the same minutes.
    if (timerBusy) return;
    const rec = { machine, operator: operator.trim() || "Unnamed", start: Date.now() };
    setOffError("");
    setOffMachine(rec);
    persistPrefs({ offMachine: rec });
    closeSession(); // presence ends — they are not at a machine
  }, [timerBusy, machine, operator, closeSession, persistPrefs]);

  // Ends the span and records it. `nextMachine` lets "tap another machine" be
  // the same gesture as coming back: the stop is still attributed to the machine
  // that was LEFT, then the operator lands on the new one. `endTs` lets an
  // auto-close land exactly where the overlapping event began.
  const endOffMachine = useCallback(async (nextMachine, endTs) => {
    const rec = offMachine;
    // Two dispatches in one task would otherwise write the same span twice.
    if (!rec || offSavingRef.current) return;
    offSavingRef.current = true;
    setOffMachine(null);
    // Mark THIS span closed before clearing it, so a second tab holding the same
    // restored span adopts the close instead of re-asserting a span we are about
    // to record. Without it those minutes get logged twice.
    offClosedRef.current = rec.start;
    persistPrefs({ offMachine: null, offMachineClosed: offClosedRef.current });
    const target = nextMachine || rec.machine;

    const end = Math.max(rec.start, endTs || Date.now());
    const duration = end - rec.start;
    // A mistap is not a stop.
    if (duration >= 1000) {
      const record = {
        // Derived from the span, so a tab that was frozen through the close and
        // thaws still holding it writes the SAME key instead of a second
        // overlapping "No operator" stop. Belt-and-braces behind the marker:
        // that only works if the peer sees the close before the next span opens.
        id: `${rec.start}-${machineSlug(rec.machine)}`,
        machine: rec.machine,
        operator: rec.operator,
        start: rec.start, end, duration,
        reason: OFF_MACHINE_REASON, notes: "",
        offMachine: true, discarded: false,
        loggedAt: end,   // recorded now → belongs to the current shift
        updatedAt: end,  // last-write-wins clock for sync
      };
      const res = await api.saveStop(record);
      if (res.ok) { setStops((prev) => [record, ...prev]); setOffError(""); sync.flush(); }
      else {
        // Don't swallow the operator's away time. Re-open the span so the clock
        // keeps running and a retry still records it, and say so where they're
        // actually looking (the off-machine banner, not the stop-document card).
        setOffMachine(rec);
        // The span is open again and NOT recorded, so retract the closed marker —
        // otherwise a peer tab would treat this live span as already logged and
        // drop it, losing the away time we just went out of our way to keep.
        offClosedRef.current = 0;
        persistPrefs({ offMachine: rec, offMachineClosed: 0 });
        // Lead with what the operator should DO. A bare "QuotaExceededError" in
        // the banner tells someone in gloves nothing.
        setOffError(`Didn't save — you're still off machine, tap again to retry.${res.error ? ` (${res.error})` : ""}`);
        offSavingRef.current = false;
        return;
      }
    }

    setMachine(target);
    // Both values have to be in this one patch: the base object still holds the
    // pre-switch machine AND the open span, so persisting either from state here
    // would put the operator back on the old machine (or re-open the span).
    persistPrefs({ offMachine: null, machine: target });
    openSession(target); // back at a machine → presence resumes
    offSavingRef.current = false;
  }, [offMachine, persistPrefs, sync, openSession]);

  // Above this, coming back asks first. A forgotten tap is the one way this
  // button can invent hours of downtime, and unlike a manual report (where the
  // operator types the duration) nothing else here makes them look at it.
  const OFF_CONFIRM_MS = 90 * 60 * 1000;
  const [offConfirm, setOffConfirm] = useState(null); // { target, at } | null

  // Close the span WITHOUT recording — for the "I forgot to tap back" case,
  // where the honest answer is no record rather than an invented one.
  const discardOffMachine = useCallback((next) => {
    const rec = offMachine;
    if (!rec) return;
    setOffMachine(null);
    setOffError("");
    const target = next || rec.machine;
    setMachine(target);
    // Deliberately dropped, so a peer must not re-assert it either. Set to THIS
    // span's start, not a running max — the reconciler matches by identity.
    offClosedRef.current = rec.start;
    // One write, after both changes, carrying both new values — the base object
    // still holds the old machine and the open span.
    persistPrefs({ offMachine: null, machine: target, offMachineClosed: offClosedRef.current });
    openSession(target);
  }, [offMachine, persistPrefs, openSession]);

  // Returning from off machine. Long spans route through the confirmation.
  const backOnMachine = useCallback((next) => {
    if (offMachine && Date.now() - offMachine.start >= OFF_CONFIRM_MS) {
      // `at` freezes the return time at the tap, so the duration the dialog shows
      // is exactly the duration that gets logged. Without it the dialog's number
      // was computed once while the save recomputed Date.now() — the operator
      // consented to one figure and a bigger one landed on the machine.
      setOffConfirm({ target: next || offMachine.machine, at: Date.now() });
      return;
    }
    endOffMachine(next);
  }, [offMachine, endOffMachine]);

  // Every machine tap in the operator UI routes through here so that returning
  // from off-machine and switching machines are one gesture.
  const chooseMachine = useCallback((next) => {
    if (offMachine) { backOnMachine(next); return; }
    switchMachine(next);
  }, [offMachine, backOnMachine, switchMachine]);

  // A stop started from OUTSIDE this view — the Android notification or the
  // floating bubble, which know nothing about off-machine — must not run on top
  // of an open span, or every minute of it is billed twice as downtime. Close
  // the span at the moment that stop began.
  const nativeRunning = inShell && !!nativeTimer && (nativeTimer.running || nativeTimer.paused);
  useEffect(() => {
    if (!nativeRunning || !offMachine) return;
    endOffMachine(undefined, nativeTimer.startTs || Date.now());
  }, [nativeRunning, offMachine, nativeTimer, endOffMachine]);

  // A span RESTORED from a previous session that predates the current shift is
  // dropped, not recorded: the app cannot know when the operator actually came
  // back, and inventing that duration would put fabricated downtime on the
  // board. This runs once per restore and then clears the marker — a LIVE span
  // must survive "New Shift" (which moves shiftStart to now), or an operator who
  // taps it on returning from break loses the whole break.
  // The ref makes this run at most once per load no matter what: it rewrites
  // `offMachine` with a fresh object, which is its own effect dependency, so
  // without the latch a dropped condition here becomes an infinite re-render.
  const offRestoreCheckedRef = useRef(false);
  useEffect(() => {
    if (offRestoreCheckedRef.current || !offMachine || !offMachine.restored || !shiftWindow) return;
    offRestoreCheckedRef.current = true;
    if (offMachine.start < shiftStart) {
      setOffMachine(null);
      // Dropped on purpose — mark it so a peer tab doesn't hand it back.
      // NO marker here. This span was DROPPED, not recorded — and the drop is a
      // per-tab decision (each tab that restores a stale span drops it itself),
      // so the marker buys nothing. Stamping it told a peer holding the SAME span
      // LIVE that it was already logged: the operator tapped Off machine at
      // 05:59, the 06:00 shift began, a second tab was opened, and the live span
      // vanished unrecorded. A live span must always win over a stale drop.
      persistPrefs({ offMachine: null });
    } else {
      const { restored, ...live } = offMachine;
      setOffMachine(live);
      persistPrefs({ offMachine: live });
    }
  }, [offMachine, shiftWindow, shiftStart, persistPrefs]);

  // ---- shift output (production for OEE) -----------------------------------
  // One record per (machine, shift, operator), upserted — re-entering counts
  // updates the same row rather than stacking duplicates.
  const handleSaveProduction = async ({ unitsProduced, scrapCount }) => {
    const now = Date.now();
    const op = operator.trim() || "Unnamed";
    const id = `${machineSlug(machine)}|${shiftStart}|${op}`;
    const record = {
      id, kind: "production", machine, operator: op,
      shiftStart,
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
    return production.find((p) => p.id === `${machineSlug(machine)}|${shiftStart}|${op}`) || null;
  }, [production, machine, shiftStart, operator]);

  // ---- recovery ------------------------------------------------------------
  const recoverResume = () => {
    const d = recovered;
    const mach = machines.includes(d.machine) ? d.machine : machines[0];
    setOperator(d.operator || "");
    setMachine(mach);
    // Persist the recovered identity: without this the next reload drops back to
    // the old machine and mis-attributes the following stop.
    persistPrefs({ operator: d.operator || "", machine: mach });
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
    const mach = machines.includes(d.machine) ? d.machine : machines[0];
    setOperator(d.operator || "");
    setMachine(mach);
    persistPrefs({ operator: d.operator || "", machine: mach });
    setPendingStop({ start: d.startTs, end: d.savedAt, duration: dur, machine: d.machine });
    setReason(lastReason && reasons.includes(lastReason) ? lastReason : reasons[0]);
    setNotes("");
    setRecovered(null);
    // Keep it recoverable: it's ended-but-undocumented now, exactly like End Stop.
    // Clearing here meant a refresh before "Save stop" lost it a second time.
    api.saveInProgress({
      operator: d.operator || "", machine: d.machine,
      running: false, paused: false, ended: true,
      startTs: d.startTs, accumulated: dur, segStart: null,
      end: d.savedAt, duration: dur, savedAt: Date.now(),
    });
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

  // Stops belonging to THIS shift: the operator's own, not discarded, logged
  // after the window start. Shift membership uses when the stop was logged
  // (loggedAt), not its start — so a manual stop with a back-dated start still
  // counts toward the shift it was entered in. Falls back to end/start for
  // records saved before loggedAt existed.
  //
  // This list drives every NUMBER (stat cards, by-reason, OEE, the handout). It
  // deliberately ignores `showAll`, which is only a view toggle for the Recent
  // list below — letting it widen the stats meant a curious tap could send a
  // supervisor a handout claiming 4 stops / 2h for a 1 stop / 5m shift.
  // Name matching is case/space-insensitive (see sameOperator): retyping "bob"
  // for records saved as "Bob" used to empty the board with no explanation.
  const shiftStops = useMemo(() => stops.filter((s) => {
    const stamp = s.loggedAt ?? s.end ?? s.start;
    return (!operator.trim() || sameOperator(s.operator, operator)) && !s.discarded && !s.deleted &&
      stamp > shiftStart;
  }), [stops, operator, shiftStart]);

  // Stops of this operator's that exist but fall OUTSIDE the current window.
  // The window hides them on the clock now, not just when someone taps "New
  // Shift" — so the "Show all" affordance has to key off this, or older stops
  // would disappear with no explanation and no way back.
  const hiddenStopCount = useMemo(() => {
    const own = stops.filter((s) => (!operator.trim() || sameOperator(s.operator, operator)) && !s.discarded && !s.deleted);
    return Math.max(0, own.length - shiftStops.length);
  }, [stops, operator, shiftStops]);

  // What the Recent-stops list shows: the same set, or everything when the
  // operator taps "Show all".
  const visibleStops = useMemo(() => (showAll
    ? stops.filter((s) => (!operator.trim() || sameOperator(s.operator, operator)) && !s.discarded && !s.deleted)
    : shiftStops), [stops, operator, showAll, shiftStops]);

  // ---- shift-wide operator picture (roaming-aware OEE) ----------------------
  // Manned time is the operator's SHIFT — from the window start to now, capped at
  // the shift end — apportioned across the machines they actually worked. It is
  // no longer the raw length of an open presence span: a span never closes by
  // itself, so a locked phone left running reported 21 hours on one machine.
  const myShift = useMemo(() => {
    const op = operator.trim() || "Unnamed";
    const now = Date.now();
    const winStart = shiftStart;
    // The shift so far: never past its end, never negative. This is the planned
    // time — the denominator behind uptime/OEE.
    const winEnd = Math.min(now, shiftWindow ? shiftWindow.end : now);
    const elapsed = Math.max(0, winEnd - winStart);

    const bag = Object.create(null); // machine -> { mannedMs, downtimeMs, stops, units, scrap }
    // bag is Object.create(null) — a machine named "__proto__" must not write onto the prototype.
    const entry = (m) => (bag[m] = bag[m] || { machine: m, mannedMs: 0, downtimeMs: 0, stops: 0, units: 0, scrap: 0 });

    // Presence spans no longer SET manned time — they only apportion the shift
    // across the machines a roaming operator worked. Each span is clipped to the
    // window first, so a span left open since yesterday can't dominate.
    const share = Object.create(null); // keyed by machine NAME
    let shareTotal = 0;
    for (const s of sessions) {
      // Same case-insensitive rule as the stop filter, so a retyped name doesn't
      // silently drop the presence spans that apportion manned time.
      if (!sameOperator(s.operator, op)) continue;
      const end = Math.min(s.end ?? now, winEnd);
      const start = Math.max(s.start, winStart);
      if (end > start) { share[s.machine] = (share[s.machine] || 0) + (end - start); shareTotal += end - start; }
    }
    // With presence data, the shift is apportioned across the machines worked.
    // WITHOUT it we assign nothing: inventing a full shift on the current machine
    // would put fabricated manned time on the board and in the handout for every
    // user who has never locked setup — the very bug this change exists to kill.
    if (shareTotal > 0) {
      for (const m of Object.keys(share)) entry(m).mannedMs = elapsed * (share[m] / shareTotal);
    }

    for (const s of shiftStops) { const e = entry(s.machine); e.downtimeMs += s.duration; e.stops += 1; }
    for (const p of production) {
      if (p.operator !== op || p.shiftStart !== shiftStart) continue;
      const e = entry(p.machine); e.units += p.unitsProduced || 0; e.scrap += p.scrapCount || 0;
    }

    const rows = Object.values(bag);
    const hasSessions = rows.some((r) => r.mannedMs > 0);

    let overall;
    if (hasSessions) {
      let planned = 0, down = 0, units = 0, scrap = 0, theoretical = 0, ratedUnits = 0;
      for (const r of rows) {
        const plannedM = r.mannedMs; // manned time is the plan for a roamer
        const downM = Math.min(r.downtimeMs, plannedM || r.downtimeMs);
        planned += plannedM; down += downM; units += r.units; scrap += r.scrap;
        const rate = rates?.[r.machine];
        // Same rule as the supervisor's machineOEE: units and capacity must come
        // from the same machines, or an unrated machine's output inflates P.
        // This figure goes out on the shift handout, so it must not overstate.
        if (rate && plannedM > 0) {
          theoretical += rate * (Math.max(0, plannedM - downM) / HOUR_MS);
          ratedUnits += r.units;
        }
        r.oee = computeOEE({ plannedMs: plannedM, downtimeMs: r.downtimeMs, unitsProduced: r.units, scrapCount: r.scrap, ratePerHour: rate });
      }
      overall = computeOEE({ plannedMs: planned, downtimeMs: down, unitsProduced: units, scrapCount: scrap, ratePerHour: 0 });
      if (theoretical > 0) {
        overall.p = Math.min(1, Math.max(0, ratedUnits / theoretical));
        const fs = [overall.a, overall.p, overall.q].filter((f) => f != null);
        overall.oee = fs.length ? fs.reduce((x, y) => x * y, 1) : null;
        overall.partial = overall.a == null || overall.p == null || overall.q == null
          || ratedUnits !== units;
      }
    } else {
      // No presence data (old records / name not set) — fall back to the
      // single-machine framing against the configured shift length.
      const downtimeMs = shiftStops.reduce((a, s) => a + s.duration, 0);
      overall = computeOEE({
        plannedMs: elapsed || shiftLengthMs(activeShift), downtimeMs,
        unitsProduced: myProduction?.unitsProduced, scrapCount: myProduction?.scrapCount,
        ratePerHour: rates?.[machine],
      });
    }
    rows.sort((a, b) => b.mannedMs - a.mannedMs);
    return { rows, overall, hasSessions };
  }, [sessions, shiftStops, production, rates, activeShift, shiftStart, shiftWindow, operator, machine, myProduction, slowTick]);

  // ---- shift output goal (achievability) -----------------------------------
  // Per-machine: the current machine's units produced this shift vs that
  // machine's goal, projected against its rate and time left in the shift.
  const goalStatus = useMemo(() => {
    const goal = activeShift.goals?.[machine] || 0;
    const produced = myShift.rows.find((r) => r.machine === machine)?.units || 0;
    return computeGoalStatus({
      goal, produced, machine,
      ratePerHour: rates?.[machine], shiftEndMs: shiftWindow ? shiftWindow.end : shiftEndAt(activeShift), now: Date.now(),
    });
  }, [myShift, activeShift, rates, machine, shiftWindow, slowTick]);

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
            t={t} operator={operator} setOperator={setOperator} machine={machine} setMachine={chooseMachine}
            offMachine={offMachine} onOffMachine={startOffMachine} onBackOnMachine={() => backOnMachine()} offError={offError}
            timer={effectiveTimer} onStop={handleStop}
            pendingStop={effectivePending} reason={reason} setReason={setReason} notes={notes} setNotes={setNotes}
            onSave={handleSave} onDiscardPending={handleDiscardPending} saving={saving} saveError={saveError}
            myStops={shiftStops} visibleStops={visibleStops} machines={machines} reasons={reasons} quickStops={quickStops}
            applyQuickStop={applyQuickStop} lastReason={lastReason}
            shift={activeShift} shifts={shifts} shiftId={shiftId} onSelectShift={selectShift}
            shiftStart={shiftStart} hiddenStopCount={hiddenStopCount}
            onNewShift={() => setNewShiftOpen(true)} showAll={showAll} onToggleShowAll={toggleShowAll}
            setupLocked={setupLocked} onLockSetup={lockSetup} onUnlockSetup={unlockSetup}
            onOpenManual={() => { setSaveError(""); setManualOpen(true); }}
            syncStatus={sync.status} syncOn={syncOn}
            tick={slowTick}
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
            rates={rates} updateRates={updateRates} production={production} sessions={sessions} handovers={handovers}
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

      {offConfirm && offMachine && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-30" onClick={() => setOffConfirm(null)}>
          <div className={`${dark ? "bg-slate-900" : "bg-white"} rounded-xl shadow-xl p-5 max-w-sm w-full space-y-3`} onClick={(e) => e.stopPropagation()}>
            {/* The frozen tap time, not Date.now(): what's shown must be what's logged. */}
            <div className="flex items-center gap-2 font-bold"><AlertCircle size={18} className="text-amber-500" /> Log {fmtDur(Math.max(0, (offConfirm.at || Date.now()) - offMachine.start))} of downtime?</div>
            <p className={`text-sm ${t.sub}`}>
              You've been off machine since {fmtTime(offMachine.start)}. Coming back records that whole
              stretch as a <b>“{OFF_MACHINE_REASON}”</b> stop on <b>{offMachine.machine}</b>. If you
              actually returned earlier and forgot to tap, discard it and report the real stop manually instead.
            </p>
            <div className="flex gap-2">
              <button onClick={() => { const c = offConfirm; setOffConfirm(null); endOffMachine(c.target, c.at); }}
                className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-3 rounded-lg">Yes, log it</button>
              <button onClick={() => { const c = offConfirm; setOffConfirm(null); discardOffMachine(c.target); }}
                className={`px-4 ${t.sub} font-semibold`}>Discard</button>
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
          reportBase={buildShiftReport({ operator, machine, myStops: shiftStops, myShift, clearedBefore: shiftStart, activeShift, goalStatus })}
          handoverEmails={handoverEmails} syncCfg={syncCfg}
          lastHandover={handovers.find((h) => !h.machine || h.machine === machine) || null}
          onSaved={(rec) => { setHandovers((prev) => [rec, ...prev.filter((h) => h.id !== rec.id)]); sync.flush(); }}
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
    t, operator, setOperator, machine, setMachine, offMachine, onOffMachine, onBackOnMachine, offError, timer, onStop,
    pendingStop, reason, setReason, notes, setNotes, onSave, onDiscardPending, saving, saveError,
    myStops, visibleStops, machines, reasons, quickStops, applyQuickStop, lastReason,
    shift, shifts, shiftId, onSelectShift, shiftStart, hiddenStopCount, onNewShift, showAll, onToggleShowAll,
    setupLocked, onLockSetup, onUnlockSetup, onOpenManual,
    syncStatus, syncOn,
    rates, myProduction, onSaveProduction, myShift, goalStatus, onOpenHandover, tick,
  } = props;

  const { state, elapsed, start, pause, resume } = timer;
  const { running, paused } = state;

  // "Discard" sits a thumb's width from "Save stop" and throws away a real,
  // already-measured stop with no undo — the only destructive action in the app
  // that didn't confirm. One extra tap, big target, and it names the duration
  // that's about to be lost.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => { if (!pendingStop) setConfirmDiscard(false); }, [pendingStop]);

  // Live clock for the off-machine banner. The stop timer's own interval only
  // ticks while a stop is being timed, so this needs its own.
  const [offTick, setOffTick] = useState(0);
  useEffect(() => {
    if (!offMachine) return;
    const iv = setInterval(() => setOffTick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [offMachine]);
  const offElapsed = useMemo(
    () => (offMachine ? Math.max(0, Date.now() - offMachine.start) : 0),
    [offMachine, offTick],
  );

  // ---- current-shift stats (own, non-discarded, inside the shift window) ---
  // Total downtime shown on the current board.
  const downtimeMs = useMemo(() => myStops.reduce((a, s) => a + s.duration, 0), [myStops]);
  // Stops in the last hour.
  // `tick` is in the deps on purpose: this memo reads Date.now(), so without a
  // time input it never recomputed. The card kept whatever value it had when the
  // last stop was logged — reporting 3 stops in the last hour for a machine that
  // had run clean since breakfast, on the one card an operator glances at to ask
  // "is this machine misbehaving RIGHT NOW".
  const lastHourCount = useMemo(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return myStops.filter((s) => s.end > cutoff).length;
  }, [myStops, tick]);
  // Shift-wide OEE (all machines worked, manned-time denominators) from App.
  const oee = myShift.overall;
  // Downtime grouped by reason, largest first.
  const byReason = useMemo(() => {
    // Object.create(null), not {}: a reason named "__proto__" assigned onto the
    // prototype instead of the map, so 2 real counted minutes rendered as "No
    // downtime logged this shift" — the breakdown silently disagreeing with the
    // total it sits under. A machine named "__proto__" polluted Object.prototype.
    const map = Object.create(null);
    myStops.forEach((s) => { map[s.reason] = (map[s.reason] || 0) + s.duration; });
    const list = Object.entries(map).sort((a, b) => b[1] - a[1]);
    return { list, max: list[0]?.[1] || 1 };
  }, [myStops]);

  const canLock = operator.trim().length > 0; // need a name before locking
  // With no name entered, `myStops` can't filter by operator — on a synced device
  // that means the board is showing the whole plant. Say so, and don't let a
  // handout go out under one person's name with everyone's numbers on it.
  const unnamed = !operator.trim();

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
      {unnamed && (
        <div className={`${t.card} rounded-xl px-4 py-2.5 flex items-center gap-2 text-sm border border-amber-500/40`}>
          <User size={15} className="text-amber-500 flex-none" />
          <span>Showing <b>all operators on this device</b> — enter your name below to see just your shift.</span>
        </div>
      )}

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
                const activeChip = m === machine && !offMachine;
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
          {/* Stepping away from every machine. One tap, the same gesture as a
              machine switch — and because these machines only produce while
              someone is running them, it logs downtime rather than a new
              category. */}
          {offMachine ? (
            // Never hidden, whatever else is on screen: this is the operator's
            // only way to stop the clock, and it keeps ticking regardless.
            // The running total is on the button so a forgotten tap is obvious
            // BEFORE it lands hours of downtime on a machine.
            <button onClick={onBackOnMachine}
              className="mt-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-bold bg-emerald-500 text-white shadow transition active:scale-95">
              <User size={15} /> Back on {offMachine.machine}
              <span className="font-mono tabular-nums opacity-90">· {fmtClock(offElapsed)}</span>
            </button>
          ) : !running && !pendingStop && (
            // Amber, not the neutral chip styling of a machine button right
            // above it — a mistap here starts logging downtime.
            <button onClick={onOffMachine}
              className="mt-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold border-2 border-amber-400/70 text-amber-600 dark:text-amber-400 transition active:scale-95">
              <LogOut size={15} /> Off machine
            </button>
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

      {/* off machine — downtime is accruing on the machine that was left */}
      {offMachine && (
        <div className={`${t.card} rounded-xl border-2 border-amber-400 p-4 flex items-center justify-between gap-3`}>
          <div className="flex items-center gap-2 min-w-0">
            <LogOut size={18} className="text-amber-500 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-bold text-amber-500">Off machine</div>
              <div className={`text-[11px] ${offError ? "text-red-500 font-semibold" : t.sub}`}>
                {offError || <>Logging downtime on <b>{offMachine.machine}</b> — tap a machine or “Back on” when you return.</>}
              </div>
            </div>
          </div>
          <div className="font-mono font-bold tabular-nums text-amber-500 text-lg shrink-0">{fmtClock(offElapsed)}</div>
        </div>
      )}

      {/* timer */}
      <div className={`${t.card} rounded-xl p-6 flex flex-col items-center`}>

        <div className={`text-xs font-semibold tracking-wide ${t.sub} mb-1`}>
          {paused ? `PAUSED — ${state.machine || machine}` : running ? `${(state.machine || machine).toUpperCase()} STOPPED — TIMING` : "READY"}
        </div>
        <div className={`text-6xl font-mono font-bold mb-5 tabular-nums ${paused ? "text-amber-500" : running ? "text-red-500" : t.sub}`}>
          {fmtClock(elapsed)}
        </div>
        {!running ? (
          // Off machine already counts these minutes as downtime — timing a stop
          // on top would double-count them.
          <button onClick={start} disabled={!!pendingStop || !!offMachine}
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
        <p className={`text-xs ${t.sub} mt-3 text-center max-w-xs`}>
          {offMachine
            ? "You're off machine — that time is already being logged as downtime. Come back to a machine to time a stop."
            : "Tap “Start Stop” when the machine stops. Pause for short interruptions; “End Stop” when it runs again."}
        </p>
        {!running && !pendingStop && !offMachine && (
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
            <button onClick={() => setConfirmDiscard(true)} disabled={saving} className={`px-4 ${t.sub} hover:text-red-500 font-semibold`}>Discard</button>
          </div>
          {confirmDiscard && (
            <div className={`border-2 border-red-400 rounded-lg p-3 space-y-2`}>
              <div className="text-sm font-bold text-red-500 flex items-center gap-2"><AlertCircle size={16} /> Throw away {fmtDur(pendingStop.duration)} of downtime?</div>
              <p className={`text-xs ${t.sub}`}>This stop was measured on {pendingStop.machine || machine}. Discarding it records nothing and can't be undone.</p>
              <div className="flex gap-2">
                <button onClick={() => { setConfirmDiscard(false); onDiscardPending(); }}
                  className="flex-1 bg-red-500 hover:bg-red-600 text-white font-bold py-3 rounded-lg">Discard stop</button>
                <button onClick={() => setConfirmDiscard(false)} className={`px-4 ${t.sub} font-semibold`}>Keep it</button>
              </div>
            </div>
          )}
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
            <button onClick={onOpenHandover} disabled={unnamed}
              title={unnamed ? "Enter your name first — a handover goes out under your name" : undefined}
              className={`flex items-center gap-2 ${t.accentBtn} disabled:opacity-40 font-bold px-4 py-3 rounded-xl shadow active:scale-95 transition`}>
              <PencilLine size={18} /> Handover
            </button>
            <button onClick={onNewShift} disabled={!!pendingStop}
              className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white font-bold px-5 py-3 rounded-xl shadow active:scale-95 transition">
              <Sparkles size={18} /> New Shift
            </button>
          </div>
        </div>
        {(hiddenStopCount > 0 || showAll) && (
          <div className={`text-xs ${t.sub} ${t.muted} rounded-lg px-3 py-2 mt-3 flex items-center justify-between gap-2`}>
            <span className="flex items-center gap-1">
              <Archive size={13} />
              {showAll
                ? "Showing all stops, including earlier shifts. Stats above still cover this shift only."
                : `This shift started ${fmtTime(shiftStart)}. ${hiddenStopCount} earlier stop${hiddenStopCount === 1 ? "" : "s"} hidden but saved.`}
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
        {visibleStops.length === 0 ? <p className={`${t.sub} text-sm text-center py-4`}>No stops logged yet. Start the timer when the machine stops.</p> : (
          <div className="space-y-2">
            {visibleStops.slice(0, 8).map((s) => (
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

  // The seconds box declares max="59" but nothing enforced it, so typing 900
  // silently recorded a 15-minute stop nobody meant. Clamp as it's typed (the
  // field shows the truth) and again here, so what's saved is what's displayed.
  // Minutes are deliberately NOT capped: a long typed duration is the operator's
  // call, exactly like the rest of the manual report.
  const clampSecs = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(59, n)) : 0;
  };
  const onSecsChange = (v) => setSecs(v === "" ? "" : String(clampSecs(v)));

  const durationMs = (Math.max(0, parseInt(mins || "0", 10) || 0) * 60 + clampSecs(secs || "0")) * 1000;

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
              <input type="number" inputMode="numeric" min="0" max="59" value={secs} onChange={(e) => onSecsChange(e.target.value)} placeholder="0"
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
function SupervisorView({ t, stops, loading, onRefresh, machines, reasons, quickStops, shifts, updateMachines, updateReasons, updateQuickStops, updateShifts, discardStop, deleteStop, hasPin, updatePin, syncCfg, updateSyncConfig, syncStatus, onSyncNow, rates, updateRates, production, sessions, handovers, handoverEmails, updateHandoverEmails, onDownloadBackup, onRestore, restoreMsg }) {
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
    const byReason = Object.create(null), byMachine = Object.create(null); // user strings
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
    // The machine filter has to reach EVERY input, not just downtime. It used to
    // scope `active` only, so a filtered-out machine kept its planned time and
    // production in the aggregate while its downtime was gone — its availability
    // became 100% and it dragged the overall UP. Filtering to the worst machine
    // reported a better OEE than the unfiltered view, and still listed the
    // machines you filtered away at 100%.
    const inScope = (m) => filterMachine === "All" || m === filterMachine;
    const prodInRange = production.filter((p) => {
      const ts = p.loggedAt ?? p.shiftStart ?? 0;
      return inScope(p.machine) && ts >= rangeBounds[0] && ts <= rangeBounds[1];
    });
    // Manned time per machine (any operator) from sessions overlapping the range
    // — shown as coverage context next to the planned-time OEE.
    const mannedByMachine = Object.create(null); // keyed by machine NAME
    (sessions || []).forEach((s) => {
      if (!inScope(s.machine)) return;
      const end = Math.min(s.end ?? nowTs, rangeBounds[1] === Infinity ? nowTs : rangeBounds[1]);
      const start = Math.max(s.start, rangeBounds[0]);
      if (end > start) mannedByMachine[s.machine] = (mannedByMachine[s.machine] || 0) + (end - start);
    });
    const downByMachine = Object.create(null); // keyed by machine NAME
    active.forEach((s) => { downByMachine[s.machine] = (downByMachine[s.machine] || 0) + s.duration; });
    const rows = [];
    let sum = { planned: 0, down: 0, units: 0, scrap: 0, theoretical: 0, ratedUnits: 0 };
    for (const m of machines) {
      if (!inScope(m)) continue;
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
      // Performance is units ÷ capacity, so BOTH sides must come from the same
      // machines. Counting an unrated machine's units against only the rated
      // machines' capacity reported 100% for a line running at half speed.
      if (rates?.[m]) {
        sum.theoretical += (rates[m] || 0) * (Math.max(0, plannedMs - down) / HOUR_MS);
        sum.ratedUnits += units;
      }
    }
    // Overall: aggregate factors over everything that reported.
    const overall = computeOEE({
      plannedMs: sum.planned, downtimeMs: sum.down,
      unitsProduced: sum.units, scrapCount: sum.scrap,
      ratePerHour: 0, // performance recomputed below from the summed theoretical
    });
    if (sum.theoretical > 0) {
      overall.p = Math.min(1, Math.max(0, sum.ratedUnits / sum.theoretical));
      const fs = [overall.a, overall.p, overall.q].filter((f) => f != null);
      overall.oee = fs.length ? fs.reduce((x, y) => x * y, 1) : null;
      // Still PARTIAL when some machine that reported has no rate — its output is
      // outside the performance figure, so the number is not the whole line.
      // (This used to clear the badge unconditionally, hiding exactly that.)
      overall.partial = overall.a == null || overall.p == null || overall.q == null
        || sum.ratedUnits !== sum.units;
    }
    rows.sort((a, b) => (a.oee ?? 2) - (b.oee ?? 2)); // worst first
    return { rows, overall };
  }, [active, production, sessions, machines, rates, shift, rangeBounds, filterMachine]);

  // ONE availability number in the app. This used to divide every machine's
  // downtime by a SINGLE machine's shift (planned = shiftMs × days, no machine
  // count), so with 3 machines each down 2h the card read 25% while the OEE
  // panel on the same screen read 75% for the same records — and with 5 machines
  // it read 0.0% for a line running 92.5% of the time. machineOEE already sums
  // planned time per machine correctly and honours the machine filter, so read
  // the availability from there instead of computing a second, worse one.
  // (Not the documented "uptime assumes the configured shift length" caveat —
  // that still applies, and is what makes this an estimate rather than truth.)
  const uptime = useMemo(() => {
    const a = machineOEE.overall?.a;
    return a == null ? null : Math.min(100, Math.max(0, a * 100));
  }, [machineOEE]);

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
    logFiltered.forEach((s) => rows.push([s.machine, s.reason, s.operator, new Date(s.start).toISOString(), new Date(s.end).toISOString(), Math.floor(s.duration / 1000), s.offMachine ? "off-machine" : s.manual ? "manual" : "timed", s.notes || "", s.discarded ? "yes" : "no", s.discardReason || ""]));
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
                      <td className="px-3 py-2"><span className={s.discarded ? "line-through" : ""}>{s.reason}</span>{s.offMachine
                        ? <span className="ml-1 text-[10px] uppercase tracking-wide bg-amber-400/20 text-amber-500 rounded px-1.5 py-0.5 align-middle">off machine</span>
                        : s.manual && <span className="ml-1 text-[10px] uppercase tracking-wide bg-slate-400/20 text-slate-400 rounded px-1.5 py-0.5 align-middle">manual</span>}{s.notes && <div className={`text-xs ${t.sub}`}>{s.notes}</div>}{s.discarded && <div className="text-xs text-amber-500 mt-0.5">Discarded: {s.discardReason}</div>}</td>
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
          <HandoverLog t={t} handovers={handovers} />
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
  // Add used to no-op silently on a blank or already-present entry (including one
  // that only differed by padding), so the supervisor tapped Add and nothing
  // happened — indistinguishable from a broken button. Say which it was.
  const [msg, setMsg] = useState("");
  const add = () => {
    const v = input.trim().slice(0, 60);
    if (!v) { setMsg("Type a name first."); return; }
    const clash = items.find((i) => i.trim().toLowerCase() === v.toLowerCase());
    if (clash) { setMsg(`“${clash}” is already in the list.`); return; }
    onChange([...items, v]); setInput(""); setMsg("");
  };
  const remove = (item) => { setMsg(""); onChange(items.filter((i) => i !== item)); };
  return (
    <div className={`${t.card} rounded-xl p-4`}>
      <h3 className="font-bold mb-3 flex items-center gap-2">{icon} {title}</h3>
      <div className="flex gap-2 mb-1">
        <input value={input} onChange={(e) => { setInput(e.target.value); setMsg(""); }} onKeyDown={(e) => e.key === "Enter" && add()} placeholder={placeholder} className={`flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
        <button onClick={add} className="flex items-center gap-1 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold px-4 rounded-lg text-sm"><Plus size={16} /> Add</button>
      </div>
      <div className="mb-3 min-h-[16px]">{msg && <span className="text-xs text-amber-600 flex items-center gap-1"><AlertCircle size={12} /> {msg}</span>}</div>
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
        {/* Scrap-only is a real shift (a run that produced nothing good), so an
            empty UNITS box must not block Save — it counts as 0. */}
        <button onClick={save} disabled={(units === "" && scrap === "") || !dirty}
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
  // Typing here used to write `config:lists` AND PUT /config on every keystroke —
  // "1200" was four writes and four uploads, the last three of them wrong. Keep the
  // keystrokes local and commit once, on blur / Enter.
  const [draft, setDraft] = useState({});
  useEffect(() => { setDraft({}); }, [rates]);
  const valueOf = (m) => (draft[m] !== undefined ? draft[m] : (rates?.[m] ?? ""));
  // Latest values for the tab-hide flush below, which runs from a listener that
  // is installed once and would otherwise close over the first render's state.
  const draftRef = useRef(draft); draftRef.current = draft;
  const ratesRef = useRef(rates); ratesRef.current = rates;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  // Commit the named fields in ONE write: committing them one at a time would
  // build each update from the same `rates` snapshot, and the last write would
  // drop the others.
  const commitFields = (names) => {
    const d = draftRef.current;
    const pending = names.filter((m) => d[m] !== undefined);
    if (!pending.length) return;
    const cur = ratesRef.current || {};
    const next = { ...cur };
    let changed = false;
    for (const m of pending) {
      const n = Math.max(0, Number(d[m]) || 0);
      if (n > 0) next[m] = n; else delete next[m];
      if (n !== (cur[m] || 0)) changed = true;
    }
    setDraft((prev) => { const rest = { ...prev }; for (const m of pending) delete rest[m]; return rest; });
    if (changed) onChangeRef.current(next);
  };
  const commit = (m) => commitFields([m]);
  // Commit-on-blur alone loses a number that was typed and never blurred: the box
  // still shows it, so it LOOKS saved, but a backgrounded tab can be reclaimed at
  // any moment and the edit is gone with no hint. Flush pending drafts on the
  // last-chance signal instead — the same visibilitychange/pagehide pair the stop
  // timer's autosave uses.
  useEffect(() => {
    const flush = () => commitFields(Object.keys(draftRef.current));
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`${t.card} rounded-xl p-4`}>
      <h3 className="font-bold mb-1 flex items-center gap-2"><TrendingUp size={16} /> Machine output rates</h3>
      <p className={`text-xs ${t.sub} mb-3`}>Rated output in units/hour per machine — the theoretical maximum used for the OEE Performance factor. Leave blank to skip Performance for that machine.</p>
      <div className="space-y-2">
        {machines.map((m) => (
          <label key={m} className="flex items-center gap-2 text-sm">
            <span className="flex-1 font-medium">{m}</span>
            <input type="number" inputMode="numeric" min="0" value={valueOf(m)}
              onChange={(e) => setDraft((d) => ({ ...d, [m]: e.target.value }))}
              onBlur={() => commit(m)} onKeyDown={(e) => { if (e.key === "Enter") commit(m); }} placeholder="—"
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
// The handout history. Without this the `hand:` records would be write-only —
// the supervisor needs to see what each shift actually passed on, and which
// flags were left open.
function HandoverLog({ t, handovers }) {
  const [open, setOpen] = useState(false);
  const list = handovers || [];
  const shown = open ? list.slice(0, 30) : list.slice(0, 3);
  return (
    <div className={`${t.card} rounded-xl p-4`}>
      <h3 className="font-bold mb-1 flex items-center gap-2"><PencilLine size={16} /> Shift handovers</h3>
      <p className={`text-xs ${t.sub} mb-3`}>What each operator passed to the next shift, newest first. Kept for 60 days and included in Backup &amp; Restore.</p>
      {!list.length ? (
        <p className={`${t.sub} text-sm`}>No handovers recorded yet. Operators create one from Operator → Handover.</p>
      ) : (
        <div className="space-y-2">
          {shown.map((h) => (
            <div key={h.id} className={`${t.muted} rounded-lg p-3`}>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="font-semibold text-sm">{h.operator} <span className={`font-normal ${t.sub}`}>· {h.machine}</span></span>
                <span className={`text-[11px] ${t.sub} font-mono`}>{fmtTime(h.windowEnd || h.createdAt)}</span>
              </div>
              {h.note && <p className="text-sm mt-1.5 leading-snug">{h.note}</p>}
              {!!(h.flags || []).length && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {h.flags.map((f, i) => (
                    <span key={i} className={`text-[11px] font-semibold px-2 py-1 rounded ${f.level === "fix"
                      ? "bg-red-500/10 text-red-400" : f.level === "watch" ? "bg-amber-500/10 text-amber-500" : "bg-slate-400/10 text-slate-400"}`}>
                      {FLAG_LEVELS[f.level]?.mark} {f.text}
                    </span>
                  ))}
                </div>
              )}
              <div className={`text-[11px] ${t.sub} mt-2`}>{h.stopCount} stop{h.stopCount === 1 ? "" : "s"} · {fmtDur(h.downtimeMs || 0)} downtime</div>
            </div>
          ))}
          {list.length > 3 && (
            <button onClick={() => setOpen((v) => !v)} className="text-emerald-500 text-sm font-semibold hover:underline">
              {open ? "Show fewer" : `Show all (${list.length})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

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

function ShiftHandoverModal({ t, dark, reportBase, handoverEmails, syncCfg, lastHandover, onSaved, onClose }) {
  const [copied, setCopied] = useState(false);
  const [mailState, setMailState] = useState(null); // null | "sending" | "sent" | error string
  const [busy, setBusy] = useState("");             // "" | "share" | "save"
  const [shot, setShot] = useState(null);           // the rendered PNG
  const savedRef = useRef(null);                    // the filed record, so re-sending never duplicates it
  const [err, setErr] = useState("");

  // The operator writes the handover: a message plus their own flags. Nothing
  // here is preset — the words are theirs; the level only picks the colour.
  const [note, setNote] = useState("");
  const [flags, setFlags] = useState([]);
  const [flagText, setFlagText] = useState("");
  const [level, setLevel] = useState("watch");

  const addFlag = (text, lvl) => {
    const v = String(text || "").trim().slice(0, 60);
    if (!v) return;
    setFlags((prev) => (prev.some((f) => f.text.toLowerCase() === v.toLowerCase())
      ? prev : [...prev, { text: v, level: lvl || level }]));
    setFlagText("");
  };
  const removeFlag = (i) => setFlags((prev) => prev.filter((_, n) => n !== i));

  // Snapshot at open: the handout describes the shift as it stood when the
  // operator hit Handover, and freezing it stops `windowEnd: Date.now()` from
  // re-rendering (and re-encoding) the PNG on every timer tick.
  const [base] = useState(reportBase);
  const report = useMemo(
    () => handoutViewModel({
      ...base,
      note: note.trim(),
      flags: flags.filter((f) => f.text && f.text.trim()),
    }),
    [base, note, flags],
  );
  const text = formatReportText(report);
  const canEmail = !!(syncCfg && syncCfg.enabled && syncCfg.url) && (handoverEmails || []).length > 0;
  const fileName = `stoptrack-handover-${report.operator.replace(/\s+/g, "-").toLowerCase()}-${new Date(report.windowEnd).toISOString().slice(0, 10)}.png`;

  // Re-draw the card as the operator types (debounced — drawing is cheap, but
  // toDataURL on every keystroke isn't).
  useEffect(() => {
    const id = setTimeout(() => {
      try { setShot(drawHandout(report)); setErr(""); }
      catch (e) { setErr("Couldn't render the handout image."); }
    }, 180);
    return () => clearTimeout(id);
  }, [report]);

  // Persist the handout so the supervisor keeps a history and the next shift can
  // carry forward what's still open. Called whenever it's actually sent/saved.
  const persist = async () => {
    // Sharing AND saving AND emailing the same handout must file ONE record, so
    // the id/createdAt are minted once and later sends just update it.
    if (!savedRef.current) {
      savedRef.current = { id: `${report.windowEnd}-${Math.floor(Math.random() * 1e6)}`, createdAt: Date.now() };
    }
    const rec = {
      id: savedRef.current.id,
      operator: report.operator,
      machine: report.machineLabel || report.machine,
      machines: (report.machines || []).map((m) => m.machine),
      // The per-machine split, not just the names: a filed handover for a
      // roaming operator was otherwise one blended total, so the supervisor's
      // log couldn't say which machine the downtime belonged to either.
      machineStats: (report.machines || []).map((m) => ({
        machine: m.machine, stops: m.stops, downtimeMs: m.downtimeMs,
        mannedMs: Math.round(m.mannedMs || 0), units: m.units, scrap: m.scrap,
        topReason: m.topReason || null, topReasonMs: m.topReasonMs || 0,
      })),
      shiftName: report.shiftName || null,
      windowStart: report.windowStart, windowEnd: report.windowEnd,
      stopCount: report.stopCount, downtimeMs: report.downtimeMs,
      note: report.note, flags: report.flags,
      createdAt: savedRef.current.createdAt, updatedAt: Date.now(),
    };
    await api.saveHandover(rec);
    if (onSaved) onSaved(rec);
  };

  const doShare = async () => {
    if (!shot) return;
    setBusy("share"); setErr("");
    const res = await shareImage(shot.dataUrl, fileName, text);
    if (!res.ok) setErr(res.error || "Couldn't share the handout.");
    else if (!res.cancelled) await persist();
    setBusy("");
  };

  const doSave = async () => {
    if (!shot) return;
    setBusy("save"); setErr("");
    const res = saveImage(shot.dataUrl, fileName);
    if (!res.ok) setErr(res.error || "Couldn't save the image.");
    else await persist();
    setBusy("");
  };

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
      subject: `StopTrack handover — ${report.machineLabel || report.machine} — ${report.operator}`,
      text,
    }, syncCfg);
    setMailState(res.ok ? "sent" : (res.error || "Send failed"));
    if (res.ok) await persist();
  };

  // Anything the previous shift flagged, offered as one-tap carry-forward.
  const carryForward = ((lastHandover && lastHandover.flags) || [])
    .filter((f) => !flags.some((x) => x.text.toLowerCase() === String(f.text || "").toLowerCase()));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-30" onClick={onClose}>
      <div className={`${dark ? "bg-slate-900" : "bg-white"} rounded-xl shadow-xl p-5 max-w-md w-full space-y-4 max-h-[88vh] overflow-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold"><PencilLine size={18} className="text-emerald-500" /> Shift handover</div>
          <button onClick={onClose} aria-label="Close" className={`${t.sub} hover:text-red-500 p-1`}><X size={18} /></button>
        </div>

        {/* --- what the operator writes ------------------------------------- */}
        <label className="flex flex-col gap-1">
          <span className={`text-xs font-semibold ${t.sub}`}>MESSAGE FOR THE NEXT SHIFT</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={600}
            placeholder="What does the next operator need to know? e.g. infeed guide rail looks worn — jammed twice."
            className={`border rounded-lg px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
        </label>

        <div className="flex flex-col gap-2">
          <span className={`text-xs font-semibold ${t.sub}`}>FLAGS — YOUR OWN WORDS</span>
          <div className="flex gap-1.5">
            {FLAG_ORDER.map((lv) => (
              <button key={lv} onClick={() => setLevel(lv)} aria-pressed={level === lv}
                className={`flex-1 text-xs font-bold py-2 rounded-lg border transition ${level === lv
                  ? (lv === "fix" ? "bg-red-500/15 border-red-400 text-red-400"
                    : lv === "watch" ? "bg-amber-500/15 border-amber-400 text-amber-500"
                    : "bg-slate-400/15 border-slate-400 text-slate-400")
                  : `${t.chip} border-transparent opacity-70`}`}>
                {FLAG_LEVELS[lv].mark} {FLAG_LEVELS[lv].label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={flagText} onChange={(e) => setFlagText(e.target.value)} maxLength={60}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFlag(flagText); } }}
              placeholder="e.g. Asla 2 coolant low"
              className={`flex-1 border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 ${t.input}`} />
            <button onClick={() => addFlag(flagText)} disabled={!flagText.trim()}
              className="flex items-center gap-1 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white font-bold px-4 rounded-lg active:scale-95 transition">
              <Plus size={16} /> Add
            </button>
          </div>
          {!!flags.length && (
            <div className="flex flex-wrap gap-2">
              {flags.map((f, i) => (
                <span key={i} className={`flex items-center gap-2 text-xs font-semibold px-2.5 py-1.5 rounded-lg border ${f.level === "fix"
                  ? "bg-red-500/10 border-red-500/40 text-red-400"
                  : f.level === "watch" ? "bg-amber-500/10 border-amber-500/40 text-amber-500"
                  : "bg-slate-400/10 border-slate-400/40 text-slate-400"}`}>
                  {FLAG_LEVELS[f.level]?.mark} {f.text}
                  <button onClick={() => removeFlag(i)} aria-label={`Remove ${f.text}`} className="opacity-70 hover:opacity-100"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          {!!carryForward.length && (
            <div className="flex flex-wrap gap-2 items-center">
              <span className={`text-[11px] ${t.sub}`}>Still open from last shift:</span>
              {carryForward.map((f, i) => (
                <button key={i} onClick={() => addFlag(f.text, f.level)}
                  className={`flex items-center gap-1 text-xs font-semibold ${t.chip} px-2.5 py-1.5 rounded-lg hover:opacity-80`}>
                  <Plus size={11} /> {f.text}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* --- the handout itself: this image is exactly what gets sent ------ */}
        <div className="flex flex-col gap-1">
          <span className={`text-xs font-semibold ${t.sub}`}>HANDOUT PREVIEW</span>
          {shot
            ? <img src={shot.dataUrl} alt="Shift handout" className="w-full rounded-xl shadow-lg" />
            : <div className={`${t.muted} rounded-xl h-40 flex items-center justify-center text-sm ${t.sub}`}><RefreshCw size={16} className="animate-spin mr-2" /> Rendering…</div>}
        </div>

        {/* --- send it ------------------------------------------------------- */}
        <div className="flex flex-col gap-2">
          <button onClick={doShare} disabled={!shot || busy === "share"}
            className="flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold py-3.5 rounded-lg active:scale-95 transition">
            {busy === "share" ? <RefreshCw size={17} className="animate-spin" /> : <Share2 size={17} />} Share handout
          </button>
          <div className="flex gap-2">
            <button onClick={doSave} disabled={!shot || busy === "save"}
              className={`flex-1 flex items-center justify-center gap-2 ${t.chip} disabled:opacity-50 font-semibold py-3 rounded-lg active:scale-95 transition`}>
              <Download size={16} /> Save image
            </button>
            <button onClick={copy} className={`flex-1 flex items-center justify-center gap-2 ${t.chip} font-semibold py-3 rounded-lg active:scale-95 transition`}>
              {copied ? <><CheckCircle size={16} /> Copied</> : <><PencilLine size={16} /> Copy text</>}
            </button>
          </div>
          {canEmail && (
            <button onClick={email} disabled={mailState === "sending" || mailState === "sent"}
              className={`flex items-center justify-center gap-2 ${t.accentBtn} disabled:opacity-40 font-bold py-3 rounded-lg`}>
              {mailState === "sending" ? <><RefreshCw size={17} className="animate-spin" /> Sending…</>
                : mailState === "sent" ? <><CheckCircle size={17} /> Sent</>
                : <><RefreshCw size={17} /> Email report ({handoverEmails.length})</>}
            </button>
          )}
          {!canEmail && <p className={`text-[11px] ${t.sub} text-center`}>Share works offline. Email needs Server sync + recipients in Supervisor → Settings.</p>}
          {(err || (mailState && mailState !== "sending" && mailState !== "sent")) && (
            <p className="text-xs text-red-500 text-center flex items-center justify-center gap-1"><AlertCircle size={13} /> {err || mailState}</p>
          )}
        </div>
      </div>
    </div>
  );
}
