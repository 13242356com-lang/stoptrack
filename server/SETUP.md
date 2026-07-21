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
3. **Double-click `start-stoptrack.bat`.** A black window opens. **No token to
   set up** — the server makes its own the first time and prints it. Keep the
   window open (closing it stops the server). You'll see something like:

   ```
   ================================================================
     StopTrack server is READY — set up each device with:

      Address (this PC):  http://localhost:4000
      Address (Wi-Fi):    http://<PC-IP>:4000

      Auth token:         Xq7t-9fКd2s…   <- your unique token
     ...
   ================================================================
   ```

   **Write down the `Auth token` line** — that's what every device uses. It's
   saved in `stoptrack-token.txt` and stays the same on every restart. (Prefer
   your own token? Set `FACTORY_TOKEN` and it uses that instead.)
4. **Test it:** on the same PC, open a browser and go to `http://localhost:4000`
   — **StopTrack itself should appear.** That page is your supervisor interface.

**The `Address (Wi-Fi)` line** the server printed is what other devices on the
factory Wi-Fi use (e.g. `http://<PC-IP>:4000`). If you need to find it another
way: `Win+R` → `cmd` → `ipconfig` → **IPv4 Address**.

**Start automatically when the PC boots (recommended):** Start menu → “Task
Scheduler” → Create Basic Task → name `StopTrack` → trigger **When the computer
starts** → action **Start a program** → browse to your
`C:\StopTrack\start-stoptrack.bat` → Finish.

> **Where's the data?** In a **`data`** folder next to `server.js` — it holds
> everything (your history + the auth token). Copy that folder somewhere safe
> now and then and you can never lose your history.

> **Live logs:** the black window shows what's happening as it happens — e.g.
> `saved 2 stop(s) from 192.168.1.30`, `settings updated by …`,
> `unauthorized … (wrong token)`. Handy for confirming a device is really
> talking to the server. (Want every single request? Set `LOG_VERBOSE=1`.)

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
5. **(Nice-to-have)** so the server window prints that anywhere-address for you,
   edit `start-stoptrack.bat` and set it: change the `set PUBLIC_URL=` line to
   `set PUBLIC_URL=https://stoptrack.yourfactory.com`, then restart the server.

> **Don't want to buy a domain?** Then skip Part B: everything still works on
> the factory Wi-Fi via `http://<PC-IP>:4000`; you just can't reach it from
> home. (Other routes — port-forwarding, a rented cloud server — work too but
> take more care; ask if you want that path.)

---

## Part B2 — Make it private (recommended if you use the tunnel)

With Part B, the token is the only thing standing between the internet and your
data. That's a decent lock, but the *address itself* is publicly reachable. For a
proper front door, add **Cloudflare Access** — a free login gate that sits in
front of the tunnel, so nobody even reaches the server until they've proven who
they are (a one-time code emailed to them, or Google/Microsoft sign-in). You keep
"edit from anywhere"; you just log in first.

1. Cloudflare dashboard → **Zero Trust → Access → Applications → Add an
   application** → **Self-hosted**.
2. **Application domain:** `stoptrack` . `yourfactory.com` (the same hostname
   from Part B).
3. Add a **policy**: name it `Supervisors`, action **Allow**, and add a rule —
   e.g. **Emails** → list the supervisor email addresses (or **Emails ending in**
   → `@yourfactory.com`). Save.
4. Done. Opening `https://stoptrack.yourfactory.com` now asks for a login first;
   only the emails you listed get in, then the normal token screen appears.

> **Watches / phones on cellular:** Cloudflare Access challenges the *browser*
> nicely, but the watch/phone apps sync in the background and can't do a login
> screen. Two easy ways to keep them working: (a) keep the watches syncing over
> the **factory Wi-Fi / LAN** (`http://<PC-IP>:4000`, which Access doesn't touch),
> or (b) add a **Service Token** in Cloudflare Access for the apps. If you want
> route (b), ask and I'll wire the app's requests to send it.

If you'd rather not run the tunnel at all, the server also works **LAN-only** —
just don't do Part B, and it's only reachable on the factory network. (I can also
add a `HOST` setting to bind it to a specific interface if you want it tighter.)

---

## Part C — Connect everything (one-time per device)

Use your **anywhere address** (`https://stoptrack.yourfactory.com`) if you set
up Part B, otherwise the **LAN address** (`http://<PC-IP>:4000`).

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
   `stoptrack.yourfactory.com`, or `<PC-IP>:4000` on the LAN).
3. Tap **Token** and enter the factory token.
4. The footer shows **“Server synced”** when connected. Stops now upload
   directly, and supervisor changes appear on the watch within ~15 seconds.

---

## If something's not working

- **"Failed to fetch" / it filled in `http://0.0.0.0:4000`** — `0.0.0.0` is not
  a connectable address (it's the server saying "I listen on everything"). In
  the Server URL field use **`http://localhost:4000`** on the same PC, or the
  PC's **LAN IP** (e.g. `http://<PC-IP>:4000`) from another device. The
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

- The **token is the key to your data** — anyone who has it can read and change
  everything. It's auto-generated and saved in `stoptrack-token.txt` inside your
  data folder. Keep it secret; share it only with your own devices. **If it ever
  leaks, rotate it:** delete `stoptrack-token.txt`, restart the server (a new
  token prints), and re-enter the new token on each device.
- **Prefer the tunnel — it's encrypted (https).** Plain `http://` on the factory
  LAN sends the token in the clear, so anyone able to sniff the network could
  capture it. That's acceptable only on a trusted, switched LAN. For anything
  beyond that — remote access, guest Wi-Fi, or if you're unsure — go through the
  **HTTPS tunnel** so the token and data are encrypted end to end.
- **Never expose port 4000 straight to the internet.** Put it behind the tunnel
  (or a proper HTTPS reverse proxy). The token is the only gate, and it's a
  single shared secret — treat losing it like losing a master key.
- Fuller threat model and the deliberate tradeoffs are in
  [`../SECURITY.md`](../SECURITY.md).
