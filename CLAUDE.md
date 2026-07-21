# StopTrack — Project Guide for Claude

This file tells Claude (and Claude Code) everything it needs to work on StopTrack
without re-explaining the project each session. Read this first.

---

## What StopTrack is

StopTrack is a **universal machine downtime tracker** for any factory line.
Operators run it on their phone to log when a machine stops, why it stopped, and
for how long. A supervisor view aggregates the data into analytics and exports.

It is a **single-file, offline-first web app**. The whole thing ships as one
`index.html` that an operator opens in Chrome on their phone — no server, no
install, no build step on the user's side.

### Who uses it
- **Operators** — on the shop floor, on a phone, often with gloves, sometimes
  with no signal. Speed and reliability matter more than features. Big tap
  targets, minimal typing.
- **Supervisor** — reviews the log, analytics, and exports data to CSV/JSON.

---

## The two files in this project

| File | Role |
|------|------|
| `StopTrack.tsx` | **The editable source.** React + JSX. This is what you edit. |
| `index.html` | **The deployed artifact.** Pre-compiled, standalone, runs on the phone. Generated FROM the `.tsx` — never hand-edit it. |

**Golden rule: edit `StopTrack.tsx`, then rebuild `index.html` from it.**
Do not edit the `.html` by hand — it contains machine-generated `React.createElement`
code that is painful to edit correctly and will drift from the source.

---

## Architecture at a glance

- **React 18** with hooks. No Redux, no router — one `App` component with two
  views (`OperatorView`, `SupervisorView`) switched by a tab in state.
- **Icons** are inline SVGs. In the `.tsx` they're imported from `lucide-react`
  for readability; during the build they're replaced by a small inline icon set
  (see "Build process"). Never add a runtime dependency for icons.
- **Tailwind CSS** via CDN (utility classes in `className`).
- **Storage** goes through a single `api` object (see below). No component
  touches storage directly.

### The timer (`useTimer` hook)
Single source of truth for the live stopwatch. Key design decisions, keep them:
- `elapsed` is **derived**, never stored as state, so it can't drift.
- Pause banks the segment into `accumulated` exactly once; resume starts a fresh
  segment. Don't reintroduce a separate `elapsed` state variable.
- The re-render interval only runs while actively timing (not paused/idle).
- Autosaves in-progress state on every change and on tab-hide, enabling recovery
  if the app is closed mid-stop.

### Storage layer (`api` object + `pickBackend`)
Offline-first with a fallback chain, all behind one async interface:
1. `window.storage` — only exists inside the Claude artifacts runtime (shared scope).
2. `localStorage` — the real backend when running as a standalone `.html`. **This
   is what actually runs on the phone.**
3. in-memory `Map` — last resort if storage is blocked, so the UI still works
   for the session (data lost on close).

`STORAGE_INFO` exposes `{ kind, persistent, shared }`; the operator view shows a
banner when data is device-only or non-persistent.

**Data is per-device.** localStorage does not sync between phones, so the
supervisor view only sees stops logged on that same device. Cross-device sync is
the intended "server step" — the `api` object is the swap point. Each method has
a comment marking where a `fetch()` call would replace the local one. Keep that
seam clean.

### Storage keys
- `stop:<id>` — one record per stop
- `config:lists` — machines / reasons / quickStops / shifts (each shift =
  {id,name,start,end,goals:{machine:units}}) / rates / handoverEmails. A legacy
  `shift` {start,end} mirror of the first shift is written alongside for old
  clients / the watch config.
- `config:prefs` — dark mode, last reason, cleared-before cutoff, operator,
  machine, setupLocked, shiftId (the operator's chosen shift)
- `inprogress:current` — live-timer autosave for recovery

---

## The stop record (data model)

```js
{
  id,            // `${start}-${random}`
  machine,       // e.g. "Line 1"
  operator,      // trimmed name, or "Unnamed"
  start, end,    // epoch ms. For manual stops, start is BACK-DATED by duration.
  duration,      // ms
  reason,        // from the configurable reasons list
  notes,         // optional
  manual,        // true if entered via manual report (else absent/false)
  discarded,     // soft-discard flag (kept in storage + exports)
  discardReason, // set when discarded
  discardedAt,   // epoch ms; auto-purged after 60 days
  loggedAt,      // WHEN the record was created. Drives shift membership. Critical — see below.
}
```

### `loggedAt` — read this before touching stop filtering
A **manual** stop back-dates its `start` (a 15-min stop reported now gets a start
15 min ago). The operator's current-shift filter must use **`loggedAt`** (when it
was recorded), NOT `start` — otherwise a back-dated manual stop can fall before
the "New Shift" cutoff and vanish from the operator view while still showing in
the supervisor view. This was a real bug; the fix was `loggedAt`. Filter uses
`s.loggedAt ?? s.end ?? s.start` for backward compatibility with older records.

