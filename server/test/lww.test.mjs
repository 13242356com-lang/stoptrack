// Tests for the sync server's last-write-wins merge, focused on the failure the
// scout reproduced: ONE device with a wrong clock permanently poisoning the
// shared data. Before the clamp, a phone whose clock read a year ahead made the
// supervisor's every later edit return ok:true and then silently vanish, and a
// future-stamped stop resurrected itself after being discarded — recoverable only
// by hand-editing the server's JSON.
//
// Run: node --test server/test/   (no dependencies; boots the real server.js)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
