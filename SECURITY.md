# StopTrack — security posture

## Threat model
StopTrack is a **trusted factory-LAN** tool: operators' phones/watches and a
server on a factory PC, with an optional **HTTPS tunnel** for remote supervisor
access. It is not designed to be exposed raw to a hostile network. Within that
model, some behaviours are deliberate accepted tradeoffs (below).

## Audit findings — fixed (2026-07-30 review)

Fixed in CI and in this document (verifiable from this repo):

- **CI no longer hands the release signing key to unreviewed branches.**
  `.github/workflows/android.yml` builds `main`, `v*` tags, PRs *and* every
  `claude/**` agent branch. The "Configure signing key" step had no `if:`, so any
  branch push decoded the keystore to the runner's disk and put
  `STOPTRACK_STORE_PASSWORD` / `STOPTRACK_KEY_PASSWORD` into the environment of a
  Gradle build defined by that same unreviewed branch — a one-commit key
  exfiltration. The step is now gated to `main` and `v*` tags. Branch and PR
  builds still build; they just fall through to the debug key that the Gradle
  files already handle, and say so in the log and in the release banner.
- **`GITHUB_ENV` injection closed.** The step wrote `NAME=$VALUE`, so a secret
  containing a newline could define arbitrary variables for later steps. Each
  secret now uses the heredoc form with a per-run random delimiter.
- **Actions pinned to commit SHAs in the signing job.** `@v4` / `@v3` / `@v2` are
  tags the action's owner can repoint at new code; in the one job that holds the
  key, that is a supply-chain path straight to the keystore. All six actions in
  that job are now full SHAs with a `# v4.x.x` comment. The other workflows still
  use tags — they hold no secrets, so this was left as-is rather than churned.
- **The signing-key sentence below was wrong** and is corrected (the key is still
  in git history, not gone).

Fixed in the code changes shipping alongside this document — server, web app and
Android app. Not verifiable from this file, so re-check them in code before
trusting this list:

- **Rate-limit bypass via `X-Forwarded-For`** — see the rate-limiting entry below.
- **CSV formula injection** in the supervisor export.
- **Unauthenticated loopback bridge** on the phone — see the residual section.

## Fixed (first security review)
- **App signing key retired; releases use a different, private key.** The old key
  and its password were committed to a then-public repo, so anyone could sign an
  app as `com.stoptrack`. It was deleted from the tip — but **it is still
  recoverable from git history**: `git rev-list --all --objects` resolves
  `android/keystore/stoptrack-debug.jks` today. Rewriting history was judged not
  worth it (the key was public, so it is burned whether or not the objects are
  purged, and the repo is now private). That is exactly why it is **permanently
  retired and must never be reused** for signing anything. Releases are signed by
  a separate private key held only in CI secrets (see `android/SIGNING.md`).
- **Constant-time token check** (`server/server.js`): the bearer token is now
  compared with `crypto.timingSafeEqual` over SHA-256 digests, not `===`
  (which leaked it byte-by-byte via timing).
- **Prototype-pollution-safe store**: record ids are validated and collections
  are null-prototype objects, so a crafted `id` (`__proto__` etc.) can't corrupt
  the store.
- **Error responses sanitized**: internal details (paths, parse/SMTP errors) are
  logged server-side only; clients get generic messages.
- **HTTP hardening**: `X-Content-Type-Options: nosniff` and request/header/idle
  timeouts (basic slowloris mitigation).
- **Rate limiting** (`server/server.js`): per-IP fixed-window limits — a generous
  overall cap (`RATE_LIMIT`, default 240/min) plus a tight cap on *failed* auth
  (`RATE_LIMIT_AUTH`, default 20/min). Over the limit returns `429` with
  `Retry-After`. In-memory, per process.

  **Corrected 2026-07-30:** the earlier version of this note claimed the auth cap
  "throttles token guessing". It did not, on the deployment this project actually
  documents. `clientIp()` trusted `CF-Connecting-IP` / `X-Forwarded-For` from
  *any* caller, so on a LAN server — where nothing strips those headers — an
  attacker got a fresh 20-per-minute budget per forged header value and could
  guess the token as fast as the box would answer. Behind the Cloudflare tunnel
  the headers are overwritten by the tunnel and the cap held; on the LAN it was
  decoration. The fix makes trusting those headers an explicit opt-in
  (`TRUST_PROXY`), off by default, so the limiter keys on the socket address
  unless the operator says a proxy is in front. Set it **only** when there really
  is one — with `TRUST_PROXY` on and no proxy, the bypass is back.

  Still true either way: this is a per-process in-memory counter, so it slows a
  single guesser and does nothing about a distributed one, and it resets when the
  server restarts. The token's length is what actually protects it.

