// End-to-end browser test for the StopTrack web app (index.html), run in a real
// headless Chromium via Playwright. It guards the operator stop-report flow —
// the exact path that regressed in the quick-stop work (a stop wasn't recorded
// when documented through the native shell).
//
// It renders the REAL shipped index.html. The React/Tailwind CDN scripts are
// blocked in CI/sandbox, so we intercept those requests and fulfil them from the
// local node_modules UMD builds — the app code under test is unchanged. A mock
// `window.StopTrackNative` simulates the native quick-stop timer (the Android
// shell), so we exercise the shell code path, not just the browser one.
//
// Run: node test/web-e2e.mjs   (needs `npm install` first for playwright + react)

import { chromium } from "playwright";
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from "fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "url";
import path from "path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Prefer a project-installed Playwright browser; fall back to the sandbox's
// pre-installed Chromium (revision differs from Playwright's bundled one).
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    const dir = readdirSync(base).find((d) => d.startsWith("chromium-") && !d.includes("headless"));
    if (dir) {
      const p = path.join(base, dir, "chrome-linux", "chrome");
      if (existsSync(p)) return p;
    }
  } catch { /* fall through to Playwright's default */ }
  return undefined; // undefined → Playwright uses its own downloaded browser (CI)
}

const reactUmd = readFileSync(path.join(root, "node_modules/react/umd/react.production.min.js"), "utf8");
const reactDomUmd = readFileSync(path.join(root, "node_modules/react-dom/umd/react-dom.production.min.js"), "utf8");

// Injected before the app scripts run. Simulates the phone's native quick-stop
// timer: buttons in the web app call these; each transition pushes the new state
// back to the app via window.StopTrackShell.onState (exactly like MainActivity).
function installMockNative() {
  const nat = {
    _timer: null,
    _pending: null,
    syncUrl: () => "", // empty → the shell won't enable server sync (no network in the test)
    token: () => "",
    requestState: function () { this._push(); },
    startStop: function (m) {
      const now = Date.now();
      this._timer = { running: true, paused: false, startTs: now, accumulatedMs: 0, segStartMs: now, machine: m || "Line 1" };
      this._pending = null;
      this._push();
    },
    pauseStop: function () {
      const t = this._timer;
      if (t && !t.paused) { t.accumulatedMs += Date.now() - t.segStartMs; t.paused = true; t.segStartMs = null; }
      this._push();
    },
    resumeStop: function () {
      const t = this._timer;
      if (t && t.paused) { t.paused = false; t.segStartMs = Date.now(); }
      this._push();
    },
    endStop: function () {
      const t = this._timer;
      if (!t) return;
      const now = Date.now();
      const dur = t.paused ? t.accumulatedMs : t.accumulatedMs + (now - t.segStartMs);
      this._pending = { start: t.startTs, end: now, durationMs: dur, machine: t.machine };
      this._timer = null;
      this._push();
    },
    // New design: the web app records the stop locally; native just drops its pending.
    documentStop: function () { /* intentionally no-op — the web owns recording */ },
    discardStop: function () { this._pending = null; this._push(); },
    saveFile: function (name, mime, content) { window.__savedFile = { name, mime, len: (content || "").length }; },
    saveImage: function (name, b64) { window.__savedImage = { name, len: (b64 || "").length }; },
    shareImage: function (name, b64, text) { window.__sharedImage = { name, len: (b64 || "").length, text }; },
    _push: function () {
      const payload = { timer: this._timer, pending: this._pending };
      window.__lastPush = payload;
      if (window.StopTrackShell && window.StopTrackShell.onState) window.StopTrackShell.onState(payload);
    },
  };
  window.StopTrackNative = nat;
}

