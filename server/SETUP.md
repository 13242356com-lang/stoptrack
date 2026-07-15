# StopTrack server on a PC — plain guide

This sets up the piece that makes StopTrack work **from anywhere**:

```
  Watch ──────────────┐
  Phone app ──────────┤ all sync to ──▶  ┌──────────────────────────┐
  Any web browser ────┘                  │  Server (a PC you own)    │
                                         │  • keeps ALL the data     │
   Supervisor on their phone,            │  • serves the SUPERVISOR  │
   at home or anywhere ─────────────────▶│    page in a browser      │
                                         └──────────────────────────┘
```

- **Operators** keep using the watch and the phone app — nothing changes for them.
- **Supervisors** open the server's address **in any browser, from anywhere** —
  the full StopTrack appears (log, analytics, exports, settings). Change
  machines / reasons / quick stops there and every phone **and watch** picks the
  change up automatically.

There are two halves: **A)** start the server on a PC (15 min, easy), and
**B)** make it reachable from outside the factory (30 min, one-time).

---

## Part A — Start the server on the PC

You need a PC that stays on (Windows assumed below; any OS works).

1. **Install Node.js** — go to [nodejs.org](https://nodejs.org), download the
   **LTS** version, install it (all defaults). That's the only install.
2. **Make a folder**, e.g. `C:\StopTrack`, and copy **three files** into it from
   the project:
   - `server/server.js`
   - `server/start-stoptrack.bat`
   - `index.html`  ← this is the supervisor page the server will show
3. **Set your factory token** — right-click `start-stoptrack.bat` → **Edit**,
   and change `change-me-to-a-long-random-secret` to your own long random
   password (letters+numbers, 20+ characters). Save. This token is what every
   device must know — treat it like a password.
4. **Double-click `start-stoptrack.bat`.** A black window opens saying
   `StopTrack sync server listening…` — the server is running. Keep the window
   open (closing it stops the server).
5. **Test it:** on the same PC, open a browser and go to
   `http://localhost:4000` — **StopTrack itself should appear.** That page is
   your supervisor interface.

**Find the PC's address for other devices on the factory Wi-Fi:** press
`Win+R`, type `cmd`, Enter, then type `ipconfig`. Look for **IPv4 Address**,
e.g. `192.168.1.50`. Other devices on the same Wi-Fi then use
`http://192.168.1.50:4000`.

**Start automatically when the PC boots (recommended):** Start menu → “Task
Scheduler” → Create Basic Task → name `StopTrack` → trigger **When the computer
starts** → action **Start a program** → browse to your
`C:\StopTrack\start-stoptrack.bat` → Finish.

> **Where's the data?** In `stoptrack-data.json` next to `server.js`. Back that
> one file up now and then and you can never lose your history.

---

## Part B — Reach it from ANYWHERE (not just factory Wi-Fi)

Your PC isn't reachable from the internet by default. The clean, free way to fix
that is a **Cloudflare Tunnel**: a small program on the PC that gives your
server a permanent `https://…` address that works from anywhere — no router
changes, and traffic is encrypted (important, since the token travels with
every request).

**What you need:** a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
and a **domain name** added to it (any cheap one, ~$10/year — e.g.
`yourfactory.com`). If you already own a domain, add it to Cloudflare.

1. On the Cloudflare dashboard: **Zero Trust → Networks → Tunnels →
   Create a tunnel** → type *Cloudflared* → name it `stoptrack`.
2. The page shows one **install command for Windows** — copy it, and run it on
   the PC (it installs the `cloudflared` connector with your tunnel's ID baked
   in). The tunnel shows **Healthy** when connected.
3. Still in the tunnel setup, add a **Public Hostname**:
   - Subdomain: `stoptrack` — Domain: `yourfactory.com`
   - Service type: **HTTP**, URL: `localhost:4000`
4. Done. Your server is now at **`https://stoptrack.yourfactory.com`** from
   anywhere — phone on cellular, home, holiday.

> **Don't want to buy a domain?** Then skip Part B: everything still works on
> the factory Wi-Fi via `http://<pc-ip>:4000`; you just can't reach it from
> home. (Other routes — port-forwarding, a rented cloud server — work too but
> take more care; ask if you want that path.)

---

## Part C — Connect everything (one-time per device)

Use your **anywhere address** (`https://stoptrack.yourfactory.com`) if you set
up Part B, otherwise the **LAN address** (`http://192.168.1.50:4000`).

**Supervisor — any browser, anywhere:**
1. Open the server address. StopTrack appears, with the Server URL prefilled.
2. Go to **Supervisor → Server sync**, enter the **factory token**, tick
   **Enable background sync**, **Save**, then **Test connection** → “Server
   reachable”.
3. That's it. Edit machines / reasons / quick stops / view analytics / export
   from anywhere. Bookmark it on your phone (or *Add to Home screen*).

**Phone app (operators):**
1. Open StopTrack → **Supervisor → Server sync**.
2. Server URL = the server address, token = the factory token, tick **Enable**,
   **Save**.

**Watch:**
1. Open StopTrack on the watch, scroll down to **Server sync**.
2. Tap **Server URL** and type the address (you can skip `https://` — e.g. just
   `stoptrack.yourfactory.com`, or `192.168.1.50:4000` on the LAN).
3. Tap **Token** and enter the factory token.
4. The footer shows **“Server synced”** when connected. Stops now upload
   directly, and supervisor changes appear on the watch within ~15 seconds.

---

## If something's not working

- **"Failed to fetch" / it filled in `http://0.0.0.0:4000`** — `0.0.0.0` is not
  a connectable address (it's the server saying "I listen on everything"). In
  the Server URL field use **`http://localhost:4000`** on the same PC, or the
  PC's **LAN IP** (e.g. `http://192.168.1.50:4000`) from another device. The
  server window now prints the exact addresses to use.
- **Browser shows nothing at the LAN address** — is the black server window
  still open on the PC? Are both devices on the same Wi-Fi? Windows Firewall may
  ask to allow Node — click **Allow**.
- **“Test connection” fails but the page loads** — the token doesn't match.
  Re-check `start-stoptrack.bat` vs what you typed on the device.
- **Watch says “Server unreachable”** — check the watch has Wi-Fi (watch
  Settings → Connections). On LAN, the watch must be on the same Wi-Fi as the
  PC. Stops are never lost — they queue and send when back online.
- **Tunnel address stopped working** — on the PC check the cloudflared service
  is running (Cloudflare dashboard shows the tunnel as Healthy).

## Security notes (short version)

- The **token is the key to your data** — long, random, shared only with your
  own devices. Change it in one place (`start-stoptrack.bat`) if it ever leaks,
  then re-enter it on devices.
- Going through the **tunnel is encrypted (https)**. Plain `http://` is fine
  inside the factory LAN, but never expose port 4000 straight to the internet.
