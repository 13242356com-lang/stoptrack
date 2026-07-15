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

const PORT = Number(process.env.PORT) || 4000;
const TOKEN = process.env.FACTORY_TOKEN || "";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "stoptrack-data.json");

// The StopTrack web app to serve at "/" so a supervisor can open this server's
// URL in any browser (phone included) and get the full app — no separate
// supervisor UI to maintain. Resolution order: APP_HTML env override, the repo
// layout (../index.html), or a copy placed next to this script. If none exist
// the server still runs; "/" just explains where to put the file.
const APP_HTML = process.env.APP_HTML
  || [path.join(__dirname, "..", "index.html"), path.join(__dirname, "index.html")]
    .find((p) => { try { return fs.existsSync(p); } catch { return false; } })
  || "";

if (!TOKEN) {
  console.warn("WARNING: FACTORY_TOKEN is not set. Set one so only your devices can sync:\n" +
    "  FACTORY_TOKEN=some-long-random-secret node server.js\n" +
    "Running open (no auth) for now — do NOT do this on an untrusted network.");
}

// --- persistence (single JSON file) ----------------------------------------
// Shape: { stops: { [id]: record }, production: { [id]: record }, sessions: { [id]: record }, config: { config, updatedAt } }
let db = { stops: {}, production: {}, sessions: {}, config: { config: null, updatedAt: 0 } };
try {
  if (fs.existsSync(DATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    db = { stops: parsed.stops || {}, production: parsed.production || {}, sessions: parsed.sessions || {}, config: parsed.config || { config: null, updatedAt: 0 } };
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
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  });
  res.end(body);
}

function authOk(req) {
  if (!TOKEN) return true; // open mode (warned at startup)
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${TOKEN}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5e7) req.destroy(); }); // ~50MB guard
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// --- request routing --------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") return send(res, 204, {});

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = url.pathname.replace(/\/$/, "") || "/";
  const now = Date.now();

  // Serve the StopTrack app itself at "/" — the supervisor interface. The page
  // is public (same code as the deployed web app); all DATA stays behind the
  // bearer token, which the supervisor enters once in Supervisor → Server sync.
  if ((route === "/" || route === "/index.html") && req.method === "GET") {
    if (APP_HTML) {
      try {
        const html = fs.readFileSync(APP_HTML);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(html);
      } catch (e) {
        return send(res, 500, { ok: false, error: "Could not read app file: " + e.message });
      }
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(
      "StopTrack sync server is running.\n\n" +
      "To serve the app here too, put the built index.html next to server.js\n" +
      "(or set APP_HTML=/path/to/index.html) and restart.\n",
    );
  }

  // /health is open so a device can test connectivity before it has the token
  // pasted in. It still requires the token when one is configured.
  if (route === "/health" && req.method === "GET") {
    if (!authOk(req)) return send(res, 401, { ok: false, error: "Unauthorized" });
    return send(res, 200, { ok: true, serverTime: now });
  }

  if (!authOk(req)) return send(res, 401, { ok: false, error: "Unauthorized" });

  try {
    if (route === "/stops" && req.method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const stops = Object.values(db.stops).filter((s) => stampOf(s) > since);
      return send(res, 200, { stops, serverTime: now });
    }

    if (route === "/stops" && req.method === "POST") {
      const body = await readBody(req);
      const incoming = Array.isArray(body.stops) ? body.stops : [];
      for (const r of incoming) {
        if (!r || !r.id) continue;
        const cur = db.stops[r.id];
        // Last-write-wins: keep whichever record was mutated more recently.
        if (!cur || stampOf(r) >= stampOf(cur)) db.stops[r.id] = r;
      }
      persist();
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
      for (const r of incoming) {
        if (!r || !r.id) continue;
        const cur = db.production[r.id];
        if (!cur || stampOf(r) >= stampOf(cur)) db.production[r.id] = r;
      }
      persist();
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
      for (const r of incoming) {
        if (!r || !r.id) continue;
        const cur = db.sessions[r.id];
        if (!cur || stampOf(r) >= stampOf(cur)) db.sessions[r.id] = r;
      }
      persist();
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
        return send(res, 502, { ok: false, error: "Mail send failed: " + (e.message || "unknown") });
      }
    }

    return send(res, 404, { ok: false, error: "Not found" });
  } catch (e) {
    return send(res, 400, { ok: false, error: e.message || "Bad request" });
  }
});

server.listen(PORT, () => {
  console.log(`StopTrack sync server listening on http://0.0.0.0:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(APP_HTML ? `Supervisor app served at "/" from: ${APP_HTML}` : `Supervisor app NOT served ("/" shows instructions) — no index.html found.`);
  console.log(TOKEN ? "Auth: token required." : "Auth: OPEN (no token set).");
});
