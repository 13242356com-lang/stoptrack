// Tests for two ways the server could be left wide open, both reproduced by the
// review agent against the real server.js:
//
//  1. FACTORY_TOKEN=" " resolved to an empty token, and an empty token means
//     every request is authorised — the whole downtime history readable AND
//     writable by anyone on the factory Wi-Fi. A blank value is easy to produce
//     by accident (an empty line in a .env, systemd unit or compose file).
//  2. Both rate limiters keyed on the CLIENT-SUPPLIED X-Forwarded-For, so one
//     header per request gave every attempt a fresh bucket and token guessing
//     never tripped the limit.
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

const servers = [];

// Boot a real server.js with the given env and return its base URL.
// NOTE: PORT=0 does NOT mean "any free port" here — server.js reads
// `Number(process.env.PORT) || 4000`, so 0 falls through to 4000. These servers
// stay up until after(), so each needs its own explicit port.
let nextPort = 4741;
async function boot(env) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "stoptrack-auth-"));
  const port = String(nextPort++);
  const proc = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: port, DATA_DIR: dataDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = await new Promise((resolve, reject) => {
    let out = "";
    const onData = (b) => {
      out += b.toString();
      const m = out.match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (c) => reject(new Error(`server exited early (${c}): ${out}`)));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15000);
  });
  servers.push({ proc, dataDir });
  return base;
}

after(() => {
  for (const s of servers) {
    s.proc.kill();
    rmSync(s.dataDir, { recursive: true, force: true });
  }
});

test("a blank FACTORY_TOKEN must not leave the server wide open", async () => {
  const base = await boot({ FACTORY_TOKEN: "   " });

  // No Authorization header at all.
  const read = await fetch(`${base}/stops?since=0`);
  assert.equal(read.status, 401,
    "an unauthenticated read must be rejected — a blank FACTORY_TOKEN used to authorise everyone");

  const write = await fetch(`${base}/stops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stops: [{ id: "injected-1", machine: "Line 1", start: 1, end: 2, duration: 1, updatedAt: Date.now() }] }),
  });
  assert.equal(write.status, 401, "an unauthenticated write must be rejected");

  // And the empty string must not be usable as the token either.
  const asEmpty = await fetch(`${base}/stops?since=0`, { headers: { Authorization: "Bearer " } });
  assert.equal(asEmpty.status, 401, "an empty bearer token must not authenticate");
});

test("failed-auth rate limiting cannot be bypassed with a rotating X-Forwarded-For", async () => {
  // TRUST_PROXY is OFF (the default), so the limiter must key on the socket.
  const base = await boot({ FACTORY_TOKEN: "real-token", RATE_LIMIT_AUTH: "5", RATE_LIMIT: "0" });

  let sawLimit = false;
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${base}/stops?since=0`, {
      headers: { Authorization: "Bearer wrong", "X-Forwarded-For": `10.1.0.${i}` },
    });
    if (res.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit,
    "12 wrong-token attempts with a rotating X-Forwarded-For must still trip the 5/min auth limit — " +
    "keying on a client-supplied header let an attacker mint a fresh bucket per request");
});

test("TRUST_PROXY=1 still honours the forwarding header, for the tunnel setup", async () => {
  const base = await boot({ FACTORY_TOKEN: "real-token", RATE_LIMIT_AUTH: "3", RATE_LIMIT: "0", TRUST_PROXY: "1" });

  // Same source socket, but distinct forwarded IPs => distinct buckets, so a few
  // attempts each must NOT trip a 3/min limit. This is the behaviour SETUP.md's
  // Cloudflare tunnel depends on (there the header is set by the tunnel, not the
  // client, and is the real per-device IP).
  let statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${base}/stops?since=0`, {
      headers: { Authorization: "Bearer wrong", "X-Forwarded-For": `10.2.0.${i}` },
    });
    statuses.push(res.status);
  }
  assert.ok(statuses.every((s) => s === 401),
    `with TRUST_PROXY=1 each forwarded IP gets its own bucket, so all six should be 401, got ${statuses.join(",")}`);
});
