# Deploying StopTrack privately (Cloudflare Pages + Access)

The operator app is a single `index.html`. This hosts it at a **private HTTPS URL**
that only people you allow can open, and redeploys automatically whenever you push
to `main`. Free tier is plenty for a factory.

Two halves: **hosting** (Cloudflare Pages builds & serves the app) and **access**
(Cloudflare Access gates who can load it). You do these once in the Cloudflare
dashboard — they need your Cloudflare login, so they can't be scripted here.

## 1. Host it — Cloudflare Pages

1. Sign in at <https://dash.cloudflare.com> → **Workers & Pages** → **Create** →
   **Pages** → **Connect to Git**. Authorize GitHub and pick the private
   `stoptrack` repo.
2. Build settings:
   - **Framework preset:** None.
   - **Build command:** `npm ci && npm run build`
   - **Build output directory:** `dist`
   - (Leave root directory as `/`.)
3. **Save and Deploy.** First build takes ~1 min. You get a URL like
   `https://stoptrack.pages.dev`. Confirm it loads the app over HTTPS.

Every push to `main` now triggers a fresh deploy. (Output dir `dist` means only
the app is served — `server/` and `gateway/` source are never exposed.)

## 2. Make it private — Cloudflare Access

By default a Pages URL is public. Gate it:

1. Dashboard → **Zero Trust** (set up the free plan if prompted; pick a team name
   like `your-factory`).
2. **Access → Applications → Add an application → Self-hosted.**
   - **Application name:** StopTrack
   - **Application domain:** your Pages hostname (e.g. `stoptrack.pages.dev`).
3. **Add a policy:**
   - **Policy name:** Operators
   - **Action:** Allow
   - **Include → Emails** (or **Emails ending in** your company domain): list the
     operator/supervisor addresses.
4. Save. Now opening the URL prompts for the email → Cloudflare sends a one-time
   PIN → only allowlisted people get in.

> Tip: on the phone, once past the login, use the browser's **Add to Home Screen**
> so operators get an app icon. HTTPS also makes the supervisor PIN's hashing use
> native Web Crypto.

## 3. Verify

- Open the Pages URL in a private window → you should hit the Access login, not the
  app, until you authenticate with an allowlisted email.
- Push a trivial change to `main` → a new deployment appears in the Pages dashboard
  and the live URL updates.

## What this does NOT deploy

The **sync server** (`server/`) and **PLC gateway** (`gateway/`) are separate
services that run on a machine you control (a shop-floor PC/Raspberry Pi, or a small
cloud VM) — not on Cloudflare Pages. The repo holds their source; deploying them is
a separate step. Set `FACTORY_TOKEN` (and SMTP vars, if emailing handovers) as
environment variables on that host — never in the repo.
