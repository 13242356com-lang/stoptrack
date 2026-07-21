/* ============================================================================
   StopTrack sync server — reference implementation
   ----------------------------------------------------------------------------
   A tiny, self-hostable backend so every phone running StopTrack shares one
   data set. Zero npm dependencies on purpose: it runs with just Node (no build
   step, no native modules), which suits a factory PC or a Raspberry Pi on the
   shop-floor LAN. Persistence is a JSON file next to this script; swap the
   load/save helpers for SQLite/Postgres if you outgrow it.

   Matches the contract the StopTrack client (`api.remote*`) codes against:
     GET  /health                 -> { ok, serverTime }
     POST /stops   { stops:[...] } -> { ok, serverTime }         (upsert, LWW)
     GET  /stops?since=<ms>        -> { stops:[...], serverTime } (incl. tombstones)
     GET  /config                 -> { config, updatedAt }
     PUT  /config  { config, updatedAt } -> { ok, serverTime }   (LWW)

   Auth: every request must send `Authorization: Bearer <FACTORY_TOKEN>`.
   Run:  FACTORY_TOKEN=your-secret node server.js
   ==========================================================================*/
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 4000;

// Public https address (from a Cloudflare Tunnel / reverse proxy). Optional —
// set it once you've done SETUP.md Part B so startup prints the anywhere-URL.
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/$/, "");

// --- console logging --------------------------------------------------------
// You run this from the .bat and watch the window, so log activity there.
// Meaningful events are always logged; set LOG_VERBOSE=1 to also log every
// poll (noisy — devices poll every ~15s). ASCII only so Windows cmd shows it.
const VERBOSE = /^(1|true|yes|on)$/i.test(process.env.LOG_VERBOSE || "");
function stamp() { return new Date().toTimeString().slice(0, 8); } // HH:MM:SS
function log(msg) { console.log(`[${stamp()}] ${msg}`); }
function clientIp(req) {
  const raw = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "?";
  return String(raw).split(",")[0].trim().replace(/^::ffff:/, "");
}

// --- storage unit -----------------------------------------------------------
// Everything the server keeps — the data file AND the auth token — lives in ONE
// folder, the "storage unit", so it's easy to find and back up. Defaults to a
// `data/` folder next to server.js; override with DATA_DIR. (DATA_FILE /
// TOKEN_FILE can still point individual files elsewhere if you need.)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
catch (e) { console.error("Could not create storage folder:", DATA_DIR, "-", e.message); }

const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, "stoptrack-data.json");
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(DATA_DIR, "stoptrack-token.txt");

// One-time migration: older versions kept these next to server.js. Move them
// into the storage folder so upgrades don't lose data or change the token.
for (const [legacy, target] of [
  [path.join(__dirname, "stoptrack-data.json"), DATA_FILE],
  [path.join(__dirname, "stoptrack-token.txt"), TOKEN_FILE],
]) {
  try {
    if (legacy !== target && fs.existsSync(legacy) && !fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(legacy, target);
      console.log(`Moved existing ${path.basename(legacy)} into storage folder.`);
    }
  } catch { /* keep legacy file where it is if the move fails */ }
}

// --- auth token (auto-generated) --------------------------------------------
// No manual step: this server mints its OWN unique token the first time it runs
// and remembers it in the storage folder, so it's stable across restarts and
// every device keeps working. Override with FACTORY_TOKEN if you prefer to pick
// your own. The token is printed at startup so you can copy it to devices.
function resolveToken() {
  if (process.env.FACTORY_TOKEN) return process.env.FACTORY_TOKEN.trim();
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const saved = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      if (saved) return saved;
    }
  } catch { /* fall through to generate */ }
  const fresh = crypto.randomBytes(18).toString("base64url"); // 24-char url-safe secret
  try { fs.writeFileSync(TOKEN_FILE, fresh, { mode: 0o600 }); }
  catch (e) { console.error("Could not save token file (using in-memory token):", e.message); }
  return fresh;
}
const TOKEN = resolveToken();

// The StopTrack web app to serve at "/" so a supervisor can open this server's
// URL in any browser (phone included) and get the full app — no separate
// supervisor UI to maintain. Resolution order: APP_HTML env override, the repo
// layout (../index.html), or a copy placed next to this script. If none exist
// the server still runs; "/" just explains where to put the file.
const APP_HTML = process.env.APP_HTML
  || [path.join(__dirname, "..", "index.html"), path.join(__dirname, "index.html")]
    .find((p) => { try { return fs.existsSync(p); } catch { return false; } })
  || "";

