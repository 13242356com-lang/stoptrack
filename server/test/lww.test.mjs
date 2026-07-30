// Tests for the sync server. Two families:
//
//  1. Last-write-wins merge, from the failure the scout reproduced: ONE device
//     with a wrong clock permanently poisoning the shared data. Before the clamp,
//     a phone whose clock read a year ahead made the supervisor's every later
//     edit return ok:true and then silently vanish, and a future-stamped stop
//     resurrected itself after being discarded — recoverable only by hand-editing
//     the server's JSON.
//
//  2. The front door: auth, rate limiting, malformed input, ingestion limits.
//     None of it had a single test, and all of the holes below were reproduced
//     against the running server first — one unauthenticated packet could kill
//     the process, a rotating X-Forwarded-For turned the token into something you
//     could brute-force at full speed, a blank FACTORY_TOKEN opened the server
//     with no warning, and one request could insert 200,000 records.
//
// Run: node --test server/test/   (no dependencies; boots the real server.js)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
const TOKEN = "test-token";
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

let proc, dataDir, base;

const req = async (method, route, body) => {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

// --- helpers for the front-door tests ---------------------------------------
// Each of these boots its OWN server: they turn limits down to numbers a test can
// reach in a second, and a rate-limit test must not spend the shared instance's
// budget on the tests around it.

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

async function startServer(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "stoptrack-test-"));
  const port = await freePort();
  const p = spawn(process.execPath, [serverPath], {
    // PORT=0 would land on the default 4000, which the shared instance holds.
    env: { ...process.env, FACTORY_TOKEN: TOKEN, PORT: String(port), DATA_DIR: dir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  for (const s of [p.stdout, p.stderr]) { s.setEncoding("utf8"); s.on("data", (c) => { out += c; }); }
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 10000);
    const check = () => { if (/waiting for devices/.test(out)) { clearTimeout(t); resolve(); } };
    p.stdout.on("data", check);
    p.on("exit", (code) => { clearTimeout(t); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const call = async (method, route, { body, token = TOKEN, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return {
    port, proc: p, call, output: () => out,
    alive: () => p.exitCode === null && p.signalCode === null,
    stop() { p.kill(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// Speak HTTP down a raw socket — the only way to send things fetch() refuses to,
// such as a Host header that isn't a valid authority.
const rawRequest = (port, payload, { chunkAt } = {}) => new Promise((resolve, reject) => {
  let buf = "";
  const s = net.connect(port, "127.0.0.1", () => {
    if (chunkAt == null) { s.write(payload); return; }
    // Deliberately split the bytes so the server sees two 'data' events.
    s.write(payload.subarray(0, chunkAt));
    setTimeout(() => s.write(payload.subarray(chunkAt)), 40);
  });
  s.setTimeout(8000, () => { s.destroy(); resolve(buf); });
  s.on("data", (d) => { buf += d.toString("utf8"); });
  s.on("close", () => resolve(buf));
  s.on("error", (e) => (buf ? resolve(buf) : reject(e)));
});

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "stoptrack-test-"));
  proc = spawn(process.execPath, [serverPath], {
    env: { ...process.env, FACTORY_TOKEN: TOKEN, PORT: "0", DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // The server prints the address it bound; wait for it rather than sleeping.
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start in time")), 10000);
    proc.stdout.on("data", (chunk) => {
      const m = String(chunk).match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    proc.on("error", reject);
  });
});

after(() => {
  if (proc) proc.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("a future-stamped config cannot discard the supervisor's later edit", async () => {
  const skewed = Date.now() + YEAR_MS;         // a phone whose clock is a year fast
  await req("PUT", "/config", { config: { machines: ["SKEWED"] }, updatedAt: skewed });

  const supervisor = Date.now();
  const put = await req("PUT", "/config", { config: { machines: ["Supervisor edit"] }, updatedAt: supervisor });
  assert.equal(put.data.applied, true, "the supervisor's edit must be applied, not silently dropped");

  const got = await req("GET", "/config");
  assert.deepEqual(got.data.config.machines, ["Supervisor edit"],
    "the skewed device must not out-rank every later edit");
});

test("a losing config write reports applied:false instead of a bare ok", async () => {
  await req("PUT", "/config", { config: { machines: ["Newer"] }, updatedAt: Date.now() });
  const stale = await req("PUT", "/config", { config: { machines: ["Older"] }, updatedAt: Date.now() - 60_000 });
  assert.equal(stale.data.ok, true);
  assert.equal(stale.data.applied, false, "a write that lost LWW must say so, so the app can surface it");
});

test("a future-stamped stop cannot resurrect itself after being discarded", async () => {
  const id = "1700000000000-42";
  await req("POST", "/stops", {
    stops: [{ id, machine: "Line 1", operator: "Alice", reason: "Cleaning",
      start: 1700000000000, end: 1700000060000, duration: 60000,
      discarded: false, updatedAt: Date.now() + YEAR_MS }],   // skewed device
  });
  await req("POST", "/stops", {
    stops: [{ id, machine: "Line 1", operator: "Alice", reason: "Cleaning",
      start: 1700000000000, end: 1700000060000, duration: 60000,
      discarded: true, discardedAt: Date.now(), updatedAt: Date.now() }],  // the discard
  });

  const got = await req("GET", "/stops?since=0");
  const rec = got.data.stops.find((s) => s.id === id);
  assert.equal(rec.discarded, true, "the discard must stick — a skewed clock must not undo it");
});

test("future-stamped writes are reported so the operator can be told", async () => {
  const r = await req("POST", "/stops", {
    stops: [{ id: "1700000000001-7", machine: "Line 1", operator: "Bob",
      start: 1700000000001, end: 1700000000002, duration: 1, updatedAt: Date.now() + YEAR_MS }],
  });
  assert.ok(r.data.skewed >= 1, "the response should flag records stamped in the future");
});

test("a device that is merely BEHIND still wins with a legitimately newer edit", async () => {
  // The clamp must only touch the future side: an offline device catching up has
  // past-dated stamps and must still be able to update a record.
  const id = "1700000000002-9";
  await req("POST", "/stops", {
    stops: [{ id, machine: "Line 1", operator: "Ann", reason: "Cleaning",
      start: 1, end: 2, duration: 1, notes: "first", updatedAt: Date.now() - 3 * 60 * 60 * 1000 }],
  });
  await req("POST", "/stops", {
    stops: [{ id, machine: "Line 1", operator: "Ann", reason: "Cleaning",
      start: 1, end: 2, duration: 1, notes: "second", updatedAt: Date.now() - 60 * 60 * 1000 }],
  });
  const got = await req("GET", "/stops?since=0");
  assert.equal(got.data.stops.find((s) => s.id === id).notes, "second",
    "a newer (but still past) stamp must win — the clamp is future-only");
});

test("handovers round-trip through the sync contract", async () => {
  // v0.6 shipped the handout with no server route at all, so the supervisor's
  // handover log was permanently empty on any setup with more than one device.
  const id = `${Date.now()}-77`;
  const rec = {
    id, operator: "Alice", machine: "Line 1", shiftName: "Night",
    windowStart: Date.now() - 7 * 3600e3, windowEnd: Date.now(),
    stopCount: 3, downtimeMs: 900000,
    note: "Infeed guide rail looks worn.",
    flags: [{ text: "Guide rail worn", level: "fix" }],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  const post = await req("POST", "/handovers", { records: [rec] });
  assert.equal(post.data.ok, true);

  const got = await req("GET", "/handovers?since=0");
  const back = got.data.records.find((r) => r.id === id);
  assert.ok(back, "the handover must come back from the server");
  assert.equal(back.note, rec.note, "the operator's message must survive the round trip");
  assert.equal(back.flags[0].text, "Guide rail worn", "the operator's flags must survive too");

  // `since` must actually PAGE: a cursor taken before the write returns it, one
  // taken after does not. (Asserting only that a future cursor is empty would
  // pass even with `since` filtering removed entirely.)
  const before = (await req("GET", `/handovers?since=${rec.createdAt - 1000}`)).data.records;
  assert.ok(before.some((r) => r.id === id), "a cursor from before the write must return it");

  const cursor = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  const after = (await req("GET", `/handovers?since=${cursor}`)).data.records;
  assert.ok(!after.some((r) => r.id === id), "a cursor from after the write must not return it again");
});

test("a store poisoned BEFORE the clamp existed is repaired at boot", async () => {
  // The clamp alone was not enough: a stored future stamp re-clamps to the
  // CURRENT now on every read, so it ties or beats every honest write forever —
  // the store stayed permanently unfixable through the API.
  const dir = mkdtempSync(path.join(tmpdir(), "stoptrack-poisoned-"));
  const poisoned = Date.now() + 5 * YEAR_MS;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(dir, "stoptrack-data.json"), JSON.stringify({
    stops: { "1700000000000-1": { id: "1700000000000-1", machine: "Line 1", operator: "A",
      start: 1700000000000, end: 1700000001000, duration: 1000, discarded: false, updatedAt: poisoned } },
    production: {}, sessions: {}, handovers: {},
    config: { config: { machines: ["POISONED"] }, updatedAt: poisoned },
  }));

  // A distinct port: server.js treats PORT=0 as falsy and falls back to 4000,
  // which the shared instance above already holds.
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p2 = spawn(process.execPath, [serverPath], {
    env: { ...process.env, FACTORY_TOKEN: TOKEN, PORT: String(port), DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base2 = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no start")), 10000);
    p2.stdout.on("data", (c) => {
      const m = String(c).match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
    });
  });
  const call = async (method, route, body) => {
    const r = await fetch(`${base2}${route}`, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return r.json().catch(() => ({}));
  };

  try {
    const edit = await call("PUT", "/config", { config: { machines: ["Supervisor edit"] }, updatedAt: Date.now() });
    assert.equal(edit.applied, true, "a supervisor edit must be able to beat a pre-existing poisoned config");
    assert.deepEqual((await call("GET", "/config")).config.machines, ["Supervisor edit"]);

    await call("POST", "/stops", {
      stops: [{ id: "1700000000000-1", machine: "Line 1", operator: "A",
        start: 1700000000000, end: 1700000001000, duration: 1000,
        discarded: true, discardedAt: Date.now(), updatedAt: Date.now() }],
    });
    const got = await call("GET", "/stops?since=0");
    assert.equal(got.stops.find((s) => s.id === "1700000000000-1").discarded, true,
      "a discard must stick against a record poisoned before the fix");
  } finally {
    p2.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ===========================================================================
   The front door — auth, rate limiting, malformed input, ingestion limits.
   ======================================================================== */

test("no token and a wrong token are refused on every data route", async () => {
  // The auth gate has to sit in FRONT of every route that touches data; a route
  // added above it would be an open door. RATE_LIMIT_AUTH=0 so the run isn't
  // answered with 429s partway through — this test is about auth, not limits.
  const s = await startServer({ RATE_LIMIT_AUTH: "0" });
  try {
    const routes = [
      ["GET", "/stops?since=0"], ["POST", "/stops"],
      ["GET", "/production?since=0"], ["POST", "/production"],
      ["GET", "/sessions?since=0"], ["POST", "/sessions"],
      ["GET", "/handovers?since=0"], ["POST", "/handovers"],
      ["GET", "/config"], ["PUT", "/config"],
      ["POST", "/report"], ["GET", "/health"],
    ];
    for (const [method, route] of routes) {
      const body = method === "GET" ? undefined : {};
      assert.equal((await s.call(method, route, { token: null, body })).status, 401,
        `${method} ${route} must refuse a request with no token`);
      assert.equal((await s.call(method, route, { token: "not-the-token", body })).status, 401,
        `${method} ${route} must refuse a wrong token`);
    }
  } finally { s.stop(); }
});

test("a malformed Host header is answered 400 and does NOT kill the server", async () => {
  // `new URL(req.url, "http://" + req.headers.host)` sat outside the handler's
  // try/catch, so `Host: [` threw inside an async function, Node saw an unhandled
  // rejection, and the process exited. One unauthenticated packet — no token, no
  // session, nothing — stopped the whole factory's downtime tracking.
  const s = await startServer();
  try {
    const raw = await rawRequest(s.port, Buffer.from("GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n"));
    assert.match(raw, /^HTTP\/1\.1 400/, `expected a 400, got: ${JSON.stringify(raw.slice(0, 120))}`);

    await new Promise((r) => setTimeout(r, 150));
    assert.ok(s.alive(), "the server process must survive a malformed request");
    assert.equal((await s.call("GET", "/health")).status, 200,
      "and it must still be answering devices afterwards");
  } finally { s.stop(); }
});

test("a rotating X-Forwarded-For does not raise the effective rate limit", async () => {
  // Reproduced before the fix: 40 wrong tokens from one machine were throttled
  // after 20; the same 40 with a rotating X-Forwarded-For were throttled zero
  // times, because clientIp() believed the header. That turned the shared token
  // into something guessable at full speed.
  const s = await startServer({ RATE_LIMIT_AUTH: "5", RATE_LIMIT: "0" });
  try {
    let throttled = 0;
    for (let i = 0; i < 20; i++) {
      const r = await s.call("GET", "/stops?since=0", {
        token: "guess", headers: { "X-Forwarded-For": `10.1.2.${i}`, "CF-Connecting-IP": `10.4.5.${i}` },
      });
      if (r.status === 429) throttled++;
    }
    assert.ok(throttled > 0, "token guessing must still be throttled when the caller rotates X-Forwarded-For");
  } finally { s.stop(); }
});

test("behind a real proxy (TRUST_PROXY=1) the forwarded IP is honoured again", async () => {
  // The other half of the same fix: through the Cloudflare tunnel every request
  // arrives from Cloudflare, so without trusting its header the whole factory
  // would share one bucket. Opt in, and each device is limited on its own.
  const s = await startServer({ TRUST_PROXY: "1", RATE_LIMIT_AUTH: "5", RATE_LIMIT: "0" });
  try {
    let throttled = 0;
    for (let i = 0; i < 20; i++) {
      const r = await s.call("GET", "/stops?since=0", { token: "guess", headers: { "X-Forwarded-For": `10.1.2.${i}` } });
      if (r.status === 429) throttled++;
    }
    assert.equal(throttled, 0, "distinct devices behind the proxy must each get their own allowance");

    let same = 0;
    for (let i = 0; i < 12; i++) {
      const r = await s.call("GET", "/stops?since=0", { token: "guess", headers: { "X-Forwarded-For": "10.7.7.7" } });
      if (r.status === 429) same++;
    }
    assert.ok(same > 0, "one device behind the proxy must still be throttled");
  } finally { s.stop(); }
});

test("a flood of unique IPs cannot reset an active client's rate-limit bucket", async () => {
  // The memory bound was itself a bypass: at RL_MAX_IPS the limiter called
  // map.clear(), wiping every honest client's bucket and every failed-auth count
  // along with the attacker's. Anyone could reset the limits on demand.
  const s = await startServer({ TRUST_PROXY: "1", RATE_LIMIT: "2", RATE_LIMIT_MAX_IPS: "8" });
  try {
    const hit = (xff) => s.call("GET", "/health", { headers: { "X-Forwarded-For": xff } });
    const me = "10.9.9.9";
    assert.equal((await hit(me)).status, 200);
    assert.equal((await hit(me)).status, 200);
    assert.equal((await hit(me)).status, 429, "the third request inside the window is over the limit");

    for (let i = 0; i < 40; i++) {
      await hit(`172.16.${Math.floor(i / 256)}.${i % 256}`);
      if (i % 5 === 4) {
        assert.equal((await hit(me)).status, 429,
          `a flood of unique IPs must not hand an over-limit client a fresh bucket (after ${i + 1} of them)`);
      }
    }
  } finally { s.stop(); }
});

test("OPTIONS preflights are rate-limited like every other request", async () => {
  // Preflights were answered above the limiter, so they were free and unlimited.
  const s = await startServer({ RATE_LIMIT: "3" });
  try {
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await s.call("OPTIONS", "/stops")).status);
    assert.ok(codes.includes(429), `preflights must count against the limit, got ${codes.join(",")}`);
  } finally { s.stop(); }
});

test("an oversized batch is refused with a clear error and nothing is stored", async () => {
  const s = await startServer({ SYNC_MAX_BATCH: "10" });
  try {
    const stops = Array.from({ length: 11 }, (_, i) => ({
      id: `batch-${i}`, machine: "Line 1", operator: "A", start: 1, end: 2, duration: 1, updatedAt: Date.now(),
    }));
    const r = await s.call("POST", "/stops", { body: { stops } });
    assert.equal(r.status, 413, "a batch past the cap must be refused, not ingested");
    assert.match(r.data.error || "", /max 10/, "the error must name the limit so the device can split the batch");
    assert.equal((await s.call("GET", "/stops?since=0")).data.stops.length, 0,
      "a refused batch must not be half-applied");
  } finally { s.stop(); }
});

test("an oversized body is ANSWERED 413 rather than left hanging", async () => {
  // readBody's old guard called req.destroy(), which settles neither 'end' nor
  // 'error': the promise never resolved, the handler awaited it forever and the
  // device got no answer at all — a leak per oversized request.
  const s = await startServer({ SYNC_MAX_BODY_BYTES: String(64 * 1024) });
  try {
    const body = JSON.stringify({ stops: [{ id: "big-1", notes: "x".repeat(256 * 1024) }] });
    const r = await s.call("POST", "/stops", { body });
    assert.equal(r.status, 413, "the server must answer an oversized body, not hang");
    assert.ok(s.alive(), "and stay up");
  } finally { s.stop(); }
});

test("a full collection refuses NEW records but still accepts updates", async () => {
  // Unbounded ingestion was the DoS (one request inserted 200k records, and every
  // later save rewrote all of them). But a cap that also blocked UPDATES would
  // freeze every discard and correction — the store must stay editable when full.
  const s = await startServer({ SYNC_MAX_RECORDS: "3" });
  try {
    const mk = (i, extra = {}) => ({
      id: `cap-${i}`, machine: "Line 1", operator: "A", start: 1, end: 2, duration: 1,
      updatedAt: Date.now(), ...extra,
    });
    assert.equal((await s.call("POST", "/stops", { body: { stops: [mk(1), mk(2), mk(3)] } })).status, 200);

    const over = await s.call("POST", "/stops", { body: { stops: [mk(4)] } });
    assert.equal(over.status, 507, "past the cap the server must say so instead of growing forever");
    assert.equal(over.data.rejected, 1);

    const upd = await s.call("POST", "/stops", { body: { stops: [mk(1, { discarded: true })] } });
    assert.equal(upd.status, 200, "a discard is an update — a full store must still take it");

    const got = await s.call("GET", "/stops?since=0");
    assert.equal(got.data.stops.length, 3);
    assert.equal(got.data.stops.find((x) => x.id === "cap-1").discarded, true);
  } finally { s.stop(); }
});

test("a GET returns a bounded page, and a client that ignores paging still converges", async () => {
  // `?since=0` used to serialise the entire store into one response. It now pages
  // — and the cursor is chosen so the EXISTING clients, which only ever store
  // `serverTime` and poll again, pick up where the page stopped instead of
  // skipping the remainder.
  const s = await startServer({ SYNC_MAX_PAGE: "3" });
  try {
    const t0 = Date.now() - 10000;
    const stops = Array.from({ length: 10 }, (_, i) => ({
      id: `page-${i}`, machine: "Line 1", operator: "A", start: t0 + i, end: t0 + i, duration: 1, updatedAt: t0 + i,
    }));
    assert.equal((await s.call("POST", "/stops", { body: { stops } })).status, 200);

    const first = await s.call("GET", "/stops?since=0");
    assert.equal(first.data.stops.length, 3, "the page must be capped");
    assert.equal(first.data.more, true, "and say there is more");

    // Exactly what the app does: api.setCursor(pull.serverTime), then poll again.
    const seen = new Set();
    let since = 0;
    for (let i = 0; i < 12; i++) {
      const r = await s.call("GET", `/stops?since=${since}`);
      if (!r.data.stops.length) break;
      assert.ok(r.data.stops.length <= 3, "no page may exceed the cap");
      for (const st of r.data.stops) seen.add(st.id);
      since = r.data.serverTime;
    }
    assert.equal(seen.size, 10, "paging must lose nothing — every record has to arrive across the polls");
  } finally { s.stop(); }
});

test("an accented name split across two chunks arrives intact", async () => {
  // readBody did `data += chunk`, decoding each chunk on its own, so a UTF-8
  // sequence landing on a chunk boundary became two replacement characters —
  // silent corruption of an accented machine or operator name, and only on
  // batches big enough to be split, i.e. exactly the ones nobody sends by hand.
  const s = await startServer();
  try {
    const json = JSON.stringify({
      stops: [{ id: "utf8-1", machine: "Café Ligné", operator: "Renée", start: 1, end: 2, duration: 1, updatedAt: Date.now() }],
    });
    const body = Buffer.from(json, "utf8");
    const cut = body.indexOf(0xc3) + 1;   // between the two bytes of "é"
    assert.ok(cut > 1, "the test needs a multi-byte character to split");
    const head = Buffer.from(
      `POST /stops HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`, "utf8");
    const raw = await rawRequest(s.port, Buffer.concat([head, body]), { chunkAt: head.length + cut });
    assert.match(raw, /^HTTP\/1\.1 200/, `expected 200, got: ${JSON.stringify(raw.slice(0, 120))}`);

    const rec = (await s.call("GET", "/stops?since=0")).data.stops.find((x) => x.id === "utf8-1");
    assert.equal(rec.machine, "Café Ligné", "an accented machine name must survive a chunk boundary");
    assert.equal(rec.operator, "Renée");
  } finally { s.stop(); }
});

test("/report will not fan a handover out to an unbounded recipient list", async () => {
  // Recipients are caller-supplied, so with SMTP configured this was an
  // authenticated open relay: one request could address a thousand strangers and
  // the spam complaint would name the factory's own mail account.
  const s = await startServer({ MAIL_MAX_RECIPIENTS: "5" });
  try {
    const many = Array.from({ length: 40 }, (_, i) => `person${i}@example.com`);
    const r = await s.call("POST", "/report", { body: { to: many, text: "shift handover" } });
    assert.equal(r.status, 400, "a caller must not be able to use this as a mail relay");
    assert.match(r.data.error || "", /Too many recipients/);

    // A real handover still gets as far as the mail step (501 = no SMTP here).
    assert.equal((await s.call("POST", "/report", { body: { to: ["supervisor@example.com"], text: "handover" } })).status, 501,
      "a normal handover must still reach the mailer");
  } finally { s.stop(); }
});

test("a blank FACTORY_TOKEN prints an unmissable warning that the server is open", async () => {
  // `FACTORY_TOKEN="   "` trims to "" and authOk() then waves every request
  // through. The code claimed this was "warned at startup" — but no warning was
  // ever written: the banner printed an empty "Auth token:" line and nothing
  // else, so a wide-open server looked exactly like a secured one.
  const s = await startServer({ FACTORY_TOKEN: "   " });
  try {
    const out = s.output();
    assert.match(out, /NO AUTH TOKEN/, "an open server must say so in the window the operator is watching");
    assert.ok(out.split("\n").filter((l) => /^!{10,}/.test(l)).length >= 2,
      "the warning must be a block you cannot scroll past, not one quiet line");
    assert.doesNotMatch(out, /Auth token: +$/m, "the token line must not be left blank and unexplained");

    // And it is warning about something real: with no token, nothing is guarded.
    const anon = await s.call("POST", "/stops", {
      token: null,
      body: { stops: [{ id: "anon-1", machine: "Line 1", operator: "?", start: 1, end: 2, duration: 1, updatedAt: Date.now() }] },
    });
    assert.equal(anon.status, 200, "open mode really is open — which is exactly why it has to be shouted about");
  } finally { s.stop(); }
});