function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAILED: " + msg); }

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Serve the CDN scripts from local node_modules so the real index.html renders offline.
  await page.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const url = route.request().url();
    if (url.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (url.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });

  await page.addInitScript(installMockNative);
  // Configure sync at an unreachable port: the outbox only records changes once
  // sync is configured, so this is what lets us assert a handover is queued for
  // upload. Every request simply fails and is retried later, which is the
  // offline-first behaviour anyway.
  await page.addInitScript(() => {
    localStorage.setItem("config:sync", JSON.stringify({ url: "http://127.0.0.1:9", token: "t", enabled: true }));
  });
  await page.goto("file://" + path.join(root, "index.html"));

  // App booted (no red error overlay, operator timer visible).
  await page.waitForSelector("text=Start Stop", { timeout: 20000 });
  assert(errors.length === 0, "page threw on load: " + errors.join(" | "));

  // Confirm we're actually on the native-shell code path (not the browser fallback).
  const inShell = await page.evaluate(() => typeof window.StopTrackNative.startStop === "function");
  assert(inShell, "mock native bridge not detected as a shell");

  // Name the operator so we also guard operator attribution.
  await page.fill('input[placeholder="Your name"]', "Alice");

  // Drive a full stop: Start → (tick) → End → pick reason → Save.
  await page.click("text=Start Stop");
  await page.waitForSelector("text=End Stop", { timeout: 5000 });
  await page.waitForTimeout(300); // let a little time accrue
  await page.click("text=End Stop");

  // The reason picker (the "Document this stop" card) must appear — this is the
  // native End routing into the app's reason UI.
  await page.waitForSelector("text=Document this stop", { timeout: 5000 });
  const chosenReason = await page.$eval(".border-emerald-400 select", (el) => el.value);
  assert(chosenReason && chosenReason.length > 0, "no reason preselected in the picker");

  await page.click("text=Save stop");

  // The picker must close (record accepted) …
  await page.waitForSelector("text=Document this stop", { state: "detached", timeout: 5000 });

  // … and the stop must be persisted IMMEDIATELY (the regression: it wasn't,
  // because recording went through native + a sync round-trip). Read storage as truth.
  const saved = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("stop:")) { try { out.push(JSON.parse(localStorage.getItem(k))); } catch { /* skip */ } }
    }
    return out;
  });

  assert(saved.length === 1, `expected exactly 1 stop recorded, got ${saved.length}`);
  const rec = saved[0];
  assert(rec.operator === "Alice", `operator attribution wrong: expected "Alice", got "${rec.operator}"`);
  assert(rec.reason === chosenReason, `reason mismatch: expected "${chosenReason}", got "${rec.reason}"`);
  assert(rec.duration > 0, `duration should be > 0, got ${rec.duration}`);
  assert(rec.discarded === false, "stop should not be discarded");

  // The operator's live board reflects it (Stops stat card shows 1) — the
  // user-visible proof, not just storage.
  const stopsValue = await page
    .locator("div.rounded-xl.p-3.text-center", { hasText: "Stops" })
    .first()
    .locator("div.font-bold")
    .innerText();
  assert(stopsValue.trim() === "1", `operator "Stops" stat should show 1, saw: ${JSON.stringify(stopsValue)}`);

  // ---- shift handout -------------------------------------------------------
  // The handover leaves the app as one image, so the guard is: the operator's own
  // words reach the card, the PNG actually renders, and sending it files a record.
  await page.click("text=Handover");
  await page.waitForSelector("text=MESSAGE FOR THE NEXT SHIFT", { timeout: 5000 });

  await page.fill("textarea", "Infeed guide rail looks worn - jammed twice on nights.");
  await page.fill('input[placeholder="e.g. Asla 2 coolant low"]', "Coolant low on Line 2");
  await page.click("text=Add");

  // The flag the operator typed must appear as a chip (their words, not a preset).
  await page.waitForSelector("text=Coolant low on Line 2", { timeout: 3000 });

  // The preview IS the shared PNG — assert it rendered as a real, non-trivial image.
  const img = await page.waitForSelector('img[alt="Shift handout"]', { timeout: 8000 });
  const shot = await img.evaluate((el) => ({ src: (el.getAttribute("src") || "").slice(0, 22), w: el.naturalWidth, h: el.naturalHeight }));
  assert(shot.src.startsWith("data:image/png"), `handout preview is not a PNG data URL (got ${shot.src})`);
  assert(shot.w > 400 && shot.h > 200, `handout image looks degenerate: ${shot.w}x${shot.h}`);

  // Share is the PRIMARY action — assert the native share bridge gets real bytes
  // and the summary text, in the 3-arg shape Kotlin's shareImage(String,String,String?) expects.
  await page.click("text=Share handout");
  const sharedImg = await page.evaluate(() => window.__sharedImage || null);
  assert(sharedImg && sharedImg.len > 5000, `native shareImage not called with real PNG bytes (${JSON.stringify(sharedImg)})`);
  assert(/\.png$/.test(sharedImg.name), `shared filename should be a .png, got ${sharedImg.name}`);
  assert(/guide rail/i.test(sharedImg.text || ""), "shared text should carry the operator's message");

  await page.click("text=Save image");

  // Native bridge received the image bytes …
  const savedImg = await page.evaluate(() => window.__savedImage || null);
  assert(savedImg && savedImg.len > 5000, `native saveImage not called with real PNG bytes (${JSON.stringify(savedImg)})`);
  assert(/\.png$/.test(savedImg.name), `handout filename should be a .png, got ${savedImg.name}`);

  // … and the handout was filed, carrying the operator's note + flag.
  const handovers = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("hand:")) { try { out.push(JSON.parse(localStorage.getItem(k))); } catch { /* skip */ } }
    }
    return out;
  });
  // Sharing AND saving the same handout is one handover, not two — the record is
  // updated in place, never duplicated.
  assert(handovers.length === 1, `share+save should file exactly 1 handover record, got ${handovers.length}`);
  const h = handovers[0];
  assert(/guide rail/i.test(h.note || ""), `handover note not persisted: ${JSON.stringify(h.note)}`);
  assert((h.flags || []).some((f) => /coolant/i.test(f.text)), `operator flag not persisted: ${JSON.stringify(h.flags)}`);
  assert(h.operator === "Alice", `handover operator wrong: ${h.operator}`);

  // The handout must also be QUEUED FOR SYNC. Without this it stayed on the
  // device forever: no /handovers route, no _enqueue — so the supervisor's
  // handover log was permanently empty on any setup with more than one phone.
  const outbox = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("sync:outbox") || "[]"); } catch { return []; }
  });
  assert(outbox.includes(`hand:${h.id}`),
    `handover must be queued for sync, outbox was ${JSON.stringify(outbox)}`);

  // ---- what counts as "this shift" -----------------------------------------
  // The window is derived from the shift CLOCK, so it rolls over on its own. It
  // used to move only when someone tapped "New Shift", which credited a night
  // operator with 21 hours of manned time on one machine. Check the window maths
  // directly (it's a pure function), then the behaviour it drives.
  const win = await page.evaluate(() => {
    const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
    const HOUR = 3600e3;
    const night = shiftWindowAt({ start: "00:00", end: "07:00" }, at(6, 0));
    const day = shiftWindowAt({ start: "07:00", end: "16:00" }, at(22, 0));
    const overnight = shiftWindowAt({ start: "22:00", end: "06:00" }, at(2, 0));
    return {
      nightLen: (night.end - night.start) / HOUR,
      nightStartsToday: night.start === at(0, 0),
      dayLen: (day.end - day.start) / HOUR,
      dayIsMostRecent: day.start === at(7, 0),
      overnightLen: (overnight.end - overnight.start) / HOUR,
      overnightStartedYesterday: overnight.start === at(22, 0) - 24 * HOUR,
    };
  });
  assert(win.nightLen === 7, `night shift window should be 7h, got ${win.nightLen}`);
  assert(win.nightStartsToday, "night window should start at today's 00:00");
  assert(win.dayLen === 9, `day shift window should be 9h, got ${win.dayLen}`);
  assert(win.dayIsMostRecent, "a shift that already ended should resolve to its most recent occurrence");
  assert(win.overnightLen === 8, `overnight window should be 8h, got ${win.overnightLen}`);
  assert(win.overnightStartedYesterday, "an overnight shift at 02:00 should have started yesterday");

  // A stop from >24h ago can never be inside the window, so it must not count
  // toward this shift — and "Show all" must not drag it into the stats.
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const url = route.request().url();
    if (url.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (url.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await p2.addInitScript(() => {
    const now = Date.now(), DAY = 86400e3;
    // Pin a shift that definitely CONTAINS now (started 1h ago, runs 8h), so the
    // assertions below don't depend on what time CI happens to run at.
    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    localStorage.setItem("config:lists", JSON.stringify({
      machines: ["Line 1"], reasons: ["Cleaning", "Material jam"], quickStops: [],
      shifts: [{ id: "t1", name: "Test", start: hhmm(now - 3600e3), end: hhmm(now + 7 * 3600e3), goals: {} }],
      rates: {}, handoverEmails: [], updatedAt: now,
    }));
    const stop = (id, ago, dur) => localStorage.setItem(`stop:${id}`, JSON.stringify({
      id, machine: "Line 1", operator: "Alice", start: now - ago, end: now - ago + dur,
      duration: dur, reason: "Cleaning", notes: "", discarded: false,
      loggedAt: now - ago, updatedAt: now - ago,
    }));
    stop("old-1", 25 * 3600e3, 45 * 60e3);  // yesterday — outside any window
    stop("cur-1", 5e3, 60e3);               // this shift (5s ago: never straddles the window edge)
    // A presence span left open since yesterday — exactly what credited an
    // operator with 21 hours of manned time on one machine.
    localStorage.setItem("sess:stale-1", JSON.stringify({
      id: "stale-1", kind: "session", operator: "Alice", machine: "Line 1",
      start: now - 30 * 3600e3, end: null, loggedAt: now - 30 * 3600e3, updatedAt: now,
    }));
    localStorage.setItem("config:prefs", JSON.stringify({ operator: "Alice", setupLocked: true, machine: "Line 1" }));
  });
  await p2.goto("file://" + path.join(root, "index.html"));
  await p2.waitForSelector("text=Start Stop", { timeout: 20000 });

  const statStops = async () => (await p2
    .locator("div.rounded-xl.p-3.text-center", { hasText: "Stops" })
    .first().locator("div.font-bold").innerText()).trim();
  const listCount = async () => p2.locator("text=Cleaning").count();

  assert(await statStops() === "1", `only the in-shift stop should count, saw ${await statStops()}`);
  const listBefore = await listCount();

  await p2.click("text=Show all");
  await p2.waitForTimeout(300);
  assert(await statStops() === "1",
    `"Show all" must not change the shift stats (it corrupts the handout) — saw ${await statStops()}`);
  const listAfter = await listCount();
  assert(listAfter > listBefore, `"Show all" should still reveal older stops in the list (${listBefore} -> ${listAfter})`);

  // A 30-hour-old open presence span must NOT become 30 hours of manned time.
  // This is the regression guard for the reported "21 hours on one machine" —
  // without it, reverting the apportioning still passes every other assertion.
  const manned = await p2.evaluate(() => {
    const chips = [...document.querySelectorAll("span")]
      .map((el) => el.textContent || "")
      .filter((txt) => /^Line 1 · \d/.test(txt.trim()));
    const parse = (txt) => {
      let ms = 0;
      for (const m of String(txt).matchAll(/(\d+)\s*([hms])/g)) {
        const n = Number(m[1]);
        ms += m[2] === "h" ? n * 3600e3 : m[2] === "m" ? n * 60e3 : n * 1000;
      }
      return ms;
    };
    return chips.map((c) => ({ text: c.trim(), ms: parse(c.split("·")[1] || "") }));
  });
  // The chip must actually be on screen, or this assertion guards nothing.
  assert(manned.length > 0, "expected a machines-worked chip for the seeded session");
  // The pinned shift started 1h ago. A 30h-old open span must therefore report
  // ~1h of manned time, never 30h.
  for (const chip of manned) {
    assert(chip.ms > 0.5 * 3600e3 && chip.ms < 1.5 * 3600e3,
      `manned time should be the ~1h shift elapsed so far, not the 30h span length — got ${chip.text}`);
  }

  await ctx2.close();

  // With NO presence sessions at all, the app must not invent manned time — a
  // fresh install briefly claimed a full shift on the default machine, which then
  // travelled into the handout the supervisor receives.
  const ctx3 = await browser.newContext();
  const p3 = await ctx3.newPage();
  await p3.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const url = route.request().url();
    if (url.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (url.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await p3.addInitScript(() => {
    const now = Date.now();
    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    localStorage.setItem("config:lists", JSON.stringify({
      machines: ["Line 1"], reasons: ["Cleaning"], quickStops: [],
      shifts: [{ id: "t1", name: "Test", start: hhmm(now - 3600e3), end: hhmm(now + 7 * 3600e3), goals: {} }],
      rates: {}, handoverEmails: [], updatedAt: now,
    }));
    // Deliberately NO prefs: a locked setup opens a presence session on load,
    // which would make this no longer a fresh install.
  });
  await p3.goto("file://" + path.join(root, "index.html"));
  await p3.waitForSelector("text=Start Stop", { timeout: 20000 });
  const fabricated = await p3.evaluate(() => [...document.querySelectorAll("span")]
    .map((el) => (el.textContent || "").trim())
    .filter((txt) => /^\S.*·\s*\d+h/.test(txt) && /Line|Packaging|Assembly/.test(txt)));
  assert(fabricated.length === 0,
    `a fresh install with no sessions must show no manned time, saw ${JSON.stringify(fabricated)}`);
  await ctx3.close();

  // ---- end-to-end against a REAL server ------------------------------------
  // The two test layers above can BOTH pass while the feature is dead: the server
  // test posts a payload written by hand, and the web test only checks the outbox.
  // If the client and server disagreed on the route or the payload key, nothing
  // would notice. So drive the built index.html against a live server.js.
  const srvDir = mkdtempSync(path.join(tmpdir(), "stoptrack-e2e-"));
  const srvPort = 20000 + Math.floor(Math.random() * 20000);
  const srvToken = "e2e-token";
  const srv = spawn(process.execPath, [path.join(root, "server", "server.js")], {
    env: { ...process.env, FACTORY_TOKEN: srvToken, PORT: String(srvPort), DATA_DIR: srvDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not start")), 10000);
      srv.stdout.on("data", (c) => { if (/READY/.test(String(c))) { clearTimeout(t); resolve(); } });
      srv.on("error", reject);
    });
    const srvUrl = `http://127.0.0.1:${srvPort}`;

    const ctx4 = await browser.newContext();
    const p4 = await ctx4.newPage();
    await p4.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
      const u = route.request().url();
      if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
      if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
      return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
    });
    await p4.addInitScript(installMockNative);
    await p4.addInitScript(([url, token]) => {
      localStorage.setItem("config:sync", JSON.stringify({ url, token, enabled: true }));
    }, [srvUrl, srvToken]);
    await p4.goto("file://" + path.join(root, "index.html"));
    await p4.waitForSelector("text=Start Stop", { timeout: 20000 });

    await p4.fill('input[placeholder="Your name"]', "Dana");
    await p4.click("text=Handover");
    await p4.waitForSelector("text=MESSAGE FOR THE NEXT SHIFT", { timeout: 5000 });
    await p4.fill("textarea", "Guard rail needs a look before the next run.");
    await p4.fill('input[placeholder="e.g. Asla 2 coolant low"]', "Guard rail worn");
    await p4.click("text=Add");
    await p4.waitForSelector('img[alt="Shift handout"]', { timeout: 8000 });
    await p4.click("text=Save image");

    // Poll the server until the handover arrives (the app flushes on save).
    let arrived = null;
    for (let i = 0; i < 40 && !arrived; i++) {
      const r = await fetch(`${srvUrl}/handovers?since=0`, { headers: { Authorization: `Bearer ${srvToken}` } })
        .then((x) => x.json()).catch(() => ({ records: [] }));
      arrived = (r.records || []).find((h) => h.operator === "Dana");
      if (!arrived) await new Promise((r2) => setTimeout(r2, 500));
    }
    assert(arrived, "the handover never reached the server — client and server disagree on the route or payload key");
    assert(/guard rail/i.test(arrived.note || ""), `the operator's message must reach the server, got ${JSON.stringify(arrived.note)}`);
    assert((arrived.flags || []).some((f) => /guard rail worn/i.test(f.text)),
      `the operator's flags must reach the server, got ${JSON.stringify(arrived.flags)}`);
    await ctx4.close();
    console.log("web-e2e: PASS — handout reached a live server.js end to end (route + payload key agree)");
  } finally {
    srv.kill();
    rmSync(srvDir, { recursive: true, force: true });
  }

  await browser.close();
  console.log("web-e2e: PASS — stop recorded immediately (operator=Alice, reason=" + chosenReason + ", duration=" + rec.duration + "ms)");
  console.log("web-e2e: PASS — shift window is clock-derived (7h/9h/8h incl. overnight); Show all reveals stops without inflating the stats");
  console.log(`web-e2e: PASS — handout rendered ${shot.w}x${shot.h} PNG, shared via native, filed with note + ${h.flags.length} operator flag(s)`);
}

main().catch((e) => { console.error("web-e2e: FAIL —", e.message); process.exit(1); });