// --- persistence (single JSON file) ----------------------------------------
// Shape: { stops: { [id]: record }, production: { [id]: record }, sessions: { [id]: record }, config: { config, updatedAt } }
// Collections use null-prototype objects and record ids are validated, so a
// record whose id is "__proto__"/"constructor"/"prototype" can't pollute or
// corrupt the store.
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
const safeId = (id) => typeof id === "string" && id.length > 0 && id.length <= 512 && !RESERVED_IDS.has(id);
function emptyCollections() {
  return { stops: Object.create(null), production: Object.create(null), sessions: Object.create(null), config: { config: null, updatedAt: 0 } };
}
let db = emptyCollections();
try {
  if (fs.existsSync(DATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    db = emptyCollections();
    for (const coll of ["stops", "production", "sessions"]) {
      const src = parsed && parsed[coll];
      if (src && typeof src === "object") {
        for (const id of Object.keys(src)) if (safeId(id)) db[coll][id] = src[id];
      }
    }
    if (parsed && parsed.config) db.config = parsed.config;
  }
} catch (e) { console.error("Could not read data file, starting empty:", e.message); }

let saveTimer = null;
function persist() {
  // Debounce writes so a burst of upserts hits disk once.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DATA_FILE + ".tmp";
    try { fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DATA_FILE); }
    catch (e) { console.error("Save failed:", e.message); }
  }, 150);
}

// The record's last-write clock — mirrors the client's stampOf().
const stampOf = (s) => (s && (s.updatedAt != null ? s.updatedAt
  : s.loggedAt != null ? s.loggedAt
  : s.end != null ? s.end
  : s.start != null ? s.start : 0)) || 0;

// --- email (optional) --------------------------------------------------------
// Shift-handover email via nodemailer, loaded lazily so the server keeps zero
// hard dependencies: without SMTP env vars (or without `npm install nodemailer`),
// /report answers 501 and everything else works as before.
const SMTP = {
  host: process.env.SMTP_HOST || "",
  port: Number(process.env.SMTP_PORT) || 587,
  user: process.env.SMTP_USER || "",
  pass: process.env.SMTP_PASS || "",
  from: process.env.MAIL_FROM || process.env.SMTP_USER || "stoptrack@localhost",
};
let mailer = null; // lazy nodemailer transport
function getMailer() {
  if (!SMTP.host) return { error: "Email not configured" };
  if (mailer) return { transport: mailer };
  try {
    const nodemailer = require("nodemailer");
    mailer = nodemailer.createTransport({
      host: SMTP.host, port: SMTP.port, secure: SMTP.port === 465,
      auth: SMTP.user ? { user: SMTP.user, pass: SMTP.pass } : undefined,
    });
    return { transport: mailer };
  } catch {
    return { error: "nodemailer is not installed — run `npm install nodemailer` in server/" };
  }
}

// --- helpers ----------------------------------------------------------------
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  });
  res.end(body);
}

// Constant-time bearer-token check. Comparing the raw strings with === leaks the
// token byte-by-byte via timing; hash both to a fixed 32 bytes and compare with
// timingSafeEqual (also sidesteps its throw-on-unequal-length).
function authOk(req) {
  if (!TOKEN) return true; // open mode (warned at startup)
  const provided = crypto.createHash("sha256").update(req.headers["authorization"] || "").digest();
  const expected = crypto.createHash("sha256").update(`Bearer ${TOKEN}`).digest();
  return crypto.timingSafeEqual(provided, expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5e7) req.destroy(); }); // ~50MB guard
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// --- rate limiting (in-memory, per client IP) -------------------------------
// A tiny fixed-window limiter so one client can't flood the server or brute-
// force the token. Two windows per IP: a generous OVERALL cap (normal multi-
// device polling — ~4 req/15s per device — stays far under it) and a tight cap
// on FAILED auth (slows token guessing; complements the constant-time check).
// In-memory only: fine for a single-process factory server, and a restart just
// clears it. Tune via env; RATE_LIMIT=0 disables the overall cap.
//
// Note: the client IP comes from CF-Connecting-IP / X-Forwarded-For when set
// (see clientIp). Behind the Cloudflare tunnel that's the real per-device IP and
// can't be spoofed by the client; don't put this raw behind an upstream that
// forwards a client-controlled XFF (SETUP.md already says tunnel-only).
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = Number(process.env.RATE_LIMIT ?? 240);          // requests / min / IP (0 = off)
const RL_AUTH_MAX = Number(process.env.RATE_LIMIT_AUTH ?? 20); // failed auths / min / IP (0 = off)
const RL_MAX_IPS = 50000;                                      // hard cap on tracked IPs (memory bound)
const rlHits = new Map(); // ip -> { count, resetAt }
const rlAuth = new Map(); // ip -> { count, resetAt }