## Accepted tradeoffs (documented, safe under the trusted-LAN model)
- **Plain HTTP on the LAN** sends the bearer token in cleartext, so anyone
  sniffing the factory network could capture it. Mitigation: use the **HTTPS
  tunnel** (encrypted) for anything beyond a trusted, switched LAN; keep the
  token secret and rotate it (delete `stoptrack-token.txt`) if it leaks. Cannot
  be cleanly auto-scoped because the LAN server IP is arbitrary/user-entered.
- **`CORS: *`** on the sync API: acceptable because auth is an explicit bearer
  header (not cookies), so a third-party web page can't ride an existing session.
  That reasoning only holds where the token is actually required — it does **not**
  hold for the in-app loopback bridge, which accepts a blank one (see residual).
- **CI branch builds still run with `contents: write`.** GitHub scopes
  `permissions` per job, not per step, and the `build` job publishes releases — so
  a `claude/**` branch build gets a `GITHUB_TOKEN` that can write to the repo,
  even though it no longer gets the signing key. The clean fix is splitting build
  and publish into separate jobs; not done. Lower stakes than the key: a token
  push is revocable, visible in the log, and the token dies with the run, whereas
  a leaked signing key is forever.
- **Client-side "supervisor PIN"**: a UI deterrent, not an auth boundary (already
  noted in `CLAUDE.md`). Real access control is the factory token. Worth spelling
  out, because the failure **propagates** rather than staying on one device: the
  PIN hash is an ordinary field of the synced config (`StopTrack.tsx:2035`) and
  the server stores `/config` as opaque data with no check that a PIN change came
  from someone who knew the old PIN. `updatePin` verifies the old PIN in the
  browser only (`:2133`), which a direct `PUT /config` skips. So **any token
  holder can push a config that clears `supervisorPinHash`** — every device that
  pulls sets its PIN to null (`:2027`) and Settings falls open on all of them —
  **or replace it with a hash of their own**, locking the real supervisor out of
  Settings on every device at once. The PIN is protection against a curious
  operator holding the phone, and against nothing else.
- **Any token-holder is fully trusted**: the API has one shared token; a holder
  can read/write all data and overwrite config. That's the intended model for a
  single-factory deployment.
- **Publicly reachable when tunneled**: with the Cloudflare tunnel the endpoint is
  on the internet, gated only by the token (now rate-limited). To make it truly
  private without losing remote access, put **Cloudflare Access** (Zero Trust) in
  front of the tunnel so an identity check precedes the token — see
  `server/SETUP.md` Part B2. Recommended for tunnel deployments; not required on a
  LAN-only setup.

## Known residual hardening (deferred — revisit before any hostile-network use)
These are items on the **phone app**, only verifiable on real hardware; deferred
to avoid destabilizing the working app blind. The first is defense-in-depth and
genuinely low likelihood. The second is **not** — it is reachable from the open
internet and is being fixed this round, not deferred; it stays listed here until
someone confirms the fix on a device.
- **WebView loads `file://` with `allowUniversalAccessFromFileURLs = true`**
  (`android/mobile/.../MainActivity.kt`). Needed today so the bundled page can
  fetch its server cross-origin. Proper fix: serve the bundled app from the
  in-app loopback server (`http://127.0.0.1:<port>/`) so it's same-origin, then
  drop universal file access and set `mixedContentMode = NEVER`. No XSS sinks
  were found in the app (`React` escaping; no `dangerouslySetInnerHTML`), which
  limits the practical impact.
- **In-app loopback bridge is unauthenticated** (`LocalSyncServer`, bound to
  `127.0.0.1`). This entry used to say "another app on the *same phone*". The
  2026-07-30 audit found that understates it: responses carry
  `Access-Control-Allow-Origin: *` **and** `Access-Control-Allow-Private-Network:
  true` (`LocalSyncServer.kt:146,149`) — together, the pair that lets a page on
  the public internet reach a loopback server. So **any website the operator
  visits** in any browser on that phone can talk to the bridge: read the entire
  stop log and the supervisor config (`supervisorPinHash` included), and POST
  `{deleted:true}` tombstones that the phone forwards on to the real server, which
  is data destruction, not just disclosure. The one control that exists is a trap:
  `authOk` returns true when the token is blank, the `localToken` field is
  editable, but the bridge hard-codes `fun token(): String = ""`
  (`MainActivity.kt:217`) — so an owner who sets a token to close the hole gets
  401s and silently dead sync. Being fixed in this round: random local token
  actually returned by `token()`, drop the PNA header, narrow `Allow-Origin`.
  Only verifiable on real hardware, so confirm on a device before believing it.

## Not affected (checked)
- Web app: no `dangerouslySetInnerHTML` / `innerHTML` / `eval` → stored-XSS risk
  low (React escapes rendered config/notes).
- Gateway (`gateway/`): `yaml.safe_load`, no `eval`/`exec`/`subprocess`; not
  internet-facing.

## Reporting
This is a private project; raise security concerns directly with the maintainer.