---

## Features (current state)

**Operator view**
- Stat cards at the top: Stops, Downtime, Last Hour, Uptime (current shift only).
- Operator + machine fields with a **Lock setup** / **Unlock setup** button. A
  locked setup persists across refresh (name + machine restored, stays locked);
  an unlocked session starts blank on refresh. Persisted in `config:prefs`.
- Live timer: Start / Pause / Resume / End Stop.
- **Report a stop manually** button → duration-based entry (min + sec), reason,
  notes. Saved as a normal record with `manual: true`.
- Document-stop flow after ending a timer (reason, quick-stops, notes).
- "This shift" summary + **New Shift** button (with confirmation): hides current
  stops from view via a `clearedBefore` cutoff. **Never deletes** — data stays in
  storage, supervisor view, and exports.
- **Show all / Hide earlier** toggle: reversibly reveals stops hidden by New
  Shift without erasing the cutoff. (Earlier bug: "Show all" used to wipe the
  cutoff irreversibly — don't reintroduce that.)
- Recent stops list.
- **Downtime by reason** breakdown at the bottom (current shift).

**Supervisor view**
- Stat cards, search, machine filter, date-range filter (all / 7d / 30d / custom).
- Log table with a **manual** badge on manually-reported stops.
- Analytics: 7-day downtime trend, top problem machines, downtime by reason.
- Settings: shifts (each with times + optional per-machine output goals),
  machines list, reasons list, quick stops, machine rates.
- **Discard** (soft, requires explanation, kept in exports, auto-purged after 60
  days) and **Delete permanently** (hard delete, confirmation required).
- **Export CSV / JSON** — respects current filters, includes discarded rows and a
  timed/manual "Entry" column.
- **Backup & Restore** (Settings) — `api.exportAll()` writes ONE portable JSON of
  everything (config + prefs + all stops/production/sessions); `api.importAll()`
  merges it back last-write-wins. This is how data carries across app versions,
  since a freshly-downloaded `index.html` is a new storage origin (empty) and a
  re-signed APK reinstalls blank. A recovery banner offers Restore on an empty
  install.

**Global**
- Dark mode toggle (persisted).
- Recovery prompt on load if a stop was mid-timer when the app closed.
- Red full-screen **error overlay** if the app fails to start or throws — nothing
  fails silently. Keep this.

---

## Constraints — do not violate these

1. **No Babel in the browser.** The HTML must be pre-transpiled plain JS. An
   earlier Babel-in-browser version hung on "Loading…". The build compiles JSX →
   `React.createElement` ahead of time.
2. **Single self-contained HTML output.** No bundler, no `node_modules` for the
   end user. Only external loads are the React + Tailwind CDNs.
3. **Must run by double-clicking the `.html` in Chrome on a phone.** Test the
   real artifact, not just the source.
4. **Keep the error overlay and the CDN-load check.** They're the safety net.
5. **Keep it offline-tolerant.** Needs the CDNs on first load (they cache after),
   but all data/logic is local. Don't add features that require a network call at
   runtime without flagging it.
6. **Keep the `api` object as the only storage touchpoint** so the future
   server-sync swap stays a one-place change.
7. **Universal, generic defaults.** StopTrack is not tied to any one workplace.
   Reasons/machines default to neutral examples (Line 1–3, Packaging, Assembly;
   Mechanical fault, Tooling change, Cleaning, Material jam, etc.) that a
   supervisor edits to match their line. Keep defaults generic — never hard-code a
   specific customer's machine or process names.

---

## Build process (TSX → HTML)

**The build is now committed: run `npm run build`** (from the repo root; needs
`npm ci` once for the pinned TypeScript). It runs `build/build.mjs`, which does
everything below automatically and writes `index.html` + `dist/index.html`, with
the JSX/`??`/`?.` gate checks built in. The static scaffold lives in
`build/head.html`, `build/icons.js`, `build/tail.html`. The manual steps below are
documentation of what that script does.

The `.html` is produced by: (1) prepending an inline-SVG icon set that replaces
the `lucide-react` import, (2) transpiling JSX to classic-runtime plain JS with
TypeScript's compiler, (3) wrapping it in an HTML shell with the CDNs, error
overlay, and mount call.

**Transpile command** (TypeScript compiler, classic React runtime, ES2017 for
broad mobile-Chrome support — note this compiles `??`/`?.` down to safe forms):

```bash
tsc build_src.tsx \
  --jsx react --jsxFactory React.createElement --jsxFragmentFactory React.Fragment \
  --target es2017 --module none --lib es2017,dom \
  --skipLibCheck --noResolve --allowJs --removeComments --ignoreDeprecations 6.0 \
  --outFile app.js
```

Where `build_src.tsx` = [inline icon definitions] + [the App body from
`StopTrack.tsx` with the `import`/`export` lines stripped]. Then:
`cat head.html app.js tail.html > index.html`.

### Validation before shipping (do this every build)
- `node --check app.js` (or on the extracted script block) → must pass. This is
  the real correctness gate; Node uses the same V8 parser as Chrome.
- Confirm zero leftover JSX in the compiled JS: `grep -oE '<[A-Z][a-zA-Z]+' app.js`
  should return nothing.
- Confirm no raw `??` survived to the output (ES2017 target should remove it).
- Ideally: open `index.html` in a real browser and click through the changed
  feature. In Claude Code, use the Browser pane to actually verify — the chat
  workflow could only validate parsing, not runtime behavior.

> If you're a build step that can't run `tsc`, say so explicitly rather than
> hand-writing `React.createElement` — hand-conversion of 1000+ lines is
> error-prone.

---

## The Wear OS companion (`android/`)

A **native Android project** that puts the operator stop-timer on a Samsung /
Wear OS watch. It lives **alongside** the web app and is **not** built from
`StopTrack.tsx` — the two share only the **sync API contract** (`server/README.md`).
Full details in `android/README.md`. Key facts for future sessions:

- **Why native:** Wear OS 3+ has no browser, so `index.html` can't run on the
  watch. A watch app must be an installed APK.
- **Two sync paths, server first:** the watch's **primary, reliable path is
  direct HTTP sync to `server/`** (URL + token entered on the watch; push
  stops, pull supervisor config every ~15 s — `OperatorViewModel.serverSync`).
  The **Wear Data Layer** watch ⇄ phone path still exists as a server-free
  fallback but proved fragile on real hardware (pairing/Play-Services/cert
  preconditions); don't rely on it alone. `server/server.js` also **serves the
  web app at `/`** so a supervisor can open the server URL from anywhere and
  edit config (see `server/SETUP.md`).
- **The web app is unchanged:** the phone companion runs a local HTTP server on
  `127.0.0.1` speaking the StopTrack sync contract. Point **Supervisor → Server
  sync** at `http://127.0.0.1:<port>` and watch stops appear in the supervisor
  view. (Needs CORS + Private Network Access headers — handled in
  `mobile/LocalSyncServer.kt`.)
- **Modules:** `:shared` (record model + contract + **`TimerEngine`** = the
  `Timer`/`TimerState` port of `useTimer`, pure Kotlin — the only piece that must
  track the web record), `:wear` (Compose watch app; drives the shared `Timer`),
  `:mobile` (full app + bridge: `PhoneStore` mirrors `server.js`, `LocalSyncServer`,
  Wear listener, optional `RemoteForwarder`, and the **quick-stop presence** —
  `QuickStopController` + notification actions + `OverlayController` floating
  bubble, so a stop can be logged from the notification/bubble without opening the
  app; needs `SYSTEM_ALERT_WINDOW` for the overlay).
- **Build reality:** needs the Android SDK + Android Studio; **can't be built or
  runtime-tested in the cloud/CI session** (no SDK, no watch). Only `:shared`
  and the wear timer/format logic are compile-verified. Build in Android Studio;
  verify Data Layer pairing + the loopback bridge on real hardware.
- **Keep `:shared` in step** with the web stop record if the data model changes.

## Working style that fits this project

- **Edit the smallest surface.** Change the two functions involved, not the whole
  file. This project has been iterated many times; respect existing structure.
- **Verify, don't assume.** After a change, rebuild and actually run it. Several
  past bugs (Babel hang, "Show all" one-way, manual stops missing from operator
  view) only showed at runtime, not in parsing.
- **Be honest about limitations.** Per-device data, first-load network need, and
  approximate uptime (assumes the configured shift length) are known and
  acceptable — call them out, don't silently paper over them.
- **Match the operator reality.** Any operator-facing change should survive
  gloves, glare, quick taps, and a possible refresh mid-shift.

---

## Known limitations (acceptable, documented)

- **Per-device storage** — no cross-device sync yet (server step, `api` seam).
- **First load needs internet** — React + Tailwind from CDNs; cache after.
- **Uptime %** assumes the shift length set in Supervisor → Settings; it's an
  estimate, not sensor-truth.
- **Recent stops** sort by event time, so a back-dated manual stop may sit lower
  in the list than when it was logged (it still counts correctly in stats).

---

## Glossary (domain context)

- **Machine / line** — whatever equipment a supervisor configures; StopTrack is
  machine-agnostic. Defaults ship as generic examples (Line 1–3, Packaging,
  Assembly) meant to be replaced per deployment.
- **Shift** — a supervisor-defined time frame (name + start/end + optional output
  goal) that operators pick from; drives uptime %, pace, and goal achievability.
- **OEE** — Overall Equipment Effectiveness (availability × performance ×
  quality). StopTrack currently surfaces the availability/uptime side.
