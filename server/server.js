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

// Only believe a forwarded-IP header when we really are behind a proxy that sets
// one — the Cloudflare tunnel from SETUP.md Part B (set TRUST_PROXY=1 there).
// Trusting it unconditionally let ANY client name its own IP, and since both rate
// limiters key on this value that was a free bypass: 40 wrong tokens from one
// machine were throttled after 20, but the same 40 with a rotating
// X-Forwarded-For were throttled zero times — the token was brute-forceable at
// full speed. A socket address can't be forged that way, so it is the default.
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || "");
function clientIp(req) {
  const socketIp = (req.socket && req.socket.remoteAddress) || "?";
  const raw = (TRUST_PROXY && (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"])) || socketIp;
  return String(raw).split(",")[0].trim().replace(/^::ffff:/, "");
}

// Last-resort crash net. A downtime tracker that stops answering is worse than
// one that answers an error: while it's down the stops go nowhere and those
// minutes are lost for good. One unauthenticated packet used to be enough — a
// `Host: [` header made `new URL` throw inside the async request handler, which
// Node saw as an unhandled rejection and killed the process for. That hole is
// closed where it happens (see the routing section); this net is so the NEXT one
// doesn't take the server down with it. Nothing is hidden: the stack still goes
// to the window you're watching, and the .bat restarts it if it does die anyway.
process.on("uncaughtException", (e) => {
  console.error(`[${stamp()}] UNCAUGHT ERROR - server kept running:`, (e && e.stack) || e);
});
process.on("unhandledRejection", (e) => {
  console.error(`[${stamp()}] UNHANDLED REJECTION - server kept running:`, (e && e.stack) || e);
});

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

// That page, held in memory. It's ~245 KB and "/" is the one route with no token
// in front of it, so a synchronous readFileSync PER REQUEST let anyone who could
// reach the port keep the single-threaded event loop busy re-reading it — and
// every device's sync waits in that same queue. Read the bytes once; a cheap stat
// still notices a freshly-built index.html being dropped in, so you don't have to
// restart the server after a rebuild.
let appCache = null; // { buf, mtimeMs, size }
function appHtml() {
  if (!APP_HTML) return null;
  const st = fs.statSync(APP_HTML);
  if (!appCache || appCache.mtimeMs !== st.mtimeMs || appCache.size !== st.size) {
    appCache = { buf: fs.readFileSync(APP_HTML), mtimeMs: st.mtimeMs, size: st.size };
  }
  return appCache.buf;
}

// --- persistence (single JSON file) ----------------------------------------
// Shape: { stops, production, sessions, handovers: { [id]: record }, config: { config, updatedAt } }
// Collections use null-prototype objects and record ids are validated, so a
// record whose id is "__proto__"/"constructor"/"prototype" can't pollute or
// corrupt the store.
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
const safeId = (id) => typeof id === "string" && id.length > 0 && id.length <= 512 && !RESERVED_IDS.has(id);
function emptyCollections() {
  return { stops: Object.create(null), production: Object.create(null), sessions: Object.create(null), handovers: Object.create(null), config: { config: null, updatedAt: 0 } };
}
// The record's last-write clock — mirrors the client's stampOf().
const rawStampOf = (s) => (s && (s.updatedAt != null ? s.updatedAt
  : s.loggedAt != null ? s.loggedAt
  : s.end != null ? s.end
  : s.start != null ? s.start : 0)) || 0;

// How far ahead of the server's clock an incoming stamp may sit before we stop
// believing it. Devices on a factory floor often have no SIM and no NTP, and a
// single phone whose clock reads a year ahead used to poison the shared data
// permanently: its config write out-ranked every later edit, so the supervisor's
// changes were accepted and then silently reverted, and a future-stamped stop
// resurrected itself after being discarded. Clamping only the FUTURE side keeps a
// device that has merely been offline (its stamps are in the past) able to win.
// Only used to decide when to WARN about a device's clock; the stored stamp is
// clamped to the server's own clock, because keeping any future value would give
// the skewed device a dead zone in which later, honest writes still lose.
const CLOCK_SKEW_GRACE_MS = 5 * 60 * 1000;
const clampStamp = (stamp, now) => Math.min(Number(stamp) || 0, now);
const stampOf = (s, now = Date.now()) => clampStamp(rawStampOf(s), now);

// Store the record with an honest stamp. Keeping a future value would let it slide
// forward forever (re-clamping at read time always yields "now", so it ties or beats
// every later write); writing the clamped stamp back pins it once. No-op for a
// record whose clock is sane, since clampStamp only lowers a future value.
const normalizeStamp = (r, now) => {
  const raw = rawStampOf(r);
  const clamped = clampStamp(raw, now);
  return clamped === raw && r.updatedAt != null ? r : { ...r, updatedAt: clamped };
};

let db = emptyCollections();
let repaired = 0;
const bootNow = Date.now();
try {
  if (fs.existsSync(DATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    db = emptyCollections();
    for (const coll of ["stops", "production", "sessions", "handovers"]) {
      const src = parsed && parsed[coll];
      if (src && typeof src === "object") {
        for (const id of Object.keys(src)) {
          if (!safeId(id)) continue;
          const before = rawStampOf(src[id]);
          const rec = normalizeStamp(src[id], bootNow);
          if (rawStampOf(rec) !== before) repaired++;
          db[coll][id] = rec;
        }
      }
    }
    if (parsed && parsed.config) {
      db.config = parsed.config;
      // A future-stamped config from before the clamp would reject every later
      // supervisor edit forever; pull it back to the boot clock too.
      const cfgAt = Number(db.config.updatedAt) || 0;
      if (cfgAt > bootNow) { db.config.updatedAt = bootNow; repaired++; }
    }
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

// --- how much a client may hand us ------------------------------------------
// The whole store sits in memory and the whole file is rewritten on every change,
// so "how big can this get" needs an answer. It had none: one POST inserted
// 200,000 records (15 MB), every later save then rewrote all of it, and a single
// `GET /stops?since=0` serialised the lot into one response.
// Sized for a real factory with room to spare — dozens of devices, a few thousand
// stops a month, and a first sync that pushes a device's whole local history in
// one go — while staying far below what it takes to hurt the server. All three
// are env-tunable for the rare site that genuinely outgrows them; at that point
// the JSON file is the part to replace (see the header comment).
const MAX_BATCH = Number(process.env.SYNC_MAX_BATCH ?? 5000);       // records per POST
const MAX_RECORDS = Number(process.env.SYNC_MAX_RECORDS ?? 100000); // records kept per collection
const MAX_PAGE = Number(process.env.SYNC_MAX_PAGE ?? 5000);         // records per GET response

// One page of a collection, oldest change first, plus the cursor to ask from
// next time. When the page is full that cursor is the LAST RECORD'S stamp rather
// than "now": both clients store whatever `serverTime` we send and poll again
// ~15-25 s later, so a client that knows nothing about paging still converges on
// the full set instead of skipping everything past the cut. `more` lets a client
// that does know pull the rest straight away.
function readPage(coll, since, now) {
  const all = Object.values(coll)
    .filter((r) => stampOf(r, now) > since)
    .sort((a, b) => stampOf(a, now) - stampOf(b, now));
  if (all.length <= MAX_PAGE) return { records: all, serverTime: now, more: false };
  // Never split records sharing one stamp across two pages: the cursor is a
  // strict `>`, so whatever was left behind would never be asked for again.
  let end = MAX_PAGE;
  const edge = stampOf(all[end - 1], now);
  while (end < all.length && stampOf(all[end], now) === edge) end++;
  return { records: all.slice(0, end), serverTime: edge, more: end < all.length };
}

// Merge an incoming batch into a collection (last-write-wins on the CLAMPED
// stamp, so a device with a wrong clock can't out-rank every future write).
// Shared by all four record routes so the id validation, the clock clamp and the
// size cap can't drift apart between them.
function upsertBatch(coll, incoming, now) {
  let saved = 0, skewed = 0, rejected = 0;
  let count = Object.keys(coll).length; // counted once: re-counting per record is O(n^2)
  for (const r of incoming) {
    if (!r || !safeId(r.id)) continue;
    const cur = coll[r.id];
    // A full store still takes UPDATES to records it already holds — otherwise
    // reaching the cap would also freeze every discard, note and correction.
    if (!cur && count >= MAX_RECORDS) { rejected++; continue; }
    if (rawStampOf(r) > now + CLOCK_SKEW_GRACE_MS) skewed++;
    if (!cur || stampOf(r, now) >= stampOf(cur, now)) {
      coll[r.id] = normalizeStamp(r, now);
      saved++;
      if (!cur) count++;
    }
  }
  return { saved, skewed, rejected };
}

// --- email (optional) --------------------------------------------------------
// Shift-handover email via nodemailer, loaded lazily so the server keeps zero
// hard dependencies: without SMTP env vars (or without `npm install nodemailer`),
// /report answers 501 and everything else works as before.
//
// A handover card goes to the shift's supervisors, not to a mailing list — see
// the cap's use in /report for why an uncapped list is a problem.
const MAX_RECIPIENTS = Number(process.env.MAIL_MAX_RECIPIENTS ?? 20);
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
  if (!TOKEN) return true; // open mode — the startup banner shouts about this
  const provided = crypto.createHash("sha256").update(req.headers["authorization"] || "").digest();
  const expected = crypto.createHash("sha256").update(`Bearer ${TOKEN}`).digest();
  return crypto.timingSafeEqual(provided, expected);
}

// Biggest body we'll take. The largest legitimate request is a first sync
// pushing a device's whole local history — MAX_BATCH records at a few hundred
// bytes each, comfortably under 2 MB — so 4 MB is generous. The old guard was
// 50 MB, roughly 200x anything this app sends, which made one request an easy
// way to have the server chew through memory.
const MAX_BODY_BYTES = Number(process.env.SYNC_MAX_BODY_BYTES ?? 4 * 1024 * 1024);

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Keep the chunks as Buffers and join ONCE. `data += chunk` stringified each
    // chunk on its own, which splits any multi-byte UTF-8 character that lands on
    // a chunk boundary into two replacement characters — a real corruption for
    // accented machine and operator names in a big batch, and one that only shows
    // up on batches large enough to be split, i.e. exactly the ones nobody tests.
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    req.on("data", (c) => {
      if (settled) return;
      // Count BYTES, and count them BEFORE appending: the old check measured
      // characters of a string that had already been grown, so the cap was both
      // the wrong unit and applied one chunk too late.
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        const err = new Error("Request body too large");
        err.tooLarge = true;
        fail(err);
        // Pause rather than destroy: destroying settles neither 'end' nor
        // 'error', so the old code's promise simply never resolved — the request
        // handler awaited forever and the client got no answer at all. Pausing
        // stops us buffering while still leaving the socket able to carry the 413,
        // and requestTimeout caps how long it can linger.
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try { const s = Buffer.concat(chunks).toString("utf8"); resolve(s ? JSON.parse(s) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", fail);
    // A client that hangs up mid-body emits neither 'end' nor always 'error', so
    // without this the promise (and the handler awaiting it) leaked for good.
    req.on("close", () => fail(new Error("Request aborted")));
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
// Note: the client IP comes from CF-Connecting-IP / X-Forwarded-For ONLY when
// TRUST_PROXY is set (see clientIp), otherwise from the socket. Behind the
// Cloudflare tunnel the forwarded value is the real per-device IP; anywhere else
// it's whatever the caller typed, which would make these limits opt-out.
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = Number(process.env.RATE_LIMIT ?? 240);          // requests / min / IP (0 = off)
const RL_AUTH_MAX = Number(process.env.RATE_LIMIT_AUTH ?? 20); // failed auths / min / IP (0 = off)
const RL_MAX_IPS = Number(process.env.RATE_LIMIT_MAX_IPS ?? 50000); // hard cap on tracked IPs (memory bound)
const rlHits = new Map(); // ip -> { count, resetAt }
const rlAuth = new Map(); // ip -> { count, resetAt }

// Count one hit for `ip` in `map`; return whether it's now over `max`.
// Map iteration follows insertion order, and every bump re-inserts, so the front
// of the map is the least recently seen IP — which is what makes evicting from
// the front safe for the devices actually talking to us.
function rateBump(map, ip, max) {
  if (!max || max <= 0) return { limited: false, retryAfter: 0 };
  const now = Date.now();
  let e = map.get(ip);
  if (e && now < e.resetAt) map.delete(ip);  // re-added below, at the back
  else e = { count: 0, resetAt: now + RL_WINDOW_MS };
  if (map.size >= RL_MAX_IPS) {
    // Evict the oldest slice, never the whole map. `map.clear()` made the memory
    // bound itself a bypass: a flood of unique IPs wiped every honest client's
    // bucket AND every failed-auth count along with the attacker's, so anyone
    // could reset the limiter on demand and carry on guessing. Dropping the
    // least-recently-seen tenth costs an attacker ten times the addresses and
    // leaves the devices that are mid-conversation with us untouched.
    let drop = Math.max(1, Math.ceil(RL_MAX_IPS / 10));
    for (const key of map.keys()) { map.delete(key); if (--drop <= 0) break; }
  }
  e.count++;
  map.set(ip, e);
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

// Refusals that a device has to be able to act on. Say the number and say the
// way out: a sync that fails quietly is one the operator discovers at the end of
// the shift, with the stops still sitting on the phone.
function batchTooBig(res, n) {
  return send(res, 413, { ok: false, error: `Too many records in one request (${n}; max ${MAX_BATCH}). Send them in smaller batches, or raise SYNC_MAX_BATCH on the server.` });
}
function storeFull(res, what, rejected, applied, now) {
  log(`WARNING: the store is FULL at ${MAX_RECORDS} ${what} — refused ${rejected} new record(s)`);
  return send(res, 507, { ok: false, applied, rejected, serverTime: now,
    error: `The server already holds its maximum of ${MAX_RECORDS} ${what}. Archive the data file (or raise SYNC_MAX_RECORDS) — updates to existing records still work.` });
}

// Handle a failed-auth response: throttle repeat offenders, else a plain 401.
function denyAuth(res, ip, method, route) {
  log(`unauthorized ${method} ${route} - ${ip} (wrong/missing token)`);
  const rl = rateBump(rlAuth, ip, RL_AUTH_MAX);
  return rl.limited ? tooMany(res, rl.retryAfter) : send(res, 401, { ok: false, error: "Unauthorized" });
}

// --- request routing --------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const now = Date.now();
  const ip = clientIp(req);

  // Overall flood protection (per IP), FIRST — before parsing, before routing,
  // before the preflight shortcut. Everything below this line costs the server
  // work, so all of it has to be throttleable. OPTIONS used to be answered above
  // the limiter, which made preflights a free unlimited request.
  {
    const rl = rateBump(rlHits, ip, RL_MAX);
    if (rl.limited) {
      if (VERBOSE) log(`rate-limited ${ip} (${req.method} ${req.url})`);
      return tooMany(res, rl.retryAfter);
    }
  }

  // CORS preflight
  if (req.method === "OPTIONS") return send(res, 204, {});

  // A client can send a Host header that isn't a valid authority (`Host: [` is
  // enough) and `new URL` THROWS on it. This line sat outside the try/catch
  // below, inside an async handler, so the rejection was unhandled and Node
  // killed the process: one unauthenticated packet stopped the whole factory's
  // downtime tracker. Answer 400 and stay up.
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch { return send(res, 400, { ok: false, error: "Bad request" }); }
  const route = url.pathname.replace(/\/$/, "") || "/";
  if (VERBOSE) log(`${req.method} ${route} - ${ip}`);

  // Serve the StopTrack app itself at "/" — the supervisor interface. The page
  // is public (same code as the deployed web app); all DATA stays behind the
  // bearer token, which the supervisor enters once in Supervisor → Server sync.
  if ((route === "/" || route === "/index.html") && req.method === "GET") {
    if (APP_HTML) {
      try {
        const html = appHtml();
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
      const p = readPage(db.stops, since, now);
      return send(res, 200, { stops: p.records, serverTime: p.serverTime, more: p.more });
    }

    if (route === "/stops" && req.method === "POST") {
      const body = await readBody(req);
      const incoming = Array.isArray(body.stops) ? body.stops : [];
      if (incoming.length > MAX_BATCH) return batchTooBig(res, incoming.length);
      const { saved, skewed, rejected } = upsertBatch(db.stops, incoming, now);
      persist();
      if (saved > 0) log(`saved ${saved} stop(s) from ${ip}`);
      if (skewed > 0) log(`WARNING: ${skewed} stop(s) from ${ip} are stamped in the future — check that device's clock`);
      if (rejected > 0) return storeFull(res, "stops", rejected, saved, now);
      return send(res, 200, { ok: true, serverTime: now, applied: saved, skewed });
    }

    // Production records (units/scrap per shift, for OEE) — same contract as /stops.
    if (route === "/production" && req.method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const p = readPage(db.production, since, now);
      return send(res, 200, { records: p.records, serverTime: p.serverTime, more: p.more });
    }

    if (route === "/production" && req.method === "POST") {
      const body = await readBody(req);
      const incoming = Array.isArray(body.records) ? body.records : [];
      if (incoming.length > MAX_BATCH) return batchTooBig(res, incoming.length);
      const { saved, rejected } = upsertBatch(db.production, incoming, now);
      persist();
      if (saved > 0) log(`saved ${saved} production record(s) from ${ip}`);
      if (rejected > 0) return storeFull(res, "production records", rejected, saved, now);
      return send(res, 200, { ok: true, serverTime: now });
    }

    // Machine sessions (operator presence spans) — same contract as /stops.
    if (route === "/sessions" && req.method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const p = readPage(db.sessions, since, now);
      return send(res, 200, { records: p.records, serverTime: p.serverTime, more: p.more });
    }

    if (route === "/sessions" && req.method === "POST") {
      const body = await readBody(req);
      const incoming = Array.isArray(body.records) ? body.records : [];
      if (incoming.length > MAX_BATCH) return batchTooBig(res, incoming.length);
      const { saved, rejected } = upsertBatch(db.sessions, incoming, now);
      persist();
      if (saved > 0 && VERBOSE) log(`saved ${saved} session record(s) from ${ip}`);
      if (rejected > 0) return storeFull(res, "session records", rejected, saved, now);
      return send(res, 200, { ok: true, serverTime: now });
    }

    if (route === "/config" && req.method === "GET") {
      return send(res, 200, { config: db.config.config, updatedAt: db.config.updatedAt || 0 });
    }

    if (route === "/config" && req.method === "PUT") {
      const body = await readBody(req);
      const rawAt = Number(body.updatedAt) || (body.config && Number(body.config.updatedAt)) || 0;
      const incomingAt = clampStamp(rawAt, now);
      const applied = incomingAt >= clampStamp(db.config.updatedAt || 0, now);
      if (applied) {
        db.config = { config: body.config || null, updatedAt: incomingAt };
        persist();
        log(`settings updated (machines/reasons/quick-stops) by ${ip}`);
      } else {
        // Never silently drop a supervisor's edit: say so, so the app can surface it.
        log(`settings from ${ip} REJECTED as older than the stored copy (incoming ${incomingAt}, stored ${db.config.updatedAt})`);
      }
      if (rawAt > now + CLOCK_SKEW_GRACE_MS) log(`WARNING: config from ${ip} is stamped in the future — check that device's clock`);
      return send(res, 200, { ok: true, serverTime: now, applied });
    }

    // Shift handovers — the end-of-shift card an operator hands to the next one
    // (message + their own flags). Same contract as /sessions, so the supervisor
    // sees handovers from every device rather than only the one they're holding.
    if (route === "/handovers" && req.method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const p = readPage(db.handovers, since, now);
      return send(res, 200, { records: p.records, serverTime: p.serverTime, more: p.more });
    }

    if (route === "/handovers" && req.method === "POST") {
      const body = await readBody(req);
      const incoming = Array.isArray(body.records) ? body.records : [];
      if (incoming.length > MAX_BATCH) return batchTooBig(res, incoming.length);
      const { saved, rejected } = upsertBatch(db.handovers, incoming, now);
      persist();
      if (saved > 0) log(`saved ${saved} handover(s) from ${ip}`);
      if (rejected > 0) return storeFull(res, "handovers", rejected, saved, now);
      return send(res, 200, { ok: true, serverTime: now });
    }

    // Shift handover email: { to: [addresses], subject, text }. 501 when SMTP
    // isn't set up so the app can fall back to copy-to-clipboard gracefully.
    if (route === "/report" && req.method === "POST") {
      const body = await readBody(req);
      // De-duplicate before counting: the cap is about how many mailboxes ONE
      // request can reach, and repeating an address is just a cheaper way to
      // reach the same one.
      const to = [...new Set((Array.isArray(body.to) ? body.to : [body.to])
        .filter((e) => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
      if (!to.length) return send(res, 400, { ok: false, error: "No valid recipients" });
      // The recipient list is caller-supplied, so with SMTP configured this route
      // is a mail relay for whoever holds the token: one request could address a
      // thousand strangers, and the spam complaint would name YOUR mail account.
      // A shift handover goes to a handful of supervisors — past that it isn't
      // this feature any more.
      if (to.length > MAX_RECIPIENTS) {
        log(`WARNING: /report from ${ip} asked for ${to.length} recipients — refused (max ${MAX_RECIPIENTS})`);
        return send(res, 400, { ok: false, error: `Too many recipients (${to.length}; max ${MAX_RECIPIENTS})` });
      }
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
    // Don't echo internals (parse errors, paths) back to the client. The one
    // exception is the size cap: the device can only do something about it if we
    // tell it what happened.
    console.error(`request error on ${route}:`, e.message);
    if (e && e.tooLarge) return send(res, 413, { ok: false, error: `Request body too large (max ${MAX_BODY_BYTES} bytes)` });
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

// A listen failure has to be LOUD. With the uncaughtException net installed
// above, an EADDRINUSE would otherwise be swallowed and the process would exit
// quietly with nothing listening — and the .bat's restart loop would repeat that
// silently forever. Say what's wrong and stop.
server.on("error", (e) => {
  console.error("");
  console.error(`Could not start the StopTrack server on port ${PORT}: ${e.message}`);
  if (e.code === "EADDRINUSE") console.error(`Something else is already using port ${PORT} — probably another StopTrack window. Close it, or set PORT=4001 and try again.`);
  console.error("");
  process.exit(1);
});

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
  console.log(`   Auth token:         ${TOKEN || "(NONE - SEE THE WARNING BELOW)"}`);
  console.log("");
  console.log("  Enter the address + token on each phone, watch, and browser.");
  if (!PUBLIC_URL) {
    console.log("  For an https address that works ANYWHERE, set up a tunnel");
    console.log("  (SETUP.md Part B), then set PUBLIC_URL and restart.");
  }
  console.log(`  (Don't use http://0.0.0.0:${PORT} — that address won't connect.)`);
  console.log(line);
  console.log("");
  // An open server has to SHOUT. authOk() lets every request through when there
  // is no token, and the code claimed this was "warned at startup" — but no
  // warning was ever written: the banner printed an empty "Auth token:" line and
  // nothing else, so a wide-open server looked exactly like a secured one. The
  // usual way in is a FACTORY_TOKEN that is set but blank or all spaces (it gets
  // trimmed to nothing), which is a typo nobody would expect to disable auth.
  if (!TOKEN) {
    const bang = "!".repeat(64);
    console.log(bang);
    console.log("  WARNING: NO AUTH TOKEN - THIS SERVER IS COMPLETELY OPEN.");
    console.log("");
    console.log("  Anyone who can reach the address above can read, change and");
    console.log("  delete every stop, every setting and every shift handover.");
    console.log("  No password is being asked for. Nothing is protected.");
    console.log("");
    console.log("  Cause: FACTORY_TOKEN is set but empty (or only spaces).");
    console.log("  Fix:   remove FACTORY_TOKEN and restart - the server then");
    console.log("         makes its own token and prints it here - or set");
    console.log("         FACTORY_TOKEN to a real secret.");
    console.log(bang);
    console.log("");
  }
  console.log(`Storage:  ${DATA_DIR}   (all data + token live here — back this folder up)`);
  if (repaired > 0) console.log(`Repaired: ${repaired} record(s) stamped in the future (a device clock was wrong)`);
  console.log(`Loaded:   ${Object.keys(db.stops).length} stops, ${Object.keys(db.production).length} production, ${Object.keys(db.sessions).length} sessions, ${Object.keys(db.handovers).length} handovers`);
  console.log(APP_HTML ? `App page: served at "/" from ${APP_HTML}` : `App page: NOT served — no index.html found next to server.js.`);
  console.log(VERBOSE ? "Logging:  verbose (every request)." : "Logging:  activity only (set LOG_VERBOSE=1 for every request).");
  console.log("");
  log("waiting for devices…");
});
