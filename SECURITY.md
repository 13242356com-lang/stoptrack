# StopTrack — security posture

## Threat model
StopTrack is a **trusted factory-LAN** tool: operators' phones/watches and a
server on a factory PC, with an optional **HTTPS tunnel** for remote supervisor
access. It is not designed to be exposed raw to a hostile network. Within that
model, some behaviours are deliberate accepted tradeoffs (below).

## Fixed (this review)
- **App signing key rotated off the public repo.** The old key + password were
  committed publicly (anyone could sign an app as `com.stoptrack`). Removed;
  releases are now signed by a **private key held in CI secrets**
  (see `android/SIGNING.md`). Treat the old key as compromised.
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
  (`RATE_LIMIT_AUTH`, default 20/min) that throttles token guessing. Over the
  limit returns `429` with `Retry-After`. In-memory (per process), IP from
  `CF-Connecting-IP`/`X-Forwarded-For` behind the tunnel.

## Accepted tradeoffs (documented, safe under the trusted-LAN model)
- **Plain HTTP on the LAN** sends the bearer token in cleartext, so anyone
  sniffing the factory network could capture it. Mitigation: use the **HTTPS
  tunnel** (encrypted) for anything beyond a trusted, switched LAN; keep the
  token secret and rotate it (delete `stoptrack-token.txt`) if it leaks. Cannot
  be cleanly auto-scoped because the LAN server IP is arbitrary/user-entered.
- **`CORS: *`** on the sync API: acceptable because auth is an explicit bearer
  header (not cookies), so a third-party web page can't ride an existing session.
- **Client-side "supervisor PIN"**: a UI deterrent, not an auth boundary (already
  noted in `CLAUDE.md`). Real access control is the factory token.
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
These are defense-in-depth items on the **phone app**, only verifiable on real
hardware; deferred to avoid destabilizing the working app blind. Low likelihood
under the trusted-LAN model.
- **WebView loads `file://` with `allowUniversalAccessFromFileURLs = true`**
  (`android/mobile/.../MainActivity.kt`). Needed today so the bundled page can
  fetch its server cross-origin. Proper fix: serve the bundled app from the
  in-app loopback server (`http://127.0.0.1:<port>/`) so it's same-origin, then
  drop universal file access and set `mixedContentMode = NEVER`. No XSS sinks
  were found in the app (`React` escaping; no `dangerouslySetInnerHTML`), which
  limits the practical impact.
- **In-app loopback bridge is unauthenticated** (`LocalSyncServer`, bound to
  `127.0.0.1`): another app on the *same phone* could read/write via loopback.
  Fix: require an auto-generated local token (already plumbed through
  `NativeBridge.token()`), so only the bundled page can use it.

## Not affected (checked)
- Web app: no `dangerouslySetInnerHTML` / `innerHTML` / `eval` → stored-XSS risk
  low (React escapes rendered config/notes).
- Gateway (`gateway/`): `yaml.safe_load`, no `eval`/`exec`/`subprocess`; not
  internet-facing.

## Reporting
This is a private project; raise security concerns directly with the maintainer.
