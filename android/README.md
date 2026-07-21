# StopTrack — Samsung / Wear OS companion

A native Android project that puts the StopTrack **operator stop-timer** on a
Samsung Galaxy Watch (Wear OS 3+), with a small **phone companion** that bridges
the watch to the existing StopTrack web app.

> **Why a native project and not the web app?** Wear OS 3+ (Galaxy Watch 4 and
> newer) ships **no user-facing browser**, so `index.html` can't run on the
> watch. A Wear OS app has to be an installed APK. This project is that APK (plus
> its phone-side companion). It lives *alongside* the web app — it is **not**
> generated from `StopTrack.tsx`. The one thing they share is the **sync API
> contract** (`../server/README.md`), so they never drift.

---

## The model: companion first, server last

```
┌─────────────┐   Wear Data Layer    ┌──────────────────────┐   http://127.0.0.1:<port>   ┌──────────────┐
│  Watch app  │ ──(Bluetooth/local)─▶ │  Phone companion app │ ◀──(existing sync API)────  │  Web app     │
│ timer loop  │ ◀── config / ack ─── │  local store + server │                             │ (Chrome/PWA) │
└─────────────┘                      └──────────┬───────────┘                             └──────────────┘
                                                 │ optional · last resort
                                                 ▼
                                     ┌──────────────────────┐
                                     │  StopTrack server     │  (../server)
                                     └──────────────────────┘
```

- **Watch ⇄ phone is server-free.** The watch talks only to the paired phone over
  the Wear Data Layer. No network, no credentials on the watch. Stops are stored
  on the phone the moment they arrive.
- **The web app is unchanged.** The phone companion runs a tiny HTTP server on
  `127.0.0.1` speaking StopTrack's exact sync contract. Point the web app's
  **Supervisor → Server sync** at `http://127.0.0.1:<port>` and every watch-logged
  stop shows up in the supervisor view — with no external server involved.
- **The remote server is optional and last-resort.** The companion only forwards
  to a remote StopTrack server if you enable it (e.g. to share across sites).

---

## Modules

| Module | What it is |
|--------|-----------|
| `:shared` | Pure Kotlin/JVM. The `StopRecord` / `WatchConfig` / `QuickStop` model (matching the web record byte-for-byte), the sync-contract path constants, the Wear Data Layer protocol, LWW helpers, a `HttpURLConnection` `RemoteSyncClient`, and **`TimerEngine`** (`Timer`/`TimerState`, a faithful port of the web `useTimer`) — shared by the watch and the phone quick-timer. |
| `:wear` | The Wear OS app (Compose for Wear OS). The operator timer loop — Start / Pause / Resume / End, reason + quick-stop selection, and a phone-link/outbox status footer. Drives the shared `Timer`. |
| `:mobile` | The phone companion + full app. `PhoneStore` (on-device data set like `server.js`), `LocalSyncServer` (NanoHTTPD on loopback), the Wear listener/bridge, an optional `RemoteForwarder`, a Compose setup/status screen, and the **quick-stop presence** (`QuickStopController` + notification actions + `OverlayController` floating bubble). |

### Quick-stop presence (notification + floating bubble)
So an operator can log a stop **without opening the app**, `CompanionService`
hosts the native quick-timer (`QuickStopController`, reusing the shared `Timer`).
This is the **single source of truth** for the phone's stop timer: the
notification, the floating bubble, **and** the in-app WebView all drive and mirror
this one timer, so they can never disagree.
- The **persistent notification** shows the live stop timer (Idle / Recording
  mm:ss / Paused) with a monochrome status-bar icon and **Start / Pause / End**
  actions — works with the app backgrounded or closed.
- On **End** the stop is *not* auto-recorded with a default reason. It becomes a
  `pending` `FinishedStop`, and the app is brought forward to its existing **reason
  picker**; picking a reason (`documentStop`) writes the `StopRecord` into
  `PhoneStore`, which the web app + supervisor pick up via the loopback sync.
- The **floating "Shazam-style" bubble** (`OverlayController`, a draggable
  `WindowManager` overlay) mirrors + toggles the same timer over other apps. It
  needs the one-time **Display over other apps** permission (`SYSTEM_ALERT_WINDOW`),
  toggled in Bridge settings → *Quick stop*.