// Count one hit for `ip` in `map`; return whether it's now over `max`.
function rateBump(map, ip, max) {
  if (!max || max <= 0) return { limited: false, retryAfter: 0 };
  const now = Date.now();
  let e = map.get(ip);
  if (!e || now >= e.resetAt) {
    if (map.size >= RL_MAX_IPS) map.clear(); // crude flood-of-unique-IPs guard
    e = { count: 0, resetAt: now + RL_WINDOW_MS };
    map.set(ip, e);
  }
  e.count++;
  return e.count > max ? { limited: true, retryAfter: Math.ceil((e.resetAt - now) / 1000) } : { limited: false, retryAfter: 0 };
}

// Drop stale buckets periodically so the maps don't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const map of [rlHits, rlAuth]) for (const [ip, e] of map) if (now >= e.resetAt) map.delete(ip);
}, 5 * 60 * 1000).unref();

function tooMany(res, retryAfter) {
  res.writeHead(429, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    "Retry-After": String(Math.max(1, retryAfter)),
  });
  res.end(JSON.stringify({ ok: false, error: "Too many requests" }));
}

// Handle a failed-auth response: throttle repeat offenders, else a plain 401.
function denyAuth(res, ip, method, route) {
  log(`unauthorized ${method} ${route} - ${ip} (wrong/missing token)`);
  const rl = rateBump(rlAuth, ip, RL_AUTH_MAX);
  return rl.limited ? tooMany(res, rl.retryAfter) : send(res, 401, { ok: false, error: "Unauthorized" });
}

// --- request routing --------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") return send(res, 204, {});

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = url.pathname.replace(/\/$/, "") || "/";
  const now = Date.now();
  const ip = clientIp(req);
  if (VERBOSE) log(`${req.method} ${route} - ${ip}`);

  // Overall flood protection (per IP). OPTIONS preflights already returned above.
  {
    const rl = rateBump(rlHits, ip, RL_MAX);
    if (rl.limited) {
      if (VERBOSE) log(`rate-limited ${ip} (${req.method} ${route})`);
      return tooMany(res, rl.retryAfter);
    }
  }

  // Serve the StopTrack app itself at "/" — the supervisor interface. The page
  // is public (same code as the deployed web app); all DATA stays behind the
  // bearer token, which the supervisor enters once in Supervisor → Server sync.
  if ((route === "/" || route === "/index.html") && req.method === "GET") {
    if (APP_HTML) {
      try {
        const html = fs.readFileSync(APP_HTML);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" });
        log(`supervisor page opened - ${ip}`);
        return res.end(html);
      } catch (e) {
        console.error("Could not read app file:", e.message);
        return send(res, 500, { ok: false, error: "Server error" });
      }
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
    return res.end(
      "StopTrack sync server is running.\n\n" +
      "To serve the app here too, put the built index.html next to server.js\n" +
      "(or set APP_HTML=/path/to/index.html) and restart.\n",
    );
  }

  // /health is open so a device can test connectivity before it has the token
  // pasted in. It still requires the token when one is configured.
  if (route === "/health" && req.method === "GET") {
    if (!authOk(req)) return denyAuth(res, ip, req.method, route);
    return send(res, 200, { ok: true, serverTime: now });
  }

  if (!authOk(req)) return denyAuth(res, ip, req.method, route);

  try {
    if (route === "/stops" && req.method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const stops = Object.values(db.stops).filter((s) => stampOf(s) > since);
      return send(res, 200, { stops, serverTime: now });
    }

    if (route === "/stops" && req.method === "POST") {
      const body = await readBody(req);
      const incoming = Array.isArray(body.stops) ? body.stops : [];
      let saved = 0;
      for (const r of incoming) {
        if (!r || !safeId(r.id)) continue;
        const cur = db.stops[r.id];
        // Last-write-wins: keep whichever record was mutated more recently.
        if (!cur || stampOf(r) >= stampOf(cur)) { db.stops[r.id] = r; saved++; }
      }
      persist();
      if (saved > 0) log(`saved ${saved} stop(s) from ${ip}`);
      return send(res, 200, { ok: true, serverTime: now });
    }

    // Production records (units/scrap per shift, for OEE) — same contract as /stops.
    if (route === "/production" && req.method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const records = Object.values(db.production).filter((r) => stampOf(r) > since);
      return send(res, 200, { records, serverTime: now });
    }

    if (route === "/production" && req.method === "POST") {
      const body = await readBody(req);
      const incoming = Array.isArray(body.records) ? body.records : [];
      let saved = 0;
      for (const r of incoming) {
        if (!r || !safeId(r.id)) continue;
        const cur = db.production[r.id];
        if (!cur || stampOf(r) >= stampOf(cur)) { db.production[r.id] = r; saved++; }
      }
      persist();
      if (saved > 0) log(`saved ${saved} production record(s) from ${ip}`);
      return send(res, 200, { ok: true, serverTime: now });
    }

    // Machine sessions (operator presence spans) — same contract as /stops.
    if (route === "/sessions" && req.method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const records = Object.values(db.sessions).filter((r) => stampOf(r) > since);
      return send(res, 200, { records, serverTime: now });
    }

    if (route === "/sessions" && req.method === "POST") {
      const body = await readBody(req);
      const incoming = Array.isArray(body.records) ? body.records : [];
      let saved = 0;
      for (const r of incoming) {
        if (!r || !safeId(r.id)) continue;
        const cur = db.sessions[r.id];
        if (!cur || stampOf(r) >= stampOf(cur)) { db.sessions[r.id] = r; saved++; }
      }
      persist();
      if (saved > 0 && VERBOSE) log(`saved ${saved} session record(s) from ${ip}`);
      return send(res, 200, { ok: true, serverTime: now });
    }

    if (route === "/config" && req.method === "GET") {
      return send(res, 200, { config: db.config.config, updatedAt: db.config.updatedAt || 0 });
    }

    if (route === "/config" && req.method === "PUT") {
      const body = await readBody(req);
      const incomingAt = Number(body.updatedAt) || (body.config && Number(body.config.updatedAt)) || 0;
      if (incomingAt >= (db.config.updatedAt || 0)) {
        db.config = { config: body.config || null, updatedAt: incomingAt };
        persist();
        log(`settings updated (machines/reasons/quick-stops) by ${ip}`);
      }
      return send(res, 200, { ok: true, serverTime: now });
    }

    // Shift handover email: { to: [addresses], subject, text }. 501 when SMTP
    // isn't set up so the app can fall back to copy-to-clipboard gracefully.
    if (route === "/report" && req.method === "POST") {
      const body = await readBody(req);
      const to = (Array.isArray(body.to) ? body.to : [body.to]).filter((e) => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      if (!to.length) return send(res, 400, { ok: false, error: "No valid recipients" });
      if (!body.text) return send(res, 400, { ok: false, error: "Empty report" });
      const m = getMailer();
      if (!m.transport) return send(res, 501, { ok: false, error: m.error });
      try {
        await m.transport.sendMail({
          from: SMTP.from, to: to.join(", "),
          subject: String(body.subject || "StopTrack shift handover").slice(0, 200),
          text: String(body.text).slice(0, 20000),
        });
        return send(res, 200, { ok: true, serverTime: now });
      } catch (e) {
        console.error("Mail send failed:", e.message);
        return send(res, 502, { ok: false, error: "Mail send failed" });
      }
    }

    return send(res, 404, { ok: false, error: "Not found" });
  } catch (e) {
    // Don't echo internals (parse errors, paths) back to the client.
    console.error(`request error on ${route}:`, e.message);
    return send(res, 400, { ok: false, error: "Bad request" });
  }
});

