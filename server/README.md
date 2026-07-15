# StopTrack sync server

Optional backend so every phone running **StopTrack** shares one data set instead
of each device keeping its own copy. StopTrack stays **offline-first**: stops are
always saved locally first, queued, and uploaded when the device can reach this
server. The supervisor view then sees stops from every device.

This is a **reference implementation** — small, dependency-free, and easy to
replace. The binding artifact is the [API contract](#api) below; any backend that
honours it will work with the app unchanged.

> **Plain-language setup guide** — PC hosting, reach-it-from-anywhere via
> Cloudflare Tunnel, and connecting the browser / phone / watch: see
> [SETUP.md](SETUP.md). The server also **serves the app itself at `/`**, so its
> URL doubles as the supervisor interface in any browser.

## Run it

Needs only [Node.js](https://nodejs.org) 16+ (no `npm install` required).

```bash
# pick a long random secret; every device pastes this same token
FACTORY_TOKEN=change-me-to-a-long-random-secret node server.js
```

On Windows PowerShell:

```powershell
$env:FACTORY_TOKEN = "change-me-to-a-long-random-secret"; node server.js
```

It listens on port **4000** by default and writes data to `stoptrack-data.json`
next to `server.js`.

Environment variables:

| Var | Default | Meaning |
|-----|---------|---------|
| `FACTORY_TOKEN` | *(empty)* | Shared secret. If empty the server runs **open** (no auth) and warns — only acceptable on a trusted, isolated LAN. |
| `PORT` | `4000` | Port to listen on. |
| `DATA_FILE` | `./stoptrack-data.json` | Where records are persisted. |
| `SMTP_HOST` | *(empty)* | SMTP server for handover emails. Unset ⇒ `/report` answers 501 and the app falls back to copy. |
| `SMTP_PORT` | `587` | SMTP port (465 switches to implicit TLS). |
| `SMTP_USER` / `SMTP_PASS` | *(empty)* | SMTP credentials (omit for an open relay on a trusted LAN). |
| `MAIL_FROM` | `SMTP_USER` | From-address on handover emails. |

**Email is opt-in**: it needs `npm install nodemailer` in this folder (listed as an
optional dependency) plus the `SMTP_*` env vars. Everything else runs without it.

## Point the app at it

On one phone, open StopTrack → **Supervisor → Settings → Server sync**:

1. **Server URL** — e.g. `http://<PC-IP>:4000` (the machine running this
   server, reachable from the phones).
2. **Factory token** — the same `FACTORY_TOKEN` value.
3. Tick **Enable background sync** and press **Save**. Use **Test connection** to
   confirm the server is reachable.

Repeat on each device. The first time sync is enabled, that device uploads its
existing history; after that only changes are exchanged.

## API

All routes require `Authorization: Bearer <FACTORY_TOKEN>` when a token is set.
Timestamps are epoch milliseconds. Conflicts resolve **last-write-wins** on each
record's `updatedAt` (falling back to `loggedAt`/`end`/`start` for old records).

| Method & path | Body | Response |
|---------------|------|----------|
| `GET /health` | — | `{ ok, serverTime }` |
| `POST /stops` | `{ stops: [record, …] }` | `{ ok, serverTime }` — upserts each record, keeping the newer of server/incoming. |
| `GET /stops?since=<ms>` | — | `{ stops: [record, …], serverTime }` — every record with `updatedAt > since`, **including** `discarded` records and `deleted` tombstones so those states propagate. |
| `GET /config` | — | `{ config, updatedAt }` — shared machines/reasons/quick-stops/shift/supervisor-PIN hash/rates/handover recipients. |
| `PUT /config` | `{ config, updatedAt }` | `{ ok, serverTime }` — replaces config if `updatedAt` is newer. |
| `POST /production` | `{ records: [record, …] }` | `{ ok, serverTime }` — upserts shift-output records (units/scrap, for OEE), LWW like `/stops`. |
| `GET /production?since=<ms>` | — | `{ records: [record, …], serverTime }` — production records changed since the cursor. |
| `POST /sessions` | `{ records: [record, …] }` | `{ ok, serverTime }` — upserts machine-session records (`{ id, operator, machine, start, end }`, operator presence spans), LWW like `/stops`. |
| `GET /sessions?since=<ms>` | — | `{ records: [record, …], serverTime }` — session records changed since the cursor. |
| `POST /report` | `{ to: [emails], subject, text }` | `{ ok, serverTime }` — emails a shift handover report. `501` when SMTP isn't configured. |

### Record shape

The server treats records opaquely (keyed by `id`) and never mutates them; it
only compares `updatedAt`. See the StopTrack data model for fields
(`id`, `machine`, `operator`, `start`, `end`, `duration`, `reason`, `notes`,
`manual`, `discarded`, `deleted`, `loggedAt`, `updatedAt`, …).

## Notes & hardening

- **Deletes** arrive as tombstones (`{ id, deleted: true, updatedAt, deletedAt }`),
  not as removals, so a delete on one device reaches the others. The client hides
  and eventually purges them; you may prune old tombstones here too if desired.
- Put this behind **HTTPS** (a reverse proxy such as Caddy/nginx) if it's exposed
  beyond a trusted LAN — the token is a bearer secret sent on every request.
- For higher volume, swap the JSON-file `load/persist` helpers in `server.js` for
  SQLite (e.g. `better-sqlite3`) or Postgres. The routing and contract stay the
  same.