- The WebView is wired to native through the two-way `MainActivity.NativeBridge`:
  JS→native `startStop/pauseStop/resumeStop/endStop/documentStop/discardStop`, and
  native→JS state pushes via `window.StopTrackShell.onState(...)`. In a plain
  browser (no shell) the web app falls back to its own local timer, unchanged.

---

## Get the app files (APKs)

**Easiest — download the ready-made ones (no tools needed).** GitHub Actions
builds both APKs on every push to `main` (`.github/workflows/android.yml`) and
publishes them to the repo's **Releases** page as `StopTrack-phone.apk` and
`StopTrack-watch.apk` — grab them from Repo → **Releases** → *Latest StopTrack
build*. (They're also on every run under **Actions → Build watch app →
Artifacts → stoptrack-apks** as the raw `mobile-debug.apk` / `wear-debug.apk`.)
A plain click-by-click guide is in [`INSTALL.md`](INSTALL.md).

**Or build locally** with Android Studio (Ladybug+) or the Android SDK + JDK 17:

```bash
cd android
./gradlew :mobile:assembleDebug   # phone companion APK
./gradlew :wear:assembleDebug     # watch APK
```

APKs land in `mobile/build/outputs/apk/debug/` and `wear/build/outputs/apk/debug/`.

> **Build status:** the full project (`:shared` + `:wear` + `:mobile`) compiles
> cleanly in CI on the Android SDK — both APKs are produced on every push. It was
> authored without a local SDK, so *runtime* behaviour (Data Layer pairing, the
> loopback bridge) still needs checking on a real phone + watch — see "Verify on
> device" below.

### Install & pair

1. Install **StopTrack Companion** (`:mobile`) on the phone. Open it once and grant
   the notification permission — it starts a foreground "bridge" service.
2. Install **StopTrack** (`:wear`) on the paired watch (Android Studio can deploy
   straight to a Wear device/emulator, or use `adb`).
3. On the watch, open StopTrack, pick a machine, and press **Start stop**.

### Connect the web app (the server-free path)

On the **same phone**, open the StopTrack web app in Chrome and go to
**Supervisor → Server sync**:

- **Server URL** → `http://127.0.0.1:4000` (match the port shown in the companion).
- **Factory token** → leave blank unless you set one in the companion.
- Tick **Enable background sync** → **Save**.

Watch-logged stops now appear in the supervisor view. Nothing leaves the phone.

### Optional: forward to a shared server (last resort)

In the companion's **Remote server** card, enter a `../server` URL + token and flip
**Forward to a shared server** on. The companion then push/pulls deltas
last-write-wins, exactly like the web app's own sync.

---

## Verify on device

These can't be checked without hardware; confirm them on a real phone + watch:

1. **Data Layer pairing** — starting a stop on the watch and ending it makes the
   companion's "Stops stored" count go up; the watch's outbox footer clears
   ("Linked to phone").
2. **Loopback bridge** — the web app's **Test connection** succeeds against
   `http://127.0.0.1:<port>` and stops sync into the supervisor view.
   - The web app is served over **https** (Cloudflare) but calls **http loopback**.
     Chrome treats `127.0.0.1` as a trustworthy origin, and `LocalSyncServer`
     answers the **Private Network Access** preflight
     (`Access-Control-Allow-Private-Network: true`). If a browser build ever
     blocks it, opening the app from `http://localhost` or as an installed PWA
     avoids the issue.
3. **Offline resilience** — log a stop with the phone out of Bluetooth range; the
   watch keeps it in its outbox and delivers it (with an ack clearing the outbox)
   when the phone is back.

---

## How this maps to the web app

| Web app concept | Here |
|-----------------|------|
| `useTimer` (derived elapsed, pause banks one segment) | `wear/TimerEngine.kt` |
| stop record (`id`, `loggedAt`, `updatedAt`, …) | `shared/StopRecord.kt` |
| `api` object / sync contract | `shared/SyncContract.kt` + `mobile/LocalSyncServer.kt` |
| `server.js` store (LWW, tombstones) | `mobile/PhoneStore.kt` |
| Supervisor → Server sync | the companion is what the URL points at |

Keep `:shared` in step with the web record if the data model changes.
