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
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from "fs";
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

// A fresh origin with the CDN stubs already routed and an optional seed — the
// same six lines the blocks below repeat inline. Used by the newer blocks so
// their assertions aren't buried in boilerplate; the older ones are left spelled
// out. No mock shell here: every block that uses it is the plain-browser path.
async function newApp(browser, { seed } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  if (seed) await page.addInitScript(seed);
  await page.goto("file://" + path.join(root, "index.html"));
  return { ctx, page };
}

// Poll a page predicate until it holds, instead of sleeping a fixed amount. It
// deliberately RETURNS rather than throwing on timeout, so the caller still owns
// the assertion message — a bare waitForFunction fails with a Playwright timeout
// that says nothing about the behaviour under test.
async function until(page, fn, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    // A poll can land mid-navigation — the restore flow reloads the page on
    // purpose — and Playwright then throws "Execution context was destroyed".
    // That is a retry, not a result: swallow it and keep polling until the
    // deadline, or the caller sees a crash instead of its own assertion message.
    let v;
    try {
      v = await page.evaluate(fn);
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await page.waitForTimeout(100);
      continue;
    }
    if (v || Date.now() > deadline) return v;
    await page.waitForTimeout(50);
  }
}

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

  // ---- handout for a ROAMING operator --------------------------------------
  // The handout used to be one blended total: three machines, one downtime
  // number, so every machine appeared to have had the exact same downtime and
  // the next shift couldn't tell which one was actually in trouble.
  const ctxRoam = await browser.newContext();
  const pRoam = await ctxRoam.newPage();
  await pRoam.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  // Route "Save image" through the mock shell: the plain-browser fallback is an
  // anchor download, which tears down the page's execution context mid-test.
  await pRoam.addInitScript(installMockNative);
  await pRoam.addInitScript(() => {
    const now = Date.now();
    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    localStorage.setItem("config:lists", JSON.stringify({
      machines: ["Line 1", "Line 2", "Line 3"],
      reasons: ["Mechanical fault", "Cleaning", "Material jam"], quickStops: [],
      shifts: [{ id: "t1", name: "Test", start: hhmm(now - 3600e3), end: hhmm(now + 7 * 3600e3), goals: {} }],
      rates: {}, handoverEmails: [], updatedAt: now,
    }));
    localStorage.setItem("config:prefs", JSON.stringify({ operator: "Cara", setupLocked: true, machine: "Line 1" }));
    // Deliberately UNEQUAL downtime per machine — the whole point.
    const stop = (id, machine, ago, dur, reason) => localStorage.setItem(`stop:${id}`, JSON.stringify({
      id, machine, operator: "Cara", start: now - ago, end: now - ago + dur, duration: dur,
      reason, notes: "", discarded: false, loggedAt: now - ago, updatedAt: now - ago,
    }));
    stop("r1", "Line 1", 30 * 60e3, 20 * 60e3, "Mechanical fault");
    stop("r2", "Line 1", 20 * 60e3, 10 * 60e3, "Cleaning");
    stop("r3", "Line 2", 15 * 60e3, 5 * 60e3, "Material jam");
    stop("r4", "Line 3", 10 * 60e3, 60e3, "Cleaning");
    // Presence on all three, so the roaming (hasSessions) path is exercised.
    // Deliberately INVERTED against downtime — the machine with the least
    // downtime (Line 3) gets the most manned time. The rows arrive sorted by
    // manned time, so "worst first" only holds if the handout re-sorts by
    // downtime; without this the ordering assertion passes for free.
    const sess = (id, machine, fromAgo, toAgo) => localStorage.setItem(`sess:${id}`, JSON.stringify({
      id, kind: "session", operator: "Cara", machine,
      start: now - fromAgo * 60e3, end: now - toAgo * 60e3, loggedAt: now, updatedAt: now,
    }));
    sess("s1", "Line 1", 50, 45);   //  5 min manned, most downtime
    sess("s2", "Line 2", 45, 35);   // 10 min manned
    sess("s3", "Line 3", 35, 5);    // 30 min manned, least downtime
  });
  await pRoam.goto("file://" + path.join(root, "index.html"));
  await pRoam.waitForSelector("text=Start Stop", { timeout: 20000 });

  await pRoam.click("text=Handover");
  await pRoam.waitForSelector("text=MESSAGE FOR THE NEXT SHIFT", { timeout: 5000 });
  await pRoam.waitForSelector('img[alt="Shift handout"]', { timeout: 8000 });

  // The handout must carry a per-machine split with the REAL, different numbers.
  await pRoam.click("text=Save image");
  await pRoam.waitForTimeout(400);
  const filed = await pRoam.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("hand:")) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
    }
    return null;
  });
  assert(filed, "the roaming handover must be filed");
  const ms = filed.machineStats || [];
  assert(ms.length === 3, `the handout must break down all 3 machines, got ${ms.length}`);

  const by = Object.fromEntries(ms.map((m) => [m.machine, m]));
  assert(by["Line 1"].downtimeMs === 30 * 60e3, `Line 1 downtime wrong: ${by["Line 1"].downtimeMs}`);
  assert(by["Line 2"].downtimeMs === 5 * 60e3, `Line 2 downtime wrong: ${by["Line 2"].downtimeMs}`);
  assert(by["Line 3"].downtimeMs === 60e3, `Line 3 downtime wrong: ${by["Line 3"].downtimeMs}`);

  // The actual reported bug: identical numbers across machines.
  const distinct = new Set(ms.map((m) => m.downtimeMs));
  assert(distinct.size === 3,
    `each machine must carry ITS OWN downtime — got ${JSON.stringify(ms.map((m) => [m.machine, m.downtimeMs]))}`);
  assert(by["Line 1"].stops === 2 && by["Line 2"].stops === 1,
    "per-machine stop counts must be split too");
  assert(by["Line 1"].topReason === "Mechanical fault",
    `the worst reason must be per-machine, got ${by["Line 1"].topReason}`);
  assert(ms[0].machine === "Line 1", "worst machine must come first so the next shift sees it");

  // Worst-first ordering and the machine section must reach the IMAGE, not just
  // the record: with >1 machine the canvas is taller than the same shift drawn
  // as a single machine.
  const heights = await pRoam.evaluate(() => {
    const base = {
      operator: "Cara", machine: "Line 1", shiftName: "Test",
      windowStart: Date.now() - 3600e3, windowEnd: Date.now(),
      stopCount: 4, downtimeMs: 36 * 60e3, topReasons: [["Mechanical fault", 20 * 60e3]],
      longest: { machine: "Line 1", reason: "Mechanical fault", duration: 20 * 60e3, start: Date.now() - 1800e3 },
      hasSessions: true, oee: { a: 0.8, p: null, q: null, oee: 0.8, partial: true },
      goal: null, notes: [], note: "", flags: [],
    };
    const mk = (n) => Array.from({ length: n }, (_, i) => ({
      machine: `Line ${i + 1}`, mannedMs: 600000, downtimeMs: 600000 - i * 1000,
      stops: 1, units: 0, scrap: 0, topReason: "Cleaning", topReasonMs: 1000,
    }));
    return [
      drawHandout(handoutViewModel({ ...base, machines: mk(1) }), 1).height,
      drawHandout(handoutViewModel({ ...base, machines: mk(3) }), 1).height,
    ];
  });
  // Three machine rows' worth of extra canvas: proof the section is actually
  // drawn, not just present in the record.
  assert(heights[1] - heights[0] >= 3 * 32,
    `the rendered handout must gain a per-machine section when roaming (1 machine: ${heights[0]}px, 3: ${heights[1]}px)`);
  await ctxRoam.close();

  // ---- off machine ---------------------------------------------------------
  // Stepping away from every machine is DOWNTIME on the machine that was left:
  // this equipment only produces while it runs, and only runs with someone at
  // it. So the button must write an ordinary stop — not a new bucket that the
  // stats, exports and handout would all have to learn about separately.
  // No mock native here: this is the plain-browser path.
  const ctxOff = await browser.newContext();
  const pOff = await ctxOff.newPage();
  await pOff.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await pOff.addInitScript(() => {
    const now = Date.now();
    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    // Seed ONLY on a fresh origin: addInitScript re-runs on every navigation,
    // so an unguarded write would re-seed on reload and clobber exactly the
    // state the persistence assertions below are trying to observe.
    if (!localStorage.getItem("config:lists")) {
      localStorage.setItem("config:lists", JSON.stringify({
        machines: ["Line 1", "Line 2"],
        // "No operator" is deliberately NOT in this list: an existing supervisor's
        // reasons must not need editing for the button to work.
        reasons: ["Cleaning", "Material jam"], quickStops: [],
        shifts: [{ id: "t1", name: "Test", start: hhmm(now - 3600e3), end: hhmm(now + 7 * 3600e3), goals: {} }],
        rates: {}, handoverEmails: [], updatedAt: now,
      }));
      localStorage.setItem("config:prefs", JSON.stringify({ operator: "Bob", setupLocked: true, machine: "Line 1" }));
    }
  });
  await pOff.goto("file://" + path.join(root, "index.html"));
  await pOff.waitForSelector("text=Start Stop", { timeout: 20000 });

  const offStops = () => pOff.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("stop:")) { try { out.push(JSON.parse(localStorage.getItem(k))); } catch { /* skip */ } }
    }
    return out.sort((a, b) => a.start - b.start);
  });
  assert((await offStops()).length === 0, "the off-machine phase must start with no stops");

  const offBtn = pOff.locator('button:has-text("Off machine")');
  assert(await offBtn.count() === 1, "the operator view must offer an 'Off machine' button");

  await offBtn.click();
  await pOff.waitForSelector('button:has-text("Back on Line 1")', { timeout: 5000 });

  // While off machine the stop timer must be unavailable: those minutes are
  // ALREADY being counted as downtime, so timing a stop would double-count them.
  const startDisabled = await pOff.locator('button:has-text("Start Stop")').isDisabled();
  assert(startDisabled, "Start Stop must be disabled while off machine (it would double-count the downtime)");

  await pOff.waitForTimeout(1200); // clear the sub-second mistap guard
  await pOff.click('button:has-text("Back on Line 1")');
  await pOff.waitForSelector('button:has-text("Off machine")', { timeout: 5000 });

  const afterFirst = await offStops();
  assert(afterFirst.length === 1, `returning to the machine must record exactly 1 stop, got ${afterFirst.length}`);
  const off1 = afterFirst[0];
  assert(off1.reason === "No operator", `off-machine stop reason should be "No operator", got ${JSON.stringify(off1.reason)}`);
  assert(off1.offMachine === true, "the record must be flagged offMachine so exports can label it");
  assert(off1.machine === "Line 1", `off-machine downtime belongs to the machine that was left, got ${off1.machine}`);
  assert(off1.operator === "Bob", `off-machine stop attribution wrong, got ${off1.operator}`);
  assert(off1.duration >= 1000, `off-machine duration should cover the away time, got ${off1.duration}`);
  assert(off1.discarded === false, "off-machine stop should not be discarded");

  // It must reach the operator's live board as downtime — the whole point is
  // that this needs no separate accounting.
  const offStatStops = (await pOff
    .locator("div.rounded-xl.p-3.text-center", { hasText: "Stops" })
    .first().locator("div.font-bold").innerText()).trim();
  assert(offStatStops === "1", `off-machine time must count on the operator's board, saw ${offStatStops}`);

  // Coming back by tapping a DIFFERENT machine is the same gesture. The stop
  // still belongs to the machine that was LEFT (easy to get backwards), and the
  // operator lands on the new one.
  await pOff.click('button:has-text("Off machine")');
  await pOff.waitForSelector('button:has-text("Back on Line 1")', { timeout: 5000 });
  await pOff.waitForTimeout(1200);
  await pOff.click('button:has-text("Line 2")');
  await pOff.waitForSelector('button:has-text("Off machine")', { timeout: 5000 });

  const afterSecond = await offStops();
  assert(afterSecond.length === 2, `tapping another machine must also close the span, got ${afterSecond.length} stops`);
  const off2 = afterSecond[1];
  assert(off2.machine === "Line 1",
    `the stop belongs to the machine left, not the one returned to — got ${off2.machine}`);
  const landedOn = await pOff.locator('button.bg-emerald-500:has-text("Line 2")').count();
  assert(landedOn === 1, "tapping Line 2 to come back must leave the operator on Line 2");

  // A sub-second mistap is not a stop.
  const beforeMistap = (await offStops()).length;
  await pOff.click('button:has-text("Off machine")');
  await pOff.click('button:has-text("Back on Line 2")');
  await pOff.waitForTimeout(300);
  assert((await offStops()).length === beforeMistap, "a sub-second mistap must not record a stop");

  // Off machine must be unavailable WHILE a stop is being timed — the converse
  // of the check above, and the other half of the double-counting guard.
  await pOff.click("text=Start Stop");
  await pOff.waitForSelector("text=End Stop", { timeout: 5000 });
  assert(await pOff.locator('button:has-text("Off machine")').count() === 0,
    "Off machine must not be offered while a stop is being timed (it would double-count)");
  await pOff.click("text=End Stop");
  await pOff.waitForSelector("text=Document this stop", { timeout: 5000 });
  assert(await pOff.locator('button:has-text("Off machine")').count() === 0,
    "Off machine must not be offered while a stop is awaiting a reason");

  // Discard sits a thumb's width from "Save stop" and throws away an already
  // measured stop with no undo, so ONE tap must not be enough.
  await pOff.click('button:has-text("Discard")');
  await pOff.waitForTimeout(150);
  assert(await pOff.locator("text=Document this stop").count() === 1,
    "one tap on Discard must not throw a measured stop away — it has to confirm first");
  await pOff.click('button:has-text("Discard stop")');

  // BLOCKER regression: prefs are saved as ONE replaced blob, so an unrelated
  // prefs write (the dark-mode toggle, always on screen) used to erase the open
  // span — the operator's away time vanished on the next reload.
  await pOff.waitForSelector('button:has-text("Off machine")', { timeout: 5000 });
  await pOff.click('button:has-text("Off machine")');
  await pOff.waitForSelector('button:has-text("Back on")', { timeout: 5000 });
  await pOff.click('button[aria-label="Toggle theme"]');
  await pOff.waitForTimeout(200);
  const prefsAfterOtherWrite = await pOff.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}"); } catch { return {}; }
  });
  assert(prefsAfterOtherWrite.offMachine && prefsAfterOtherWrite.offMachine.start,
    `an unrelated prefs write must not erase the open span, prefs were ${JSON.stringify(prefsAfterOtherWrite)}`);

  await pOff.reload();
  await pOff.waitForSelector("text=Start Stop", { timeout: 20000 });
  assert(await pOff.locator('button:has-text("Back on")').count() === 1,
    "an open off-machine span must survive a reload");

  // MAJOR regression: "New Shift" moves the shift cutoff to now. The
  // drop-if-older-than-the-shift rule is for spans RESTORED from an earlier
  // shift — it must not discard a LIVE span, or an operator who taps New Shift
  // on returning from break silently loses the whole break.
  await pOff.click("text=New Shift");
  await pOff.click("text=Start new shift");
  await pOff.waitForTimeout(400);
  assert(await pOff.locator('button:has-text("Back on")').count() === 1,
    "New Shift must not discard a live off-machine span");

  // Locking the setup is the "I'm working" signal and normally opens a presence
  // span. While off machine it must NOT — that would put manned time on a
  // machine the operator isn't standing at, which is the bug the sessions
  // rework exists to kill.
  const openSpans = async () => pOff.evaluate(() => {
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith("sess:")) continue;
      try { if (JSON.parse(localStorage.getItem(k)).end == null) n++; } catch { /* skip */ }
    }
    return n;
  });
  await pOff.click('button:has-text("Unlock name")');
  await pOff.click('button:has-text("Lock name")');
  await pOff.waitForTimeout(300);
  assert(await openSpans() === 0,
    "locking the setup while off machine must not open presence on a machine the operator isn't at");
  await ctxOff.close();

  // A span restored from BEFORE the current shift is dropped, not recorded: the
  // app can't know when the operator came back, so inventing that duration would
  // put fabricated downtime on the board.
  const ctxStale = await browser.newContext();
  const pStale = await ctxStale.newPage();
  await pStale.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await pStale.addInitScript(() => {
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
    localStorage.setItem("config:prefs", JSON.stringify({
      operator: "Bob", setupLocked: true, machine: "Line 1",
      // opened 30 hours ago — before any current shift window
      offMachine: { machine: "Line 1", operator: "Bob", start: now - 30 * 3600e3 },
    }));
  });
  await pStale.goto("file://" + path.join(root, "index.html"));
  await pStale.waitForSelector("text=Start Stop", { timeout: 20000 });
  await pStale.waitForTimeout(400);
  assert(await pStale.locator('button:has-text("Back on")').count() === 0,
    "a span restored from before the current shift must be dropped");
  const staleStops = await pStale.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("stop:")) out.push(k);
    }
    return out;
  });
  assert(staleStops.length === 0,
    `a stale span must be dropped WITHOUT inventing downtime, got ${staleStops.length} stop(s)`);
  await ctxStale.close();

  // A long span asks before it lands hours of downtime on a machine — the one
  // way this button can invent a big number, and (unlike a manual report) the
  // operator never typed the duration. "Discard" must record NOTHING.
  const ctxLong = await browser.newContext();
  const pLong = await ctxLong.newPage();
  await pLong.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await pLong.addInitScript(() => {
    const now = Date.now();
    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    if (!localStorage.getItem("config:lists")) {
      localStorage.setItem("config:lists", JSON.stringify({
        machines: ["Line 1"], reasons: ["Cleaning"], quickStops: [],
        shifts: [{ id: "t1", name: "Test", start: hhmm(now - 6 * 3600e3), end: hhmm(now + 2 * 3600e3), goals: {} }],
        rates: {}, handoverEmails: [], updatedAt: now,
      }));
      localStorage.setItem("config:prefs", JSON.stringify({
        operator: "Bob", setupLocked: true, machine: "Line 1",
        // opened 2h ago — inside the shift, so it is kept, but long enough to ask
        offMachine: { machine: "Line 1", operator: "Bob", start: now - 2 * 3600e3 },
      }));
    }
  });
  await pLong.goto("file://" + path.join(root, "index.html"));
  await pLong.waitForSelector("text=Start Stop", { timeout: 20000 });
  await pLong.waitForSelector('button:has-text("Back on Line 1")', { timeout: 5000 });

  await pLong.click('button:has-text("Back on Line 1")');
  await pLong.waitForSelector("text=of downtime?", { timeout: 5000 });
  // `text=Discard` also matches the prose inside the dialog — target the button.
  await pLong.click('button:has-text("Discard")');
  await pLong.waitForSelector("text=of downtime?", { state: "detached", timeout: 5000 });

  const longStops = await pLong.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("stop:")) out.push(k);
    }
    return out;
  });
  assert(longStops.length === 0,
    `discarding a long span must record nothing, got ${longStops.length} stop(s)`);
  assert(await pLong.locator('button:has-text("Back on")').count() === 0,
    "discarding must also close the span");
  await ctxLong.close();

  // …and if they DO consent, the number logged must be the number they were shown.
  // The dialog rendered once while the save recomputed Date.now(), so every second
  // spent reading it was added to the machine's downtime after the fact.
  const ctxFreeze = await browser.newContext();
  const pFreeze = await ctxFreeze.newPage();
  await pFreeze.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await pFreeze.addInitScript(() => {
    const now = Date.now();
    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    localStorage.setItem("config:lists", JSON.stringify({
      machines: ["Line 1"], reasons: ["Cleaning"], quickStops: [],
      shifts: [{ id: "t1", name: "Test", start: hhmm(now - 6 * 3600e3), end: hhmm(now + 2 * 3600e3), goals: {} }],
      rates: {}, handoverEmails: [], updatedAt: now,
    }));
    localStorage.setItem("config:prefs", JSON.stringify({
      operator: "Bob", setupLocked: true, machine: "Line 1",
      offMachine: { machine: "Line 1", operator: "Bob", start: now - 2 * 3600e3 },
    }));
  });
  await pFreeze.goto("file://" + path.join(root, "index.html"));
  await pFreeze.waitForSelector('button:has-text("Back on Line 1")', { timeout: 20000 });
  const freezeStart = await pFreeze.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:prefs")).offMachine.start; } catch { return 0; }
  });
  const tapAt = Date.now();
  await pFreeze.click('button:has-text("Back on Line 1")');
  await pFreeze.waitForSelector("text=of downtime?", { timeout: 5000 });
  const shownDur = ((await pFreeze.locator("text=of downtime?").first().innerText()).match(/Log (.+) of downtime/) || [])[1];
  assert(shownDur, "the confirmation must state the duration it's about to log");
  // Long enough that a recomputed Date.now() would visibly disagree.
  await pFreeze.waitForTimeout(4000);
  await pFreeze.click('button:has-text("Yes, log it")');
  await pFreeze.waitForSelector("text=of downtime?", { state: "detached", timeout: 5000 });
  const frozen = await pFreeze.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("stop:")) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
    }
    return null;
  });
  assert(frozen, "consenting must record the stop");
  assert(frozen.duration <= (tapAt - freezeStart) + 1500,
    `the logged duration must be frozen at the tap, not recomputed on confirm (shown ${shownDur}, logged ${frozen.duration}ms vs ${tapAt - freezeStart}ms at the tap)`);
  const loggedDur = await pFreeze.evaluate((d) => fmtDur(d), frozen.duration);
  assert(loggedDur === shownDur,
    `what's logged must read the same as what was shown: shown "${shownDur}", logged "${loggedDur}"`);
  await ctxFreeze.close();

  // Shell path: a stop started from the notification/bubble knows nothing about
  // off-machine. It must not run on top of an open span, or every minute of it
  // is billed twice as downtime on the same machine.
  const ctxShell = await browser.newContext();
  const pShell = await ctxShell.newPage();
  await pShell.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await pShell.addInitScript(installMockNative);
  await pShell.addInitScript(() => {
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
    localStorage.setItem("config:prefs", JSON.stringify({ operator: "Bob", setupLocked: true, machine: "Line 1" }));
  });
  await pShell.goto("file://" + path.join(root, "index.html"));
  await pShell.waitForSelector("text=Start Stop", { timeout: 20000 });

  await pShell.click('button:has-text("Off machine")');
  await pShell.waitForSelector('button:has-text("Back on Line 1")', { timeout: 5000 });
  await pShell.waitForTimeout(1200);
  // Start a stop the way the notification does — bypassing this view entirely.
  await pShell.evaluate(() => window.StopTrackNative.startStop("Line 1"));
  await pShell.waitForSelector("text=End Stop", { timeout: 5000 });
  await pShell.waitForTimeout(600);
  await pShell.click("text=End Stop");
  await pShell.waitForSelector("text=Document this stop", { timeout: 5000 });
  await pShell.click("text=Save stop");
  await pShell.waitForSelector("text=Document this stop", { state: "detached", timeout: 5000 });

  const shellRecs = await pShell.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("stop:")) { try { out.push(JSON.parse(localStorage.getItem(k))); } catch { /* skip */ } }
    }
    return out.sort((a, b) => a.start - b.start);
  });
  assert(shellRecs.length === 2,
    `a native stop must close the span and both must be recorded, got ${shellRecs.length}`);
  const overlap = Math.max(0,
    Math.min(shellRecs[0].end, shellRecs[1].end) - Math.max(shellRecs[0].start, shellRecs[1].start));
  assert(overlap === 0,
    `off-machine and the native stop must not overlap — ${overlap}ms is double-counted downtime`);
  assert(await pShell.locator('button:has-text("Back on")').count() === 0,
    "the span must be closed once a native stop takes over");
  await ctxShell.close();

  // Cold start from the notification while a stop is ALREADY running: the shell
  // hasn't pushed its state yet, so `nativeTimer` is still null. An unknown
  // native timer must count as busy — treating it as idle lets a span open on
  // top of a running stop and double-counts every minute of it.
  const ctxCold = await browser.newContext();
  const pCold = await ctxCold.newPage();
  await pCold.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await pCold.addInitScript(installMockNative);
  await pCold.addInitScript(() => {
    // A stop is already running natively, and the state push is withheld — the
    // real shell answers requestState() asynchronously over the JS bridge.
    const nat = window.StopTrackNative;
    const now = Date.now();
    nat._timer = { running: true, paused: false, startTs: now, accumulatedMs: 0, segStartMs: now, machine: "Line 1" };
    nat.requestState = function () { /* withheld: no push yet */ };
    window.__releaseState = () => { nat.requestState = function () { this._push(); }; nat._push(); };

    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    if (!localStorage.getItem("config:lists")) {
      localStorage.setItem("config:lists", JSON.stringify({
        machines: ["Line 1"], reasons: ["Cleaning"], quickStops: [],
        shifts: [{ id: "t1", name: "Test", start: hhmm(now - 3600e3), end: hhmm(now + 7 * 3600e3), goals: {} }],
        rates: {}, handoverEmails: [], updatedAt: now,
      }));
      localStorage.setItem("config:prefs", JSON.stringify({ operator: "Bob", setupLocked: true, machine: "Line 1" }));
    }
  });
  await pCold.goto("file://" + path.join(root, "index.html"));
  await pCold.waitForSelector("text=Start Stop", { timeout: 20000 });

  // The UI can't know a stop is running yet — but it must not let a span open.
  const coldOffBtn = pCold.locator('button:has-text("Off machine")');
  if (await coldOffBtn.count() > 0) await coldOffBtn.click();
  await pCold.waitForTimeout(200);
  assert(await pCold.locator('button:has-text("Back on")').count() === 0,
    "an off-machine span must not open while the native timer state is still unknown");

  // Once the real state arrives, the running stop is visible and the span never happened.
  await pCold.evaluate(() => window.__releaseState());
  await pCold.waitForSelector("text=End Stop", { timeout: 5000 });
  assert(await pCold.locator('button:has-text("Back on")').count() === 0,
    "no span should exist after the native state resolves to a running stop");
  await ctxCold.close();

  // A failed write must not swallow the operator's away time: the span stays
  // open (clock still running, retry still records it) and says so.
  const ctxFail = await browser.newContext();
  const pFail = await ctxFail.newPage();
  await pFail.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await pFail.addInitScript(() => {
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
    localStorage.setItem("config:prefs", JSON.stringify({ operator: "Bob", setupLocked: true, machine: "Line 1" }));
    // Make every stop write fail, the way a full/blocked storage quota does.
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).startsWith("stop:")) throw new Error("QuotaExceededError");
      return realSet.call(this, k, v);
    };
  });
  await pFail.goto("file://" + path.join(root, "index.html"));
  await pFail.waitForSelector("text=Start Stop", { timeout: 20000 });

  await pFail.click('button:has-text("Off machine")');
  await pFail.waitForSelector('button:has-text("Back on Line 1")', { timeout: 5000 });
  await pFail.waitForTimeout(1200);
  await pFail.click('button:has-text("Back on Line 1")');
  await pFail.waitForTimeout(500);

  assert(await pFail.locator('button:has-text("Back on Line 1")').count() === 1,
    "a failed save must leave the span OPEN — otherwise the away time is silently lost");
  const failText = await pFail.locator("text=Off machine").first().locator("xpath=../..").innerText();
  // Must tell the operator what to DO, not just echo a storage exception.
  assert(/tap again to retry/i.test(failText),
    `the failure must be visible and actionable in the off-machine banner, saw: ${JSON.stringify(failText)}`);
  await ctxFail.close();

  // ---- an ENDED stop that hasn't been documented yet ------------------------
  // BLOCKER: between "End Stop" and "Save stop" the measured downtime lived only
  // in React state. Timer autosave stopped at that moment (it only writes while
  // running/paused), so a refresh — or Chrome reclaiming a backgrounded tab —
  // threw a real, measured stop away with no recovery prompt at all.
  // Plain-browser path (no mock native: in the shell the pending stop is native's).
  const ctxPend = await browser.newContext();
  const pPend = await ctxPend.newPage();
  await pPend.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await pPend.addInitScript(() => {
    const now = Date.now();
    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    // Seed once: addInitScript re-runs on the reload this test depends on.
    if (!localStorage.getItem("config:lists")) {
      localStorage.setItem("config:lists", JSON.stringify({
        machines: ["Line 1"], reasons: ["Cleaning", "Material jam"], quickStops: [],
        shifts: [{ id: "t1", name: "Test", start: hhmm(now - 3600e3), end: hhmm(now + 7 * 3600e3), goals: {} }],
        rates: {}, handoverEmails: [], updatedAt: now,
      }));
      localStorage.setItem("config:prefs", JSON.stringify({ operator: "Bob", setupLocked: true, machine: "Line 1" }));
    }
  });
  await pPend.goto("file://" + path.join(root, "index.html"));
  await pPend.waitForSelector("text=Start Stop", { timeout: 20000 });

  await pPend.click("text=Start Stop");
  await pPend.waitForSelector("text=End Stop", { timeout: 5000 });
  await pPend.waitForTimeout(1200);
  await pPend.click("text=End Stop");
  await pPend.waitForSelector("text=Document this stop", { timeout: 5000 });
  const shownBefore = (await pPend.locator(".border-emerald-400 .font-mono").first().innerText()).trim();

  // The finished stop must be on disk, flagged as ended — and with NO reason,
  // because End must never invent one.
  const parked = await pPend.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("inprogress:current") || "null"); } catch { return null; }
  });
  assert(parked && parked.ended === true,
    `an ended-but-undocumented stop must be parked in storage, got ${JSON.stringify(parked)}`);
  assert(parked.duration >= 1000, `the parked stop must carry the measured duration, got ${parked.duration}`);
  assert(!parked.reason, "the parked stop must NOT carry an invented reason");
  assert((await pPend.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("stop:")).length)) === 0,
    "nothing may be recorded until the operator documents it");

  // The reload is the whole point.
  await pPend.reload();
  await pPend.waitForSelector("text=Document this stop", { timeout: 20000 });
  const shownAfter = (await pPend.locator(".border-emerald-400 .font-mono").first().innerText()).trim();
  assert(shownAfter === shownBefore,
    `the recovered stop must show the same measured duration (${shownBefore} -> ${shownAfter})`);

  await pPend.click("text=Save stop");
  await pPend.waitForSelector("text=Document this stop", { state: "detached", timeout: 5000 });
  const pendRecs = await pPend.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("stop:")) { try { out.push(JSON.parse(localStorage.getItem(k))); } catch { /* skip */ } }
    }
    return out;
  });
  assert(pendRecs.length === 1, `the recovered stop must record exactly once, got ${pendRecs.length}`);
  assert(pendRecs[0].duration >= 1000, `the recovered duration must survive, got ${pendRecs[0].duration}`);
  assert(pendRecs[0].operator === "Bob", `attribution must survive the reload, got ${pendRecs[0].operator}`);
  assert(pendRecs[0].machine === "Line 1", `the pinned machine must survive, got ${pendRecs[0].machine}`);
  assert((await pPend.evaluate(() => localStorage.getItem("inprogress:current"))) === null,
    "the parked stop must be cleared once it's documented, or it comes back on the next load");
  await ctxPend.close();

  // A storage failure must reach the operator in words they can act on — the raw
  // "QuotaExceededError" used to land in the card, reading like the stop was gone.
  const ctxQuota = await browser.newContext();
  const pQuota = await ctxQuota.newPage();
  await pQuota.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await pQuota.addInitScript(() => {
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
    localStorage.setItem("config:prefs", JSON.stringify({ operator: "Bob", setupLocked: true, machine: "Line 1" }));
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).startsWith("stop:")) { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; }
      return realSet.call(this, k, v);
    };
  });
  await pQuota.goto("file://" + path.join(root, "index.html"));
  await pQuota.waitForSelector("text=Start Stop", { timeout: 20000 });
  await pQuota.click("text=Start Stop");
  await pQuota.waitForTimeout(300);
  await pQuota.click("text=End Stop");
  await pQuota.waitForSelector("text=Document this stop", { timeout: 5000 });
  await pQuota.click("text=Save stop");
  await pQuota.waitForTimeout(400);
  const quotaText = (await pQuota.locator(".border-emerald-400").first().innerText());
  assert(!/QuotaExceededError/.test(quotaText),
    `the operator must not be shown a raw storage exception, saw: ${JSON.stringify(quotaText)}`);
  assert(/storage is full/i.test(quotaText) && /Save again/i.test(quotaText),
    `the failure must say what happened and that a retry works, saw: ${JSON.stringify(quotaText)}`);
  // The stop is still there to retry — nothing was thrown away.
  assert(await pQuota.locator("text=Document this stop").count() === 1,
    "a failed save must keep the stop on screen for a retry");
  await ctxQuota.close();

  // ---- a machine switch must survive a reload -------------------------------
  // MAJOR: switchMachine/chooseMachine never persisted the choice, so a locked
  // operator came back on the OLD machine after a refresh — and the next stop
  // plus the presence span (manned time) were both attributed to the wrong one.
  const ctxMach = await browser.newContext();
  const pMach = await ctxMach.newPage();
  await pMach.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await pMach.addInitScript(() => {
    const now = Date.now();
    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    if (!localStorage.getItem("config:lists")) {
      localStorage.setItem("config:lists", JSON.stringify({
        machines: ["Line 1", "Line 2"], reasons: ["Cleaning"], quickStops: [],
        shifts: [{ id: "t1", name: "Test", start: hhmm(now - 3600e3), end: hhmm(now + 7 * 3600e3), goals: {} }],
        rates: {}, handoverEmails: [], updatedAt: now,
      }));
      localStorage.setItem("config:prefs", JSON.stringify({ operator: "Bob", setupLocked: true, machine: "Line 1" }));
    }
  });
  await pMach.goto("file://" + path.join(root, "index.html"));
  await pMach.waitForSelector("text=Start Stop", { timeout: 20000 });

  await pMach.click('button:has-text("Line 2")');
  await pMach.waitForSelector('button.bg-emerald-500:has-text("Line 2")', { timeout: 5000 });
  const machPrefs = await pMach.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}"); } catch { return {}; }
  });
  assert(machPrefs.machine === "Line 2",
    `a machine switch must be persisted, prefs said ${JSON.stringify(machPrefs.machine)}`);

  await pMach.reload();
  await pMach.waitForSelector("text=Start Stop", { timeout: 20000 });
  assert(await pMach.locator('button.bg-emerald-500:has-text("Line 2")').count() === 1,
    "a locked operator must come back on the machine they switched to, not the old one");

  // The consequence that actually corrupts data: attribution of the next stop …
  await pMach.click("text=Start Stop");
  await pMach.waitForTimeout(300);
  await pMach.click("text=End Stop");
  await pMach.waitForSelector("text=Document this stop", { timeout: 5000 });
  await pMach.click("text=Save stop");
  await pMach.waitForSelector("text=Document this stop", { state: "detached", timeout: 5000 });
  const machRecs = await pMach.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("stop:")) { try { out.push(JSON.parse(localStorage.getItem(k))); } catch { /* skip */ } }
    }
    return out;
  });
  assert(machRecs.length === 1 && machRecs[0].machine === "Line 2",
    `the stop after a reload must belong to the switched-to machine, got ${JSON.stringify(machRecs.map((r) => r.machine))}`);
  // … and the presence span behind manned time.
  const openOn = await pMach.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith("sess:")) continue;
      try { const s = JSON.parse(localStorage.getItem(k)); if (s.end == null) out.push(s.machine); } catch { /* skip */ }
    }
    return out;
  });
  assert(openOn.length === 1 && openOn[0] === "Line 2",
    `manned time after the reload must be on the switched-to machine, got ${JSON.stringify(openOn)}`);
  await ctxMach.close();

  // ---- a retyped name, and the seconds box's own limit ----------------------
  // The board matched the operator name exactly, so "bob" saw 0 stops / 0 downtime
  // for records saved as "Bob" — no hint that the name was the reason. And the
  // seconds input declares max="59" but enforced nothing: 900 became a 15-minute
  // stop nobody typed.
  const ctxName = await browser.newContext();
  const pName = await ctxName.newPage();
  await pName.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
    const u = route.request().url();
    if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
    if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
    return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
  });
  await pName.addInitScript(() => {
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
    // Saved as "Bob"; the operator has retyped it as " bob ".
    localStorage.setItem("stop:n1", JSON.stringify({
      id: "n1", machine: "Line 1", operator: "Bob", start: now - 300e3, end: now - 240e3,
      duration: 60e3, reason: "Cleaning", notes: "", discarded: false, loggedAt: now - 240e3, updatedAt: now - 240e3,
    }));
    localStorage.setItem("sess:n1", JSON.stringify({
      id: "n1", kind: "session", operator: "Bob", machine: "Line 1",
      start: now - 1800e3, end: now - 60e3, loggedAt: now - 1800e3, updatedAt: now - 60e3,
    }));
    localStorage.setItem("config:prefs", JSON.stringify({ operator: " bob ", setupLocked: true, machine: "Line 1" }));
  });
  await pName.goto("file://" + path.join(root, "index.html"));
  await pName.waitForSelector("text=Start Stop", { timeout: 20000 });
  const nameStat = async () => (await pName
    .locator("div.rounded-xl.p-3.text-center", { hasText: "Stops" })
    .first().locator("div.font-bold").innerText()).trim();
  assert(await nameStat() === "1",
    `a retyped name must still find the operator's own stops, board showed ${await nameStat()}`);
  const nameDown = (await pName
    .locator("div.rounded-xl.p-3.text-center", { hasText: "Downtime" })
    .first().locator("div.font-bold").innerText()).trim();
  assert(/1m/.test(nameDown), `downtime must follow too, saw ${JSON.stringify(nameDown)}`);

  // Seconds: type 900 where the field says max 59.
  await pName.click("text=Report a stop manually");
  await pName.waitForSelector("text=For a stop that already happened", { timeout: 5000 });
  const secBox = pName.locator('input[max="59"]');
  await secBox.fill("900");
  assert(await secBox.inputValue() === "59",
    `the seconds box must enforce the 59 it declares, showed ${await secBox.inputValue()}`);
  await pName.click('button:has-text("Save stop")');
  await pName.waitForSelector("text=For a stop that already happened", { state: "detached", timeout: 5000 });
  const manualRec = await pName.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("stop:") && k !== "stop:n1") { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
    }
    return null;
  });
  assert(manualRec && manualRec.duration === 59000,
    `900 in the seconds box must not become a 15-minute stop, recorded ${manualRec && manualRec.duration}ms`);
  await ctxName.close();

  // ---- a second tab must not clobber this one -------------------------------
  // MAJOR: prefs and shared config are each ONE blob that every write REPLACES.
  // A second tab's unrelated write (the dark-mode toggle) reverted this tab: the
  // open off-machine span vanished (real downtime never logged) and the New Shift
  // cutoff came undone (the previous shift's stops re-merged into the new one and
  // inflated it and its handout). Two pages, one browser context = one origin.
  const ctxTabs = await browser.newContext();
  const seedTabs = () => {
    const now = Date.now();
    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    if (!localStorage.getItem("config:lists")) {
      localStorage.setItem("config:lists", JSON.stringify({
        machines: ["Line 1", "Line 2"], reasons: ["Cleaning"], quickStops: [],
        shifts: [{ id: "t1", name: "Test", start: hhmm(now - 3600e3), end: hhmm(now + 7 * 3600e3), goals: {} }],
        rates: {}, handoverEmails: [], updatedAt: now,
      }));
      localStorage.setItem("config:prefs", JSON.stringify({ operator: "Bob", setupLocked: true, machine: "Line 1" }));
    }
  };
  const openTab = async () => {
    const p = await ctxTabs.newPage();
    await p.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
      const u = route.request().url();
      if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
      if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
      return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
    });
    await p.addInitScript(seedTabs);
    await p.goto("file://" + path.join(root, "index.html"));
    await p.waitForSelector("text=Start Stop", { timeout: 20000 });
    return p;
  };
  const tabA = await openTab();
  const tabB = await openTab(); // loaded BEFORE tab A's changes — the stale copy

  await tabA.click('button:has-text("Off machine")');
  await tabA.waitForSelector('button:has-text("Back on Line 1")', { timeout: 5000 });

  // One unrelated write from the other tab — the whole bug.
  await tabB.click('button[aria-label="Toggle theme"]');
  await tabB.waitForTimeout(600);

  const tabPrefs = await tabA.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}"); } catch { return {}; }
  });
  assert(tabPrefs.offMachine && tabPrefs.offMachine.start,
    `another tab's unrelated write must not erase an open off-machine span, prefs were ${JSON.stringify(tabPrefs)}`);
  assert(await tabA.locator('button:has-text("Back on Line 1")').count() === 1,
    "the tab holding the span must still be off machine");

  // The loss only showed on the next load, so that's where it has to be proven.
  await tabA.reload();
  await tabA.waitForSelector("text=Start Stop", { timeout: 20000 });
  assert(await tabA.locator('button:has-text("Back on Line 1")').count() === 1,
    "an open span must survive another tab's write plus a reload — those are real, unlogged downtime minutes");

  // ...and now the OTHER direction, which is the dangerous one. A tab that
  // LOADED during the span restores it into its own state, so both tabs hold it
  // and either can tap "Back on". When tab A closes it, tab B's reconcile sees
  // "no span" — if it re-asserts, the span comes back from the dead and the next
  // return logs the same minutes a SECOND time. Fabricating downtime is worse
  // than the clobber this reconciler prevents, so it gets its own guard.
  await tabB.reload();
  await tabB.waitForSelector("text=Start Stop", { timeout: 20000 });
  assert(await tabB.locator('button:has-text("Back on Line 1")').count() === 1,
    "precondition: a tab loaded during a span must restore it (that's what makes resurrection possible)");

  await tabA.waitForTimeout(1200);
  await tabA.click('button:has-text("Back on Line 1")');
  await tabA.waitForSelector('button:has-text("Off machine")', { timeout: 5000 });
  await tabB.waitForTimeout(1200); // let tab B's storage listener run

  const afterClose = await tabA.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}"); } catch { return {}; }
  });
  assert(!(afterClose.offMachine && afterClose.offMachine.start),
    `a span the other tab already RECORDED must not be written back, got ${JSON.stringify(afterClose.offMachine)}`);
  assert(await tabB.locator('button:has-text("Back on Line 1")').count() === 0,
    "the peer tab must adopt the close, not keep offering to end a span that is already logged");

  const offCount = await tabA.evaluate(() => Object.keys(localStorage)
    .filter((k) => k.startsWith("stop:"))
    .map((k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return {}; } })
    .filter((s) => s.offMachine).length);
  assert(offCount === 1, `the away time must be logged exactly once, found ${offCount} off-machine stops`);

  // Now the cutoff. New Shift is what hides the previous shift's stops; a stale
  // tab writing its old copy used to undo it, re-merging them into the new shift
  // and inflating both the board and the handout. (The span is already closed
  // above: a span RESTORED from before the cutoff is dropped on purpose — see
  // above — so leaving it open here would test that rule instead of this one.)
  await tabA.click("text=New Shift");
  await tabA.click("text=Start new shift");
  await tabA.waitForTimeout(300);
  const cutBefore = await tabA.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}").clearedBefore || 0; } catch { return 0; }
  });
  assert(cutBefore > 0, "New Shift should have written a cutoff");

  await tabB.click('button[aria-label="Toggle theme"]');
  await tabB.waitForTimeout(600);
  const cutAfterWrite = await tabA.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}").clearedBefore || 0; } catch { return 0; }
  });
  assert(cutAfterWrite >= cutBefore,
    `another tab's write must not undo the New Shift cutoff (${cutBefore} -> ${cutAfterWrite})`);
  await tabA.reload();
  await tabA.waitForSelector("text=Start Stop", { timeout: 20000 });
  const cutAfterReload = await tabA.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}").clearedBefore || 0; } catch { return 0; }
  });
  assert(cutAfterReload >= cutBefore,
    `the cutoff must survive a reload too, or the previous shift's stops re-merge (${cutBefore} -> ${cutAfterReload})`);
  const statAfterCut = (await tabA
    .locator("div.rounded-xl.p-3.text-center", { hasText: "Stops" })
    .first().locator("div.font-bold").innerText()).trim();
  assert(statAfterCut === "0",
    `the new shift must start clean — the cleared stop came back, board showed ${statAfterCut}`);

  // Shared config is last-write-wins by updatedAt — a supervisor's edit in one tab
  // must reach the other, or the stale tab's next config write silently drops it.
  // Assert on what tab A actually SHOWS: storage alone would pass without any
  // reconciliation at all, since the other tab just wrote it.
  await tabB.evaluate(() => {
    const cfg = JSON.parse(localStorage.getItem("config:lists"));
    cfg.reasons = ["Cleaning", "Bearing failure"];
    cfg.updatedAt = Date.now();
    localStorage.setItem("config:lists", JSON.stringify(cfg));
  });
  await tabA.waitForTimeout(600);
  await tabA.click("text=Report a stop manually");
  await tabA.waitForSelector("text=For a stop that already happened", { timeout: 5000 });
  const reasonOpts = await tabA.$$eval("option", (els) => els.map((e) => (e.textContent || "").trim()));
  assert(reasonOpts.includes("Bearing failure"),
    `a config edit from another tab must reach this one's reason list, saw ${JSON.stringify(reasonOpts)}`);
  await tabA.click('button:has-text("Cancel")');
  // The away time itself was recorded, once, on the machine that was left.
  const tabStops = await tabA.evaluate(() => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("stop:")) { try { out.push(JSON.parse(localStorage.getItem(k))); } catch { /* skip */ } }
    }
    return out;
  });
  assert(tabStops.length === 1 && tabStops[0].reason === "No operator" && tabStops[0].machine === "Line 1",
    `the away time must be logged exactly once on the machine left, got ${JSON.stringify(tabStops.map((s) => [s.machine, s.reason]))}`);
  await ctxTabs.close();

  // A plain-browser install with two machines and a locked operator — the shape
  // most of the blocks below start from. Seeded ONCE per origin: addInitScript
  // re-runs on every navigation, and these tests all reload to prove persistence.
  const seedPlainBrowser = () => {
    const now = Date.now();
    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    if (!localStorage.getItem("config:lists")) {
      localStorage.setItem("config:lists", JSON.stringify({
        machines: ["Line 1", "Line 2"], reasons: ["Cleaning", "Material jam"], quickStops: [],
        shifts: [{ id: "t1", name: "Test", start: hhmm(now - 3600e3), end: hhmm(now + 7 * 3600e3), goals: {} }],
        rates: {}, handoverEmails: [], updatedAt: now,
      }));
      localStorage.setItem("config:prefs", JSON.stringify({ operator: "Bob", setupLocked: true, machine: "Line 1" }));
    }
  };

  // ---- Discard must actually throw the measured stop away -------------------
  // An ended-but-undocumented stop is now parked in `inprogress:current` so a
  // refresh recovers it (above). Discard therefore HAS to clear that slot: the
  // operator explicitly threw the measurement away, and if it survives, the very
  // next load hands it straight back in the document card — a stop they refused,
  // one tap from being saved as real downtime.
  const { ctx: ctxDisc, page: pDisc } = await newApp(browser, { seed: seedPlainBrowser });
  await pDisc.waitForSelector("text=Start Stop", { timeout: 20000 });
  await pDisc.click("text=Start Stop");
  await pDisc.waitForSelector("text=End Stop", { timeout: 5000 });
  await pDisc.waitForTimeout(1200);
  await pDisc.click("text=End Stop");
  await pDisc.waitForSelector("text=Document this stop", { timeout: 5000 });

  // Precondition: it really is parked, or everything below guards nothing.
  const parkedBeforeDiscard = await until(pDisc, () => {
    try { const ip = JSON.parse(localStorage.getItem("inprogress:current") || "null"); return !!(ip && ip.ended); }
    catch { return false; }
  });
  assert(parkedBeforeDiscard, "precondition: the ended stop must be parked before Discard is tapped");

  // Two taps — Discard sits a thumb's width from Save (asserted above).
  await pDisc.click('button:has-text("Discard")');
  await pDisc.click('button:has-text("Discard stop")');
  await pDisc.waitForSelector("text=Document this stop", { state: "detached", timeout: 5000 });

  await until(pDisc, () => localStorage.getItem("inprogress:current") === null);
  const parkedAfterDiscard = await pDisc.evaluate(() => localStorage.getItem("inprogress:current"));
  assert(parkedAfterDiscard === null,
    `Discard must clear the parked stop, storage still holds ${parkedAfterDiscard}`);

  // The resurrection only shows on the next load, so that's where it's proven.
  await pDisc.reload();
  await pDisc.waitForSelector("text=Start Stop", { timeout: 20000 });
  await pDisc.waitForTimeout(600); // the load path reads storage a microtask after boot
  assert(await pDisc.locator("text=Document this stop").count() === 0,
    "a discarded stop must not come back in the document card on the next load");
  assert(await pDisc.locator("text=Unfinished stop found").count() === 0,
    "a discarded stop must not come back as a recovery prompt either");
  const discRecs = await pDisc.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("stop:")).length);
  assert(discRecs === 0, `discarding must record nothing, found ${discRecs} stop(s)`);
  await ctxDisc.close();

  // ---- a RECOVERED stop, finalized, must survive an interruption too --------
  // Same blocker, the other branch: "Finalize & document now" turns a recovered
  // running stop into an ended-but-undocumented one. It used to CLEAR the
  // autosave slot at that moment, so a refresh before "Save stop" lost the
  // measurement a second time — after the app had already offered to keep it.
  const { ctx: ctxFin, page: pFin } = await newApp(browser, {
    seed: () => {
      const now = Date.now();
      const hhmm = (ms) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      };
      if (!localStorage.getItem("config:lists")) {
        localStorage.setItem("config:lists", JSON.stringify({
          machines: ["Line 1"], reasons: ["Cleaning", "Material jam"], quickStops: [],
          shifts: [{ id: "t1", name: "Test", start: hhmm(now - 3600e3), end: hhmm(now + 7 * 3600e3), goals: {} }],
          rates: {}, handoverEmails: [], updatedAt: now,
        }));
        localStorage.setItem("config:prefs", JSON.stringify({ operator: "Bob", setupLocked: true, machine: "Line 1" }));
        // A stop still RUNNING when the app died: started 5 min ago, last autosave
        // 1 min ago → finalizing banks exactly 4 minutes, and nothing more.
        localStorage.setItem("inprogress:current", JSON.stringify({
          operator: "Bob", machine: "Line 1", running: true, paused: false,
          startTs: now - 300e3, accumulated: 0, segStart: now - 300e3, savedAt: now - 60e3,
        }));
      }
    },
  });
  await pFin.waitForSelector("text=Unfinished stop found", { timeout: 20000 });
  await pFin.click('button:has-text("Finalize")');
  await pFin.waitForSelector("text=Document this stop", { timeout: 5000 });
  const finShown = (await pFin.locator(".border-emerald-400 .font-mono").first().innerText()).trim();

  const parkedFin = await until(pFin, () => {
    try { const ip = JSON.parse(localStorage.getItem("inprogress:current") || "null"); return ip && ip.ended ? ip : null; }
    catch { return null; }
  });
  assert(parkedFin && parkedFin.ended === true,
    `a finalized recovery must be re-parked as an ended stop, storage held ${JSON.stringify(parkedFin)}`);
  assert(!parkedFin.reason, "finalizing must not invent a reason either");
  assert(parkedFin.duration === 240000,
    `the finalized duration must be the banked 4m, got ${parkedFin.duration}`);

  await pFin.reload();
  await pFin.waitForSelector("text=Start Stop", { timeout: 20000 });
  await pFin.waitForTimeout(600);
  assert(await pFin.locator("text=Document this stop").count() === 1,
    "a finalized-but-undocumented stop must be back in the document card after a refresh, not lost");
  assert(await pFin.locator("text=Unfinished stop found").count() === 0,
    "it is finished — it must not ask 'resume or finalize?' all over again");
  const finAfter = (await pFin.locator(".border-emerald-400 .font-mono").first().innerText()).trim();
  assert(finAfter === finShown, `the recovered measurement must be unchanged (${finShown} -> ${finAfter})`);

  await pFin.click("text=Save stop");
  await pFin.waitForSelector("text=Document this stop", { state: "detached", timeout: 5000 });
  const finRecs = await pFin.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("stop:"))
    .map((k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }).filter(Boolean));
  assert(finRecs.length === 1, `the finalized stop must record exactly once, got ${finRecs.length}`);
  assert(finRecs[0].duration === 240000, `the measured 4m must survive the refresh, recorded ${finRecs[0].duration}ms`);
  assert(finRecs[0].operator === "Bob" && finRecs[0].machine === "Line 1",
    `attribution must survive, got ${finRecs[0].operator} / ${finRecs[0].machine}`);
  const finLeftover = await pFin.evaluate(() => localStorage.getItem("inprogress:current"));
  assert(finLeftover === null, "the parked stop must be cleared once documented, or it returns on the next load");
  await ctxFin.close();

  // ---- coming back onto a DIFFERENT machine must stick ----------------------
  // Tapping another machine is a valid way to end an off-machine span, and both
  // exit paths (record it, or discard it) have to persist the new machine in the
  // SAME prefs write that clears the span: persisting before setMachine captured
  // the stale value, and prefs are one replaced blob, so a second write would
  // re-open the span. Only the plain switchMachine path was covered.
  const { ctx: ctxBack, page: pBack } = await newApp(browser, { seed: seedPlainBrowser });
  await pBack.waitForSelector("text=Start Stop", { timeout: 20000 });
  await pBack.click('button:has-text("Off machine")');
  await pBack.waitForSelector('button:has-text("Back on Line 1")', { timeout: 5000 });
  await pBack.waitForTimeout(1200); // clear the sub-second mistap guard
  await pBack.click('button:has-text("Line 2")');
  await pBack.waitForSelector('button:has-text("Off machine")', { timeout: 5000 });

  await until(pBack, () => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}").machine === "Line 2"; } catch { return false; }
  });
  const backPrefs = await pBack.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}"); } catch { return {}; }
  });
  assert(backPrefs.machine === "Line 2",
    `coming back on another machine must persist it, prefs said ${JSON.stringify(backPrefs.machine)}`);
  assert(!(backPrefs.offMachine && backPrefs.offMachine.start),
    `…and the same write must still clear the span, prefs said ${JSON.stringify(backPrefs.offMachine)}`);

  const backStops = await pBack.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("stop:"))
    .map((k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }).filter(Boolean));
  assert(backStops.length === 1 && backStops[0].machine === "Line 1" && backStops[0].reason === "No operator",
    `the away time still belongs to the machine LEFT, got ${JSON.stringify(backStops.map((s) => [s.machine, s.reason]))}`);

  await pBack.reload();
  await pBack.waitForSelector("text=Start Stop", { timeout: 20000 });
  assert(await pBack.locator('button.bg-emerald-500:has-text("Line 2")').count() === 1,
    "after a reload the operator must still be on the machine they came BACK to, not the one they left");
  const backStops2 = await pBack.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("stop:")).length);
  assert(backStops2 === 1, `the reload must not log the away time again, found ${backStops2} stops`);
  await ctxBack.close();

  // The DISCARD exit is a return to a machine too. A >=90-minute span asks first;
  // choosing "Discard" records nothing, but the operator is still standing at the
  // machine they tapped, and the next load has to agree.
  const { ctx: ctxBackD, page: pBackD } = await newApp(browser, {
    seed: () => {
      const now = Date.now();
      const hhmm = (ms) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      };
      if (!localStorage.getItem("config:lists")) {
        localStorage.setItem("config:lists", JSON.stringify({
          machines: ["Line 1", "Line 2"], reasons: ["Cleaning"], quickStops: [],
          shifts: [{ id: "t1", name: "Test", start: hhmm(now - 6 * 3600e3), end: hhmm(now + 2 * 3600e3), goals: {} }],
          rates: {}, handoverEmails: [], updatedAt: now,
        }));
        localStorage.setItem("config:prefs", JSON.stringify({
          operator: "Bob", setupLocked: true, machine: "Line 1",
          // 2h ago: inside the shift, so it's kept, but long enough to ask first.
          offMachine: { machine: "Line 1", operator: "Bob", start: now - 2 * 3600e3 },
        }));
      }
    },
  });
  await pBackD.waitForSelector('button:has-text("Back on Line 1")', { timeout: 20000 });
  await pBackD.click('button:has-text("Line 2")');
  await pBackD.waitForSelector("text=of downtime?", { timeout: 5000 });
  await pBackD.click('button:has-text("Discard")');
  await pBackD.waitForSelector("text=of downtime?", { state: "detached", timeout: 5000 });

  await until(pBackD, () => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}").machine === "Line 2"; } catch { return false; }
  });
  const bdPrefs = await pBackD.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}"); } catch { return {}; }
  });
  assert(bdPrefs.machine === "Line 2",
    `discarding a long span is still a return: the machine tapped must persist, prefs said ${JSON.stringify(bdPrefs.machine)}`);
  const bdStops = await pBackD.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("stop:")).length);
  assert(bdStops === 0, `discarding must still record nothing, got ${bdStops} stop(s)`);

  await pBackD.reload();
  await pBackD.waitForSelector("text=Start Stop", { timeout: 20000 });
  assert(await pBackD.locator('button.bg-emerald-500:has-text("Line 2")').count() === 1,
    "the machine chosen while discarding a long span must survive a reload");
  await ctxBackD.close();

  // ---- a typed machine rate: committed once, and not lost -------------------
  // Typing here used to write config:lists AND PUT /config on EVERY keystroke, so
  // "1200" was four writes — three of them wrong (1, 12, 120), each uploaded, and
  // each briefly the machine's real rate in the OEE maths. It now commits on
  // blur / Enter (and on tab-hide, below).
  const { ctx: ctxRate, page: pRate } = await newApp(browser, { seed: seedPlainBrowser });
  await pRate.waitForSelector("text=Start Stop", { timeout: 20000 });
  await pRate.click('button:has-text("Supervisor")');
  await pRate.click('button:has-text("Settings")');
  await pRate.waitForSelector("text=Machine output rates", { timeout: 5000 });

  const ratesOf = () => pRate.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:lists")).rates || {}; } catch { return {}; }
  });
  const ratesCard = pRate.locator('h3:has-text("Machine output rates")').locator("xpath=..");
  const rate1 = ratesCard.locator('label:has-text("Line 1") input');
  await rate1.click();
  await rate1.pressSequentially("1200", { delay: 30 });
  const midType = await ratesOf();
  assert(midType["Line 1"] === undefined,
    `a rate must not be written per keystroke, storage already held ${JSON.stringify(midType)}`);

  await rate1.press("Tab"); // blur → commit
  await until(pRate, () => {
    try { return (JSON.parse(localStorage.getItem("config:lists")).rates || {})["Line 1"] === 1200; } catch { return false; }
  });
  assert((await ratesOf())["Line 1"] === 1200,
    `blur must commit the typed rate, storage held ${JSON.stringify(await ratesOf())}`);

  // Enter is the other commit, and it does NOT blur — its own path.
  const rate2 = ratesCard.locator('label:has-text("Line 2") input');
  await rate2.click();
  await rate2.pressSequentially("800", { delay: 30 });
  await rate2.press("Enter");
  await until(pRate, () => {
    try { return (JSON.parse(localStorage.getItem("config:lists")).rates || {})["Line 2"] === 800; } catch { return false; }
  });
  assert((await ratesOf())["Line 2"] === 800,
    `Enter must commit the typed rate too, storage held ${JSON.stringify(await ratesOf())}`);

  // A number typed but never blurred still LOOKS saved in the box, and a
  // backgrounded tab can be reclaimed at any moment. Commit-on-blur alone loses
  // it silently, so the last-chance signal has to flush pending drafts — the
  // same visibilitychange/pagehide autosave the stop timer already uses.
  await rate2.click();
  await rate2.fill("");
  await rate2.pressSequentially("555", { delay: 30 });
  await pRate.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await until(pRate, () => {
    try { return (JSON.parse(localStorage.getItem("config:lists")).rates || {})["Line 2"] === 555; } catch { return false; }
  });
  assert((await ratesOf())["Line 2"] === 555,
    `a rate typed but never blurred must be flushed when the tab hides, storage held ${JSON.stringify(await ratesOf())}`);

  await pRate.reload();
  await pRate.waitForSelector("text=Start Stop", { timeout: 20000 });
  const ratesReloaded = await ratesOf();
  assert(ratesReloaded["Line 1"] === 1200 && ratesReloaded["Line 2"] === 555,
    `committed rates must survive a reload, got ${JSON.stringify(ratesReloaded)}`);
  await pRate.click('button:has-text("Supervisor")');
  await pRate.click('button:has-text("Settings")');
  await pRate.waitForSelector("text=Machine output rates", { timeout: 5000 });
  const shownRate = await pRate.locator('h3:has-text("Machine output rates")').locator("xpath=..")
    .locator('label:has-text("Line 1") input').inputValue();
  assert(shownRate === "1200", `the settings box must show the saved rate after a reload, showed ${shownRate}`);

  // ---- Add must say why nothing happened ------------------------------------
  // A duplicate (even one differing only by case or padding) used to no-op in
  // silence, which from the supervisor's side is indistinguishable from a dead
  // button — they tap it again, then start inventing variant names.
  const machineCard = pRate.locator('h3:has-text("Machines")').locator("xpath=..");
  await machineCard.locator("input").fill("  line 1 ");
  await machineCard.locator('button:has-text("Add")').click();
  await pRate.waitForTimeout(200);
  const dupText = await machineCard.innerText();
  assert(/already in the list/i.test(dupText),
    `a duplicate Add must say so instead of doing nothing, the card read: ${JSON.stringify(dupText)}`);
  const machinesAfterDup = await pRate.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:lists")).machines; } catch { return []; }
  });
  assert(machinesAfterDup.length === 2,
    `a duplicate must not be added, the list is now ${JSON.stringify(machinesAfterDup)}`);

  // ---- a shift that produced nothing good is still a shift ------------------
  // Save required UNITS, so a scrap-only run couldn't be recorded at all — the
  // quality figure for the worst kind of shift was the one that went missing.
  await pRate.click('button:has-text("Operator")');
  await pRate.waitForSelector("text=Shift output", { timeout: 5000 });
  const outCard = pRate.locator('h3:has-text("Shift output")').locator("xpath=..");
  await outCard.locator('label:has-text("SCRAP") input').fill("3");
  const outSave = outCard.locator('button:has-text("Save")');
  assert(!(await outSave.isDisabled()),
    "a scrap-only shift must be saveable — a blank UNITS box counts as 0, not as 'incomplete'");
  await outSave.click();
  const prodRec = await until(pRate, () => {
    const k = Object.keys(localStorage).find((x) => x.startsWith("prod:"));
    try { return k ? JSON.parse(localStorage.getItem(k)) : null; } catch { return null; }
  });
  assert(prodRec && prodRec.scrapCount === 3 && prodRec.unitsProduced === 0,
    `a scrap-only entry must save with units 0, got ${JSON.stringify(prodRec)}`);
  await ctxRate.close();

  // ---- a failed manual report must still be retryable -----------------------
  // handleManualSave sets a re-entrancy latch OUTSIDE any try/finally. Every path
  // through it releases the latch today (api.saveStop catches storage failures and
  // returns {ok:false} rather than throwing), but nothing proved it — and a stuck
  // latch is invisible: the retry the error message asks for would silently do
  // nothing, and the operator would retype the same stop until they gave up.
  const { ctx: ctxRetry, page: pRetry } = await newApp(browser, {
    seed: () => {
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
      localStorage.setItem("config:prefs", JSON.stringify({ operator: "Bob", setupLocked: true, machine: "Line 1" }));
      // Storage rejects stops until the test says otherwise — a full phone.
      window.__failStops = true;
      const realSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (window.__failStops && String(k).startsWith("stop:")) {
          const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e;
        }
        return realSet.call(this, k, v);
      };
    },
  });
  await pRetry.waitForSelector("text=Start Stop", { timeout: 20000 });
  await pRetry.click("text=Report a stop manually");
  await pRetry.waitForSelector("text=For a stop that already happened", { timeout: 5000 });
  await pRetry.click('button:has-text("5 min")');
  await pRetry.click('button:has-text("Save stop")');
  await pRetry.waitForTimeout(500);
  assert(await pRetry.locator("text=For a stop that already happened").count() === 1,
    "a failed manual save must keep the report open so it can be retried");
  const retryErr = await pRetry.locator("text=For a stop that already happened").locator("xpath=..").innerText();
  assert(/storage is full/i.test(retryErr),
    `the operator must be told why the manual report failed, saw: ${JSON.stringify(retryErr)}`);

  // Storage recovers (old stops exported and cleared) — the retry must go through.
  await pRetry.evaluate(() => { window.__failStops = false; });
  await pRetry.click('button:has-text("Save stop")');
  // Polled, not waited-for: a wedged latch produces NO error and NO change at
  // all, and that has to read as a failed assertion, not a selector timeout.
  const retryRecs = (await until(pRetry, () => {
    const recs = Object.keys(localStorage).filter((k) => k.startsWith("stop:"))
      .map((k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }).filter(Boolean);
    return recs.length ? recs : null;
  })) || [];
  assert(retryRecs.length === 1,
    `the retried manual report must record exactly once, got ${retryRecs.length} — a re-entrancy latch that never released would look exactly like this`);
  assert(await pRetry.locator("text=For a stop that already happened").count() === 0,
    "a successful retry must close the report");
  assert(retryRecs[0].duration === 300000 && retryRecs[0].manual === true,
    `the retry must record what was typed (5 min, manual), got ${JSON.stringify([retryRecs[0].duration, retryRecs[0].manual])}`);
  await ctxRetry.close();

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

  // ---- one measurement must produce exactly ONE record ----------------------
  // The ended-but-undocumented stop lives in the SHARED `inprogress:current`
  // slot, so every open tab is handed the same one. Each used to mint its own
  // random id, so both tabs' saves landed on different keys: one 4s stop became
  // two records and 8s of downtime on the operator board AND the supervisor log.
  // Ids for timed stops are now derived from the measurement, and saveStop
  // merges onto that key without ever shortening it.
  const ctxDup = await browser.newContext();
  const dupTab = async () => {
    const p = await ctxDup.newPage();
    await p.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
      const u = route.request().url();
      if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
      if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
      return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
    });
    await p.addInitScript(seedPlainBrowser);
    await p.goto("file://" + path.join(root, "index.html"));
    await p.waitForSelector("text=Start Stop", { timeout: 20000 });
    return p;
  };
  const dupA = await dupTab();
  await dupA.click("text=Start Stop");
  await dupA.waitForTimeout(1200);
  await dupA.click("text=End Stop");
  await dupA.waitForSelector("text=Document this stop", { timeout: 5000 });

  // A second tab opened now (bookmark, home-screen shortcut) is handed the same
  // parked stop and shows the same document card.
  const dupB = await dupTab();
  assert(await dupB.locator("text=Document this stop").count() === 1,
    "precondition: a tab opened after End Stop is handed the same parked stop");

  await dupB.click('button:has-text("Save stop")');
  await until(dupB, () => Object.keys(localStorage).filter((k) => k.startsWith("stop:")).length > 0);
  // The peer's card must come off screen rather than keep a live Save button on
  // a measurement that no longer exists.
  const peerCardGone = await until(dupA, () => !document.body.innerText.includes("Document this stop"));
  assert(peerCardGone, "a tab must drop its document card once another tab has documented the same parked stop");

  const dupRecords = await dupA.evaluate(() => Object.keys(localStorage)
    .filter((k) => k.startsWith("stop:"))
    .map((k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } })
    .filter((s) => s && !s.offMachine && !s.deleted)
    .map((s) => ({ id: s.id, start: s.start, end: s.end, duration: s.duration })));
  assert(dupRecords.length === 1,
    `one measured stop must yield exactly one record, got ${dupRecords.length}: ${JSON.stringify(dupRecords)}`);
  // The card-clearing above is what stops the second save in THIS sequence, but
  // it is event-timing dependent (a frozen tab can miss the event). The id is the
  // backstop that makes a duplicate write collapse instead of duplicate, so guard
  // it directly rather than relying on the race resolving the same way every run.
  const dupSlug = (m) => String(m || "").replace(/[^a-zA-Z0-9]+/g, "-");
  const dupMachine = await dupA.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}").machine; } catch { return ""; }
  });
  assert(dupRecords[0].id === `${dupRecords[0].start}-${dupSlug(dupMachine)}`,
    `a timed stop's id must be derived from the measurement so two tabs collapse onto one key, got "${dupRecords[0].id}"`);

  const dupCounted = dupRecords.reduce((n, s) => n + s.duration, 0);
  const dupWindow = Math.max(...dupRecords.map((s) => s.end)) - Math.min(...dupRecords.map((s) => s.start));
  assert(dupCounted <= dupWindow + 50,
    `counted downtime (${dupCounted}ms) must not exceed the measured window (${dupWindow}ms) — that is invented downtime`);

  // ...and the other half of the deal: a deterministic id must never let a late
  // or stale write SHORTEN a measurement. Seed a longer record on the very key
  // this stop will derive, then document the (shorter) parked stop.
  const dupC = await dupTab();
  await dupC.click("text=Start Stop");
  await dupC.waitForTimeout(1100);
  await dupC.click("text=End Stop");
  await dupC.waitForSelector("text=Document this stop", { timeout: 5000 });
  const parkedC = await dupC.evaluate(() => JSON.parse(localStorage.getItem("inprogress:current") || "{}"));
  await dupC.evaluate((p) => {
    const slug = String(p.machine || "").replace(/[^a-zA-Z0-9]+/g, "-");
    const id = `${p.startTs}-${slug}`;
    localStorage.setItem(`stop:${id}`, JSON.stringify({
      id, machine: p.machine, operator: p.operator, start: p.startTs,
      end: p.startTs + 600000, duration: 600000, reason: "Cleaning", notes: "",
      discarded: false, loggedAt: Date.now(), updatedAt: Date.now(),
    }));
  }, parkedC);
  await dupC.click('button:has-text("Save stop")');
  await dupC.waitForTimeout(800);
  const merged = await dupC.evaluate((p) => {
    const slug = String(p.machine || "").replace(/[^a-zA-Z0-9]+/g, "-");
    try { return JSON.parse(localStorage.getItem(`stop:${p.startTs}-${slug}`)); } catch { return null; }
  }, parkedC);
  assert(merged && merged.duration === 600000,
    `a later write must not shorten a recorded measurement (10min -> ${merged && merged.duration}ms)`);
  await ctxDup.close();

  // ---- a live span outranks a peer's stale-span drop ------------------------
  // The restore-drop rule (a span older than the shift is dropped, not recorded)
  // runs per tab. It used to stamp the "already closed" marker, which told the
  // tab holding that span LIVE that it had been recorded — so the operator's
  // break silently vanished. And the marker is matched by identity, not `>=`,
  // so a clock that jumps backwards can't make every later span adoptable.
  const ctxSkew = await browser.newContext();
  const skewSeed = () => {
    const now = Date.now();
    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    localStorage.setItem("config:lists", JSON.stringify({
      machines: ["Line 1", "Line 2"], reasons: ["Cleaning"], quickStops: [],
      shifts: [{ id: "t1", name: "Test", start: hhmm(now - 3600e3), end: hhmm(now + 7 * 3600e3), goals: {} }],
      rates: {}, handoverEmails: [], updatedAt: now,
    }));
    // A marker stamped 5 minutes in the FUTURE — what one backwards clock
    // correction leaves behind.
    localStorage.setItem("config:prefs", JSON.stringify({
      operator: "Bob", setupLocked: true, machine: "Line 1", offMachineClosed: now + 300000,
    }));
  };
  const skewTab = async () => {
    const p = await ctxSkew.newPage();
    await p.route(/unpkg\.com|cdn\.tailwindcss\.com/, async (route) => {
      const u = route.request().url();
      if (u.includes("react-dom")) return route.fulfill({ contentType: "application/javascript", body: reactDomUmd });
      if (u.includes("react")) return route.fulfill({ contentType: "application/javascript", body: reactUmd });
      return route.fulfill({ contentType: "application/javascript", body: "/* tailwind stub */" });
    });
    await p.addInitScript(skewSeed);
    await p.goto("file://" + path.join(root, "index.html"));
    await p.waitForSelector("text=Start Stop", { timeout: 20000 });
    return p;
  };
  const skewA = await skewTab();
  const skewB = await skewTab();
  await skewA.click('button:has-text("Off machine")');
  await skewA.waitForSelector('button:has-text("Back on Line 1")', { timeout: 5000 });
  await skewB.click('button[aria-label="Toggle theme"]');   // one unrelated peer write
  await skewB.waitForTimeout(700);
  assert(await skewA.locator('button:has-text("Back on Line 1")').count() === 1,
    "a stale future-dated marker must not let a peer's write eat a LIVE span — those are unlogged minutes");
  const skewSpan = await skewA.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("config:prefs") || "{}").offMachine; } catch { return null; }
  });
  assert(skewSpan && skewSpan.start, `the live span must still be in storage, got ${JSON.stringify(skewSpan)}`);
  await ctxSkew.close();

  // ---- the supervisor's numbers ---------------------------------------------
  // There was NO supervisor coverage at all, which is why three wrong numbers
  // shipped with every gate green: the Uptime card divided every machine's
  // downtime by ONE machine's shift (3 machines x 2h read 25% while the OEE
  // panel read 75% for the same records), the OEE panel ignored the machine
  // filter (filtering to the worst machine RAISED overall OEE), and overall
  // Performance divided all-machine units by rated-machine capacity (100% for a
  // line running at half speed). Numbers below are hand-computed.
  //
  // Seed: an 8h shift (06:00-14:00), 3 machines, all reporting today.
  //   Line 1  2h down, rate 100/h, 400 units   Line 2  2h down, no rate, 5000 units
  //   Line 3  2h down, no rate, no units
  // Availability = (3x8h - 6h) / 3x8h = 18/24 = 75.0%
  // Performance  = rated units / rated capacity = 400 / (100 x 6h) = 66.7%
  //   (Line 2's 5000 units must NOT count: no rate, so no capacity either)
  const SUP_SHIFT_H = 8;
  const supSeed = () => {
    // Seed ONCE. addInitScript runs on every navigation, and the restore flow
    // reloads the page — an unguarded seed would rewrite the very record the
    // restore just tombstoned, and the test would "fail" on its own fixture.
    if (localStorage.getItem("config:lists")) return;
    const now = Date.now();
    const startOfDay = new Date(now); startOfDay.setHours(6, 0, 0, 0);
    const shiftStart = startOfDay.getTime();
    const hhmm = (ms) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    localStorage.setItem("config:lists", JSON.stringify({
      machines: ["Line 1", "Line 2", "Line 3"], reasons: ["Cleaning"], quickStops: [],
      shifts: [{ id: "s1", name: "Day", start: hhmm(shiftStart), end: hhmm(shiftStart + 8 * 3600e3), goals: {} }],
      rates: { "Line 1": 100 }, handoverEmails: [], updatedAt: now,
    }));
    localStorage.setItem("config:prefs", JSON.stringify({ operator: "Bob", setupLocked: true, machine: "Line 1" }));
    const twoH = 2 * 3600e3;
    ["Line 1", "Line 2", "Line 3"].forEach((m, i) => {
      const start = shiftStart + (i + 1) * 600e3;
      localStorage.setItem(`stop:sup-${i}`, JSON.stringify({
        id: `sup-${i}`, machine: m, operator: "Bob", start, end: start + twoH, duration: twoH,
        reason: "Cleaning", notes: "", discarded: false, loggedAt: start + twoH, updatedAt: start + twoH,
      }));
    });
    [["Line 1", 400], ["Line 2", 5000]].forEach(([m, units], i) => {
      localStorage.setItem(`prod:p${i}`, JSON.stringify({
        id: `p${i}`, machine: m, operator: "Bob", shiftStart, unitsProduced: units, scrapCount: 0,
        loggedAt: shiftStart + 3600e3, updatedAt: shiftStart + 3600e3,
      }));
    });
  };
  const { ctx: supCtx, page: sup } = await newApp(browser, { seed: supSeed });
  await sup.waitForSelector("text=Start Stop", { timeout: 20000 });
  await sup.click('button:has-text("Supervisor")');
  await sup.click('button:has-text("Analytics")');   // the OEE panel lives here, not on Log
  await sup.waitForSelector("text=Downtime by reason", { timeout: 10000 });

  const cardValue = async (label) => sup.evaluate((l) => {
    const card = [...document.querySelectorAll("div")].find((d) => {
      const t = (d.textContent || "").trim();
      return t.startsWith(l) && d.querySelectorAll("div").length <= 3 && t.length < 40;
    });
    return card ? card.textContent.replace(l, "").trim() : null;
  }, label);

  const upAll = await cardValue("Uptime");
  assert(upAll === "75.0%",
    `Uptime must divide by ALL reporting machines' planned time — expected 75.0%, card read ${upAll}`);

  const oeeText = await sup.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => /^A \d/.test((d.textContent || "").trim()));
    return el ? el.textContent.trim() : null;
  });
  assert(oeeText && oeeText.includes("A 75.0%"),
    `the OEE panel's availability must agree with the Uptime card, panel read "${oeeText}"`);
  assert(oeeText && oeeText.includes("P 66.7%"),
    `Performance must divide RATED units by rated capacity (400 / 600), panel read "${oeeText}"`);
  const partialBadge = await sup.locator("text=OEE (partial)").count();
  assert(partialBadge === 1,
    "with an unrated machine reporting output, the OEE must still be badged (partial) — its units are outside P");

  // Now the filter. Line 1 alone: 2h down of 8h planned = 75.0% availability, and
  // the panel must stop listing the machines that were filtered away.
  // Slice the OEE panel out of the page text between its own headings. Matching
  // on a row element is brittle — a row's text runs well past any length guard,
  // which is how an earlier version of this assertion passed against the BROKEN
  // build (it silently matched nothing either way).
  const oeePanelText = async () => sup.evaluate(() => {
    const all = document.body.innerText;
    const from = all.indexOf("Availability × Performance × Quality");
    const to = all.indexOf("Downtime trend", from);
    return from < 0 ? "" : all.slice(from, to < 0 ? undefined : to);
  });
  const panelAll = await oeePanelText();
  assert(/Line 2/.test(panelAll),
    `precondition: unfiltered, the OEE panel must list Line 2 — panel was "${panelAll.slice(0, 200)}"`);
  await sup.selectOption("select", "Line 1");
  await sup.waitForTimeout(400);
  const panelFiltered = await oeePanelText();
  assert(!/Line 2|Line 3/.test(panelFiltered),
    `filtering to Line 1 must drop Line 2/Line 3 from the OEE panel — still shown: "${panelFiltered.slice(0, 300)}"`);
  const upFiltered = await cardValue("Uptime");
  assert(upFiltered === "75.0%",
    `filtering to one machine must not change ITS availability — expected 75.0%, card read ${upFiltered}`);

  // Restoring a backup that carries a DELETE TOMBSTONE must write it verbatim.
  // saveStop's never-shorten merge widens a measurement, but a tombstone has no
  // measurement: merging one produced {deleted:true, start:null} still carrying
  // the resurrected end/duration, and that malformed record then synced to every
  // peer. importAll routes each restored record through saveStop, so this is the
  // path that produced it.
  const backup = {
    app: "stoptrack", schema: 1,
    stops: [{ id: "sup-0", deleted: true, updatedAt: Date.now() + 60000, deletedAt: Date.now() + 60000 }],
  };
  const tombDir = mkdtempSync(path.join(tmpdir(), "stoptrack-tomb-"));
  const tombFile = path.join(tombDir, "tomb-backup.json");
  writeFileSync(tombFile, JSON.stringify(backup), "utf8");
  await sup.click('button:has-text("Settings")');
  await sup.waitForSelector('button:has-text("Restore from backup")', { timeout: 5000 });
  await sup.setInputFiles('input[type="file"]', tombFile);
  // handleRestoreFile reloads the page once the import lands, so wait for that
  // navigation to settle before reading storage.
  await sup.waitForLoadState("load").catch(() => {});
  await until(sup, () => {
    try { return (JSON.parse(localStorage.getItem("stop:sup-0") || "{}")).deleted === true; } catch { return false; }
  }, 8000);
  const tomb = await sup.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("stop:sup-0") || "null"); } catch { return null; }
  });
  assert(tomb && tomb.deleted === true, `the restored tombstone must stick, got ${JSON.stringify(tomb)}`);
  assert(tomb.start == null || Number.isFinite(tomb.start),
    `a tombstone must not carry a NaN/null start forged by the merge, got start=${JSON.stringify(tomb.start)}`);
  assert(tomb.duration == null && tomb.end == null,
    `a tombstone must not resurrect the deleted measurement, got ${JSON.stringify(tomb)}`);
  await supCtx.close();
  rmSync(tombDir, { recursive: true, force: true });

  await browser.close();
  console.log("web-e2e: PASS — stop recorded immediately (operator=Alice, reason=" + chosenReason + ", duration=" + rec.duration + "ms)");
  console.log("web-e2e: PASS — shift window is clock-derived (7h/9h/8h incl. overnight); Show all reveals stops without inflating the stats");
  console.log(`web-e2e: PASS — handout rendered ${shot.w}x${shot.h} PNG, shared via native, filed with note + ${h.flags.length} operator flag(s)`);
  console.log(`web-e2e: PASS — Off machine logs downtime on the machine left (${off1.duration}ms as "No operator"), Start Stop blocked while away`);
  console.log(`web-e2e: PASS — roaming handout splits downtime per machine (${ms.map((m) => `${m.machine} ${Math.round(m.downtimeMs / 60e3)}m`).join(", ")}), worst first`);
  console.log(`web-e2e: PASS — an ended-but-undocumented stop survives a reload (${shownBefore}) and records once; a quota failure keeps it and says so in plain words`);
  console.log("web-e2e: PASS — a machine switch persists: stop + manned time after a reload both land on the switched-to machine");
  console.log("web-e2e: PASS — a second tab's write can't erase an open off-machine span, undo the New Shift cutoff, or drop a config edit");
  console.log(`web-e2e: PASS — a long span logs exactly the duration it asked about (${shownDur}); a retyped name still finds its stops; 900 sec clamps to 59`);
  console.log("web-e2e: PASS — a discarded stop stays discarded across a reload (no card, no prompt, nothing parked)");
  console.log(`web-e2e: PASS — a RECOVERED stop finalized then interrupted survives (${finShown}) and records once`);
  console.log("web-e2e: PASS — coming back on another machine persists it through both exits (record and discard), stop still on the machine left");
  console.log(`web-e2e: PASS — rates commit on blur/Enter/tab-hide, never per keystroke (Line 1 ${ratesReloaded["Line 1"]}, Line 2 ${ratesReloaded["Line 2"]}); duplicate Add says why; scrap-only output saves`);
  console.log("web-e2e: PASS — a manual report that hit full storage can be retried once storage recovers (the latch releases)");
  console.log(`web-e2e: PASS — two tabs documenting ONE parked stop record it once (${dupCounted}ms over a ${dupWindow}ms window), the peer's card clears, and a late write can't shorten it`);
  console.log("web-e2e: PASS — a live off-machine span outranks a peer's stale-span drop and a future-dated marker (no silently unlogged break)");
  console.log("web-e2e: PASS — supervisor numbers agree: Uptime 75.0% == OEE availability, P counts only rated machines (66.7%), badged partial, and the machine filter reaches the OEE panel");
}

main().catch((e) => { console.error("web-e2e: FAIL —", e.message); process.exit(1); });
