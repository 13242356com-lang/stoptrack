# StopTrack — improvement backlog

Maintained by the **scout** agent (`.claude/agents/scout.md`), refreshed on a weekly
Routine. Ranked by (value × confidence) ÷ effort. The scout reads this file before each
run, so items get **re-ranked and marked done** rather than re-proposed.

- **Last updated:** 2026-07-26 (scouting run #1)
- **Baseline:** branch `claude/samsung-watch-wear-os-egbl0d`, v0.6, `npm test` green.
- Items marked ⚑ were **reproduced empirically**, not just read.

> Owner: feel free to annotate items (`— skip, we don't care about X`). The scout is
> told to preserve annotations across runs.

---

## 1. ⚑ A wrong device clock permanently poisons shared config and any stop it touches

**Why now.** Reproduced against the real `server/server.js`. A device whose clock reads
2036 pushes `config.updatedAt` far in the future. From then on the supervisor's edits
return `{"ok":true}` and are **silently discarded**, and within 25 s the sync pull
overwrites the supervisor's local state — machines/reasons/shifts/rates/PIN revert
forever, no error anywhere. Same for records: a future-stamped stop makes **discard and
"Delete forever" silently un-do themselves** on the next pull.

```
PUT /config updatedAt=2100449021000 {"machines":["SKEWED"]}      -> {"ok":true}
PUT /config updatedAt=1785089021000 {"machines":["Supervisor…"]} -> {"ok":true}
GET /config -> machines:["SKEWED"]        # the supervisor's edit is gone
```

Only recovery is hand-editing `server/data/stoptrack-data.json`. Cheap phones with no
SIM and no NTP are exactly the fleet this ships to.

- **Where:** `server/server.js:383` (config LWW), `:327` (stops LWW), `:140` (`stampOf`);
  `StopTrack.tsx:1409-1413`, `:1774-1788`, `:695`; mirrored in
  `android/mobile/.../PhoneStore.kt:75`, `android/shared/.../Lww.kt:31`.
- **Effort:** S–M. Server: clamp `incomingAt` to `min(incoming, now + 5min)`; return
  `{ok:true, applied:false}` when a write loses so the client can surface it. Client:
  same clamp + a visible "this device's clock is wrong" banner.
- **Risk:** Clamp only the **future** side — a device that's behind (offline a day) must
  not lose a legitimately newer edit. `server/` has **zero tests**; ship this with a
  `node:test` file replaying the sequence above.

## 2. Shift handovers never leave the device — the supervisor's half of v0.6 is dead

**Why now.** Handouts write to `hand:` keys and nothing else: `saveHandover` is the only
collection saver with no `_enqueue`, there's no `/handovers` route, and `Collection` has
no `HANDOVERS`. In the intended setup (operator on a phone, supervisor opening the
server URL) **Supervisor → Shift handovers is permanently empty**, and carry-forward only
works if the next operator uses the same physical phone.

- **Where:** `StopTrack.tsx:998-1005`, `:978-996`, `:3112`, `:3702`; `server/server.js`
  (routes end at `/report`); `android/shared/.../SyncContract.kt:31-37`.
- **Effort:** M — same shape as `/sessions`, which already works end to end. Add the enum
  member, one GET/POST pair, push/pull + cursor in `useSync`, `_enqueue` in `saveHandover`.
- **Risk:** Low. Keep `saveHandover` non-blocking; add a test asserting the record leaves
  storage.

## 3. ⚑ "Show all" silently inflates the shift board — and the handout built from it

**Why now.** Measured on the real `index.html`:

```
default view:      Stops=1  Downtime=5m
after 'Show all':  Stops=4  Downtime=2h 5m
```

`showAll` is meant to be a *view* toggle for the Recent list, but it feeds `myStops` →
the stat cards, the by-reason chart, OEE, **and `buildShiftReport`**. Tap it out of
curiosity, then tap Handover, and the card sent to the supervisor claims 4 stops / 2h 5m
for a window its own header dates from the cutoff. OEE is worse than wrong: manned time
is clipped to the cutoff while downtime isn't, so availability collapses toward 0. Same
family as the `loggedAt` bug this project already paid for once.

- **Where:** `StopTrack.tsx:2149-2153`, `:2143`, `:2360`, `:2390-2404`, `:2168-2221`.
- **Effort:** S. Split `shiftStops` (always cutoff-filtered → stats, OEE, report) from
  `visibleStops` (`showAll`-aware → the Recent list only).
- **Risk:** Easy to get backwards, and nothing today would catch it — the e2e never sets
  `clearedBefore`. Add a case that seeds a pre-cutoff stop, toggles Show all, and asserts
  the Stops card stays at the in-shift count. Do together with #11.

## 4. Shift boundaries only move when someone taps "New Shift"

**Why now.** `clearedBefore` is written in exactly one place — the button. Shifts already
have real configured times and `shiftEndAt()` rolls over, but the cutoff never does. Forget
the button once and: "THIS SHIFT" accumulates for days; the goal card compares multi-day
output against a one-shift goal; and **production records collide** — the id is
`${machineSlug}|${clearedBefore}|${operator}`, so today's units *overwrite* yesterday's and
the supervisor's history disappears with no trace.

- **Where:** `StopTrack.tsx:2132-2140`, `:2052-2072`, `:2183-2186`, `:2226-2233`, `:86-94`.
- **Effort:** M. Derive the window from the selected shift's clock time; keep the button as
  a manual "start early". Key the production id on the derived instant.
- **Risk:** Real — touches the definition of "this shift" everywhere, including existing
  production ids (must fall back to the stored `shiftStart`). Do after #3.

## 5. ⚑ localStorage fills at ~20,600 stops — then nobody can log a stop, on every device at once

**Why now.** Measured in Chromium: `QuotaExceededError` at **20,562** records (~5 MB).
`loadStops` only purges `discarded`/`deleted` records; active history is never pruned and
"New Shift" deliberately deletes nothing. Past the ceiling the operator sees "The stop
didn't save" forever with no in-app remedy. With sync on, every device pulls the entire
shared history from cursor 0 (no pagination), so a 3-line plant at ~90 stops/day hits the
wall in ~7 months and **every phone hits it the same week**. Separately: the supervisor log
renders every filtered row — 3,324 ms for 5,000 rows on desktop-class headless Chromium,
re-rendered on every search keystroke.

- **Where:** `StopTrack.tsx:849-873`, `:876-888`, `:2793-2802`, `:3004-3016`;
  `server/server.js:313-317`.
- **Effort:** M in three small parts: (a) local retention window, purging only what sync
  has confirmed; (b) cap the supervisor table ~200 rows with "show more" (exports stay
  unfiltered); (c) `limit`/`since` paging on `GET /stops`.
- **Risk:** (a) is the dangerous one — purging records the server never received is exactly
  this project's historical failure mode. Gate on `syncCfg.enabled && outbox empty &&
  cursor > record.updatedAt`; never purge on a device that has never synced.

## 6. The phone's loopback API is unauthenticated, CORS-`*`, and opts into Private Network Access

**Why now.** `SECURITY.md` frames this as "another app on the same phone". It's broader.
The server binds a fixed `127.0.0.1:4000`, `authOk` returns true when the token is blank,
the token **is** blank (`NativeBridge.token()` returns `""`), and every response carries
`Access-Control-Allow-Origin: *` **plus** `Access-Control-Allow-Private-Network: true` —
the header that tells Chrome to let a public page reach loopback. So any page the operator
opens in the phone's browser (an ad frame, a QR link) can read the whole log, or POST
`{deleted:true}` tombstones that propagate through the phone to the real server and delete
records everywhere.

- **Where:** `MainActivity.kt:215-217`, `LocalSyncServer.kt:108-112` & `:143-150`,
  `Prefs.kt:41,56`, `CompanionService.kt:95-97`.
- **Effort:** S–M code, **blocked on hardware** for verification. Generate a random
  `localToken` on first run, return it from `token()` (the web app already stores whatever
  it returns), drop the PNA header, narrow `Allow-Origin`.
- **Risk:** Getting it wrong bricks the phone app's sync silently. Sequence it: token
  first, CORS second; keep `syncUrl()`/`token()` atomic.

## 7. Release APKs are signed with a key that changes every CI run

**Why now.** The four signing secrets still aren't set, so both apps fall back to the debug
config — and a fresh GitHub runner has no debug keystore, so Gradle **generates a different
certificate every run**. Today's APK won't install over yesterday's; the operator must
uninstall, which drops localStorage and `companion-data.json` — every stop not yet synced
or backed up. Across two builds the phone and watch also stop sharing a certificate, so
Wear pairing breaks with no interpretable error. CI only emits a `::warning::` and
publishes anyway.

- **Where:** `android/mobile/build.gradle.kts:57` (+ wear), `.github/workflows/android.yml`,
  `android/SIGNING.md:9-11`.
- **Effort:** S for the guard (skip publishing, or rename `-UNSIGNED-do-not-distribute`,
  when the secret is absent). The real fix is **10 minutes of owner action** — nothing in
  the repo can do it.
- **Risk:** A hard failure turns `main` red until the secrets are added. That's the point;
  just don't make it a surprise.

## 8. The PLC gateway cannot deliver a single stop into StopTrack — but the README says it can

**Why now.** `gateway/` is a complete, tested subsystem (S7, OPC UA, sim, rules engine,
6 pytest files in CI) whose only sinks are **console and file**; `VALID_SINKS` rejects
anything else. Its event shape isn't a StopTrack record either. Micro-stops are the
downtime operators never log and the biggest hidden loss on most lines — this is the
highest-value *new* capability in the repo and it's one adapter away.

- **Where:** `gateway/plc_gateway/sinks/`, `config.py:94-108`, `core/events.py:22-45`;
  target `server/server.js:319-332`. (README claim: `README.md`.)
- **Effort:** M, and **fully runnable in this session** (Python + the zero-dep Node server
  are both here). A `StopTrackSink(url, token)` mapping `stop_ended` → a real record with
  an on-disk outbox. Add an `auto` badge beside the existing `manual` one.
- **Risk:** A chatty PLC can flood the store — batch and respect the server's 429. Auto
  stops must never be attributed to a human, or by-operator analytics become fiction.

## 9. The plain-browser stop flow — the one most operators run — has no test at all

**Why now.** `test/web-e2e.mjs` installs the mock native bridge unconditionally, so
`inShell` is always true. The browser branch (`useTimer` pause/resume banking,
`handleStop`, `pendingStop`) is never executed by any test — yet it's the path for anyone
opening `index.html` in Chrome, and the one CI and the Stop hook certify as green.

- **Where:** `test/web-e2e.mjs:105`; `StopTrack.tsx:1253-1345`, `:1944-1953`, `:2237-2244`.
- **Effort:** S. Factor the drive-a-stop sequence and run it twice, with and without the
  mock; in the browser pass add Pause → wait → Resume → End asserting the recorded
  duration excludes the paused span.
- **Risk:** None to the product. Use a tolerance window, not an exact number, or it flakes.

## 10. CSV exports are formula-injectable

**Why now.** `exportCSV` quotes and doubles `"` but ignores a leading `=`, `+`, `-`, `@`.
Every field is user-controlled free text (machine/reason names, operator, notes, discard
explanations). An operator typing `=HYPERLINK(...)` into a note turns the supervisor's
Excel open into code execution — and the export is explicitly the artifact meant to leave
the building.

- **Where:** `StopTrack.tsx:2928-2933`.
- **Effort:** S — prefix `'` when a cell starts with `=+-@`, tab or CR. ~10 lines + a test.
- **Risk:** Nil. Nothing tests exports today; pair with a round-trip assertion.

## 11. With the operator name blank, the board shows *everyone's* stops and calls it "this shift"

**Why now.** `myStops` filters by operator only when a name is set, and an unlocked session
**starts blank on every refresh by design** — so this is the default at shift start, after
any refresh, and after "Unlock name". With sync on, the device holds the whole factory's
records: the board reads plant-wide stops under "THIS SHIFT", OEE is computed from other
people's downtime, and a Handover tap sends plant-wide numbers under one machine's name.

- **Where:** `StopTrack.tsx:2149-2153`, `:1708-1714`, `:2645`.
- **Effort:** S. Either gate the board until a name is entered, or label it "All operators
  on this device".
- **Risk:** Low — make the empty state a prompt, not a dead screen. Fold into #3.

## 12. If a CDN fetch fails during the APK build, the phone app silently becomes online-only

**Why now.** `build-web-asset.mjs` inlines React and Tailwind so the bundled app works with
no signal — the whole reason the APK exists. On a fetch failure it warns and **continues**,
and Gradle packages the CDN-referencing asset. The emulator smoke test can't catch it (CI
has internet); the failure shows up only on a factory phone with no signal.