// Connectable addresses for humans. 0.0.0.0 is the BIND address (all
// interfaces) — you can't open it in a browser; use localhost or a LAN IP.
function lanIPv4s() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// Timeouts so a slow/half-open client can't tie up a connection indefinitely
// (basic slowloris hardening). Node defaults are minutes; tighten them.
server.headersTimeout = 15000;   // must finish sending headers within 15s
server.requestTimeout = 30000;   // whole request within 30s
server.setTimeout(60000);        // idle socket cap

server.listen(PORT, () => {
  const line = "=".repeat(64);
  console.log("");
  console.log(line);
  console.log("  StopTrack server is READY — set up each device with:");
  console.log("");
  if (PUBLIC_URL) {
    console.log(`   Address (anywhere): ${PUBLIC_URL}`);
  }
  console.log(`   Address (this PC):  http://localhost:${PORT}`);
  for (const ip of lanIPv4s()) {
    console.log(`   Address (Wi-Fi):    http://${ip}:${PORT}`);
  }
  console.log("");
  console.log(`   Auth token:         ${TOKEN}`);
  console.log("");
  console.log("  Enter the address + token on each phone, watch, and browser.");
  if (!PUBLIC_URL) {
    console.log("  For an https address that works ANYWHERE, set up a tunnel");
    console.log("  (SETUP.md Part B), then set PUBLIC_URL and restart.");
  }
  console.log(`  (Don't use http://0.0.0.0:${PORT} — that address won't connect.)`);
  console.log(line);
  console.log("");
  console.log(`Storage:  ${DATA_DIR}   (all data + token live here — back this folder up)`);
  console.log(`Loaded:   ${Object.keys(db.stops).length} stops, ${Object.keys(db.production).length} production, ${Object.keys(db.sessions).length} sessions`);
  console.log(APP_HTML ? `App page: served at "/" from ${APP_HTML}` : `App page: NOT served — no index.html found next to server.js.`);
  console.log(VERBOSE ? "Logging:  verbose (every request)." : "Logging:  activity only (set LOG_VERBOSE=1 for every request).");
  console.log("");
  log("waiting for devices…");
});
