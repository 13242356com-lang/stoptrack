# StopTrack

Offline-first **machine-downtime tracker** for a solar-panel factory's ASLA
(Assemble & Laser) line. Operators log stops on their phone; a supervisor view
aggregates downtime, OEE, and exports. The whole app ships as one self-contained
`index.html`.

> Private project. See [`CLAUDE.md`](CLAUDE.md) for the full architecture, data
> model, and design constraints.

## Repository layout

| Path | What it is |
|------|-----------|
| `StopTrack.tsx` | **The editable source** (React + JSX). Edit this. |
| `index.html` | **The built app** — single self-contained file operators open. Generated from `StopTrack.tsx`; never hand-edited. |
| `build/` | The committed build: `build.mjs` + static scaffold (`head.html`, `icons.js`, `tail.html`). |
| `server/` | Optional sync backend (zero-dep Node) so devices share data. Runs on a LAN box or cloud, not part of the web app. |
| `gateway/` | Optional PLC gateway (Python) that auto-captures stops from a machine PLC. Simulator + S7 + OPC UA adapters. |

## Build

```bash
npm ci          # once — installs the pinned TypeScript
npm run build   # StopTrack.tsx -> index.html (+ dist/index.html)
```

`build/build.mjs` transpiles the JSX to plain `React.createElement`, wraps it in
the HTML shell, and runs gate checks (no leftover JSX, no raw `??`/`?.`). Output
is deterministic for the pinned TypeScript version, so `index.html` is byte-stable.

## How updates flow

1. Edit `StopTrack.tsx`.
2. `npm run build` (or let CI/Cloudflare build it).
3. Commit + push to `main`.
4. Cloudflare Pages rebuilds and redeploys the private URL automatically.

See [`DEPLOY.md`](DEPLOY.md) for the one-time Cloudflare Pages + Access setup.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) builds the app and runs the
gateway test suite on every push/PR — so a broken build or failing test is caught
before it deploys.

## Secrets

None live in the repo. The sync server's `FACTORY_TOKEN` and any SMTP credentials
are set as environment variables on the server host (see `server/README.md`), never
committed. Runtime data (`server/stoptrack-data.json`) is gitignored.
