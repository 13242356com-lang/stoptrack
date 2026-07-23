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
import { readFileSync, existsSync, readdirSync } from "fs";
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

  await browser.close();
  console.log("web-e2e: PASS — stop recorded immediately (operator=Alice, reason=" + chosenReason + ", duration=" + rec.duration + "ms)");
}

main().catch((e) => { console.error("web-e2e: FAIL —", e.message); process.exit(1); });