- **Where:** `android/mobile/build-web-asset.mjs:41-48`, `build.gradle.kts` (`prepareWebAsset`).
- **Effort:** S. Exit non-zero on any failed inline for a release build, or assert the
  emitted asset contains no `src="https://` before packaging.
- **Risk:** Ties release builds to CDN reachability — keep the lenient path for local dev.

---

## TOP 3 NEXT

1. **#1 — clamp the LWW clock.** The only item where the app *lies*: the supervisor's edit
   and their discard both report success, then quietly undo themselves, permanently, with
   no recovery but editing JSON on the server. Everything else degrades; this destroys
   intent silently.
2. **#2 — sync the handovers.** v0.6's headline feature is half-shipped — the operator
   writes the handover and the supervisor's log is empty on any multi-device setup. The
   `/sessions` plumbing already exists to copy.
3. **#3 — split `showAll` from the shift stats.** An hour's work, measured proof it's wrong,
   and it corrupts the one document that leaves the app and goes to a human who wasn't
   there. Shares a function with #11.

*(#5 is next in the queue: a dated time-bomb — ~20,600 stops — that takes out every device
in the same week, and it needs designing before it's urgent, not after.)*

## NOT WORTH DOING

- **Moving the WebView off `file://` onto the loopback server.** `SECURITY.md` calls this
  the "proper fix", but it makes the app's ability to *render at all* depend on the in-app
  HTTP server starting — converting a defense-in-depth concern into a new single point of
  failure for the operator's whole UI. Do #6 (the token) instead: closes the reachable
  attack for a fraction of the blast radius.
- **Migrating storage to IndexedDB** to escape the 5 MB ceiling. Rewrites the entire `api`
  backend chain to buy headroom the app shouldn't need — the server is the system of
  record. Bounded local retention (#5a) is ~30 lines and fixes the real issue.
- **Real-time sync (WebSocket/SSE) instead of the 25 s poll.** Downtime is minutes-scale;
  nobody watches the board for sub-25-second latency. It adds a persistent connection on
  battery-limited phones and a stateful path through the tunnel for nothing anyone would
  notice — and the poll is what makes offline-tolerance trivial.
- **Refactoring `StopTrack.tsx` (3,810 lines) into modules, or adding real types.**
  Tempting at this size, but the single-file constraint and committed build pipeline are
  load-bearing, and every bug on this list is a logic or contract bug that no module
  boundary or type would have caught.
