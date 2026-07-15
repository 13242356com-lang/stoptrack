# Installing StopTrack on a Samsung watch — plain guide

No coding. This walks you through getting the two apps onto a phone and a watch.

There are **two apps**:
- **Phone app** ("StopTrack Companion") — the bridge. Easy to install.
- **Watch app** ("StopTrack") — the timer. The fiddly part.

They work **together, offline**. The watch talks to the phone over Bluetooth; the
phone remembers everything. No internet or server needed.

---

## Part 1 — Download the two app files

**Easiest — the Releases page (direct downloads, no zip):**
1. Open the project on **github.com** in a browser.
2. On the right-hand side of the repo front page, click **Releases** (or go to
   `…/releases`).
3. Open **Latest StopTrack build** and under **Assets** download:
   - **StopTrack-phone.apk** ← the **phone** app
   - **StopTrack-watch.apk** ← the **watch** app

**Alternative — the Actions tab** (if a Release isn't there yet):
1. **Actions** tab → **Build watch app** → newest row with a **green tick** ✓.
2. Scroll to **Artifacts** → **stoptrack-apks** → download the `.zip` and unzip.
   Inside: `mobile-debug.apk` (the phone app) and `wear-debug.apk` (the watch app)
   — the same files as the Release, just with their raw build names.

> A "green tick" means the apps built fine. A red ✗ means something broke — tell
> whoever maintains the code and they can fix it; a new green build will appear.

---

## Part 2 — Install the PHONE app (easy, ~2 minutes)

1. Send `StopTrack-phone.apk` to the phone (email it to yourself, or copy it over USB,
   or put it in Google Drive and open it on the phone).
2. On the phone, tap the file.
3. Android will say it can't install from unknown sources — tap **Settings**, turn
   on **Allow from this source**, go back, and tap **Install**.
4. Open **StopTrack Companion**. Allow notifications when asked. You'll see a screen
   showing "Bridge status", a web-app address, and watch info. Leave it installed —
   it runs quietly in the background.

That's the phone done.

---

## Part 3 — Install the WATCH app (the tricky part)

A watch won't let you just tap a file. Pick **one** of these:

### Option A — Sideload it (free). Two ways: from the phone, or from a computer.

A Galaxy Watch charges on pins, not a data cable, so this is always done over
**Wi‑Fi**. Put **the watch and the helper device on the same Wi‑Fi network first.**

First, unlock the watch's developer tools (same for both ways):
1. On the watch: **Settings → About → Software** → tap **Software version** about
   **7 times** until it says developer mode is on.
2. **Settings → Developer options** → turn on **Wireless debugging**.
3. Tap **Wireless debugging → Pair new device**. It shows a **6‑digit code** and an
   address like `192.168.1.20:37xxx`. **Leave this screen open.**

#### A1 — From the phone, no computer (recommended)
1. Save `StopTrack-watch.apk` onto the phone (from Part 1).
2. On the phone, install **Bugjaeger Mobile ADB** from the Play Store (free).
3. Open Bugjaeger → the **connect / +** button → **Pair** using the watch's
   `IP:port` **and** the 6‑digit code from the watch's pairing screen.
4. Back on the watch's main **Wireless debugging** screen there's a *different*
   `IP:port` (the connect one). In Bugjaeger, **Connect** to that.
5. In Bugjaeger, choose **Install APK / package** → pick `StopTrack-watch.apk`.
6. **StopTrack** appears in the watch's app list.

> The confusing part is the two addresses: the **pairing** screen has one
> `IP:port` + code (used once to pair), and the **main** Wireless‑debugging screen
> has another `IP:port` (used to connect). Keep both handy.

#### A2 — From a computer (if you'd rather)
Anyone with Android "platform-tools" installed can run, on the same Wi‑Fi:
`adb pair <ip:pair-port>` (enter the code), then `adb connect <ip:connect-port>`,
then `adb install StopTrack-watch.apk`.

### Option B — Google Play (best for several watches; ongoing)
This is the proper way to roll out to a fleet. It needs a one-time **$25 Google Play
developer account**, then:
1. Upload `StopTrack-watch.apk` (ideally a signed "release" build) to **Play Console** as
   an **Internal testing** release.
2. Add each operator's Google account as a tester.
3. On each watch, open the **Play Store**, and StopTrack installs like any normal app.

> If you tell me which route you want, I can prepare exactly what it needs
> (a signed release build for Play, or a short adb cheat-sheet for Option A).

---

## Part 4 — Turn it on

1. On the **watch**, open **StopTrack**. Tap a **machine**, then **Start stop**.
   Use **Pause / End** as the machine stops and restarts. After **End**, tap the
   reason. That's the whole operator job.
2. Finished stops travel to the phone automatically (they queue on the watch if the
   phone is briefly out of range, and send when it's back).

### See the data in the web app (optional but recommended)
On the **same phone**, open the StopTrack web app in Chrome:
1. Go to **Supervisor → Server sync**.
2. **Server URL**: type the address shown on the companion's home screen
   (looks like `http://127.0.0.1:4000`).
3. Leave the token blank (unless you set one on the companion).
4. Tick **Enable background sync** → **Save** → **Test connection** (should say
   reachable).

Now every stop logged on the watch shows up in the supervisor view — all on the
phone, no server.

---

## If something's not working

- **Watch says "Phone offline"** — make sure the watch and phone are paired in the
  Galaxy Wearable app and Bluetooth is on. Stops are kept safe on the watch and
  send once reconnected.
- **Web app "Test connection" fails** — check the port number matches the one on the
  companion screen, and that StopTrack Companion is still open/installed. If your
  browser blocks it, open the web app from `http://localhost` or install it as an
  app (Chrome menu → *Add to Home screen*).
- **No stops showing in the supervisor view** — confirm background sync is ticked
  and you pressed **Save** in the web app.

---

## What "optional server" means

You can ignore the **Remote server** section on the companion entirely — the watch
and phone work without it. It's only for sending data to a shared company server so
multiple sites see the same numbers. Turn it on later if you ever need that.
