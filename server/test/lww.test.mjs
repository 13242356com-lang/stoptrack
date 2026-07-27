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
