# StopTrack — improvement backlog

Maintained by the **scout** agent (`.claude/agents/scout.md`), refreshed on a daily
Routine (16:00 UTC). Ranked by (value × confidence) ÷ effort. The scout reads this
file before each run, so items get **re-ranked and marked done** rather than
re-proposed.

- **Last updated:** 2026-07-30 (security audit round; scouting run #2 before that)
- **Baseline:** `main` @ v0.7. `npm test` green (7 server cases, 4 browser phases).
- Items marked ⚑ were **reproduced empirically**, not just read.

> Owner: annotate freely (`— skip, we don't care about X`). The scout preserves
> annotations across runs.

## Being fixed in the 2026-07-30 security audit round

Don't re-propose these. Items 15–17 are **done in the tree** (CI + docs). Items 3,
8 and 18 are **claimed done by the code workers in the same round but were not
verifiable when this list was written** — confirm in code before deleting them,
and if a fix didn't land, un-tick it rather than assuming.

| Item | Status |
|------|--------|
| #3 CSV formula injection | fix in flight (web worker) — verify `StopTrack.tsx` export |
| #8 loopback bridge unauthenticated | fix in flight (Android worker) — hardware-verify |
| #15 CI signing key on branches | **fixed** — `.github/workflows/android.yml` |
| #16 `GITHUB_ENV` injection | **fixed** — heredoc form, random delimiter |
| #17 actions pinned by mutable tag | **fixed** — SHA pins in the signing job |
| #18 `X-Forwarded-For` rate-limit bypass | fix in flight (server worker) — verify `TRUST_PROXY` |
| #19 supervisor PIN clearable by any token holder | **open** — documented, not fixed |
| #20 old signing key still in git history | **won't fix** — documented instead |

## Shipped since run #1 — verified in code

#1 clock skew (partly — see item 5), #2 handovers sync, #3/#11 `showAll` split +
unnamed-operator guard, #4 clock-derived shift window (partly — see item 6),
#7 signing script + release warning (secrets still not added). `npm run build` is
reproducible; no drift between `StopTrack.tsx` and `index.html`.

---

## 1. ⚑ The sync pull cursor silently drops records — roughly half of all stops never reach a second device

The worst item on this list: nothing is corrupted, data is simply **lost from the
supervisor's view** while sitting on the server the whole time, with no error.

A stop is stamped `updatedAt = end` (`StopTrack.tsx:2156`) but pushed on the next
25 s flush. The puller stores `serverTime` as its cursor (`:1478`) and the server
filters `stampOf(s) > since` (`server/server.js:353`). So any stop that *ended*
before the other device's last poll is invisible to it — permanently, since the
cursor only moves forward. Reproduced against the real server:

```
supervisor cursor = 1785248321745
operator pushes a stop that ended 60s ago -> {"ok":true,"applied":1}
supervisor's next pull (since=cursor):  0 stop(s)
server actually holds:                  1 stop(s)
```

~50% of stops in steady state with both devices polling, and **100% of anything
logged during an offline gap** — the scenario the app is sold on. Identical for
`/production` `:378`, `/sessions` `:399` and the new `/handovers` `:443`.

- **Effort:** M. Stamp a monotonic server-receipt sequence on write and filter GET
  on that, returning it as the cursor. Keep `updatedAt` for LWW — **the delivery
  clock and the merge clock must be separate.** Records with no sequence fall back
  to `stampOf`, so existing stores keep working.
- **Risk:** Confusing the two clocks either re-delivers everything (harmless,
  chatty) or repeats this bug. Ship with item 2.

## 2. No test proves a record travels from one device to another

Every gate is green while item 1 is live. `test/web-e2e.mjs:380-430` boots a real
server and asserts a handover *arrives*; it never opens a second client and never
asserts anything *comes back*. The whole pull path — cursor arithmetic,
`applyRemote*`, the cursor names — is uncovered.

- **Effort:** S. Extend phase 4 with a second browser context against the same
  server; assert the first context's stop appears in the second's storage. Plus a
  server case: pull (capture cursor) → POST a record stamped 30 s earlier → pull
  with that cursor → expect it.
- **Risk:** Timing flake — drive `sync.flush()` rather than sleeping past the 25 s
  interval.

## 3. CSV exports are formula-injectable *(fix in flight — 2026-07-30 audit)*

`StopTrack.tsx:3096` quotes `"` but never neutralises a leading `=`, `+`, `-`, `@`.
Machine names, reasons, operator names, notes and discard explanations are all
free text typed on the floor, and the CSV is explicitly the artifact that leaves
the building.

- **Effort:** S — ~10 lines. **Risk:** nil; add a round-trip assertion.
- **Status:** picked up in the 2026-07-30 audit round by the web worker. Not
  verified from this file — check the export helper and that a round-trip test
  exists before dropping this item.

## 4. ⚑ The supervisor's custom date range is parsed as UTC

`new Date("2026-07-01")` is UTC midnight. Measured under `TZ=Europe/Berlin`,
picking 1 Jul → 1 Jul yields `01/07 02:00 → 02/07 02:00`: the night shift's
22:00–02:00 lands on the wrong date and Jul 1's first two hours vanish. Quietly
wrong for every deployment not on UTC, and it feeds both exports.

- **Where:** `StopTrack.tsx:2951-2952`, consumed at `:2961`, `:3095`, `:3100`.
- **Effort:** S — parse as local. **Risk:** none; pin the test to a non-UTC `TZ`,
  since CI runs UTC where the bug is invisible.

## 5. The clock-skew fix is half a fix — the client discards the `serverTime` it already receives

`stampOf` clamps to `Date.now()` (`:727`) — but on a phone whose clock reads +1
year, `Date.now()` *is* +1 year, so the clamp is a no-op **on the device that has
the problem**. Its local copy keeps the future stamp, a supervisor's discard loses
the comparison at `:1883` and is not applied there; if it ever re-pushes, the
un-discarded copy wins on the server too. Every response already carries
`serverTime` and `useSync` throws it away (`:1441`, `:1475`).

Also: `configRejectedRef` is only cleared inside the local-newer branch, so a
rejected settings warning sticks until the supervisor edits again — and the early
`return` at `:1504` suppresses every other sync error meanwhile.

- **Effort:** M. Persist `serverOffset = serverTime - Date.now()`; clamp against
  `Date.now() + serverOffset`; banner when `|offset| > 5 min`. Reset the rejected
  flag at the top of each flush.
- **Risk:** `stampOf` feeds eight merge sites — a sign error makes every remote
  record win. Test with a monkey-patched `Date.now`.

## 6. Shift-window edges: the handout can go out empty, and production re-keys

Both from the v0.7 reform, which was still the right call.

- `shiftStart` moves on the clock, and the production record id embeds it
  (`:2177`, looked up `:2199`) — so at the boundary `myProduction` becomes null,
  `ShiftOutputCard` blanks the typed units (`:3546-3549`), and re-entering makes a
  **second** record that the supervisor's day total double-counts.
- `buildShiftReport` is fed `shiftStops` (`:2513`), so an operator working 2 h past
  shift end who taps Handover hands the next shift a card reading **"0 stops · 0m"**
  for eight hours they worked.
- ⚑ **DST:** under `TZ=Europe/Berlin` on spring-forward, a 22:00–06:00 shift
  resolves to a window starting 21:00 — `start -= 24*60*60*1000` (`:116`) and
  `shiftLengthMs` are wall-clock-minute arithmetic.
- **Effort:** M. Key production on `shiftId` + the local calendar date; anchor the
  handout to the shift occurrence; derive window edges by setting hours on a
  `Date`, not adding fixed ms.
- **Risk:** Old production ids must still resolve. The e2e pins a shift containing
  `now`, so it can't see a boundary re-key — add a crossing case.

## 7. The phone bridge's push cursor permanently strands a late watch stop

`RemoteForwarder` pushes `store.since(collection, pushCursor)` where the cursor is
the max record stamp already pushed. A watch logs at 10:00 out of range; the phone
forwards its own 10:05 stop; the watch reconnects at 10:10 and delivers 10:00 —
`since(10:05)` excludes it and **it never leaves the phone at all**. Same root
cause as item 1, strictly worse. The web client got this right with an explicit
outbox of keys; make the phone match.

- **Where:** `RemoteForwarder.kt:22-30`, `PhoneStore.kt:62-63`.
- **Effort:** S code, **blocked on hardware** (emulator CI or a real device).
- **Risk:** Clear the dirty set only on a 2xx.

## 8. The loopback API is unauthenticated — and the one control that exists breaks the app *(fix in flight — 2026-07-30 audit)*

`authOk` returns true when the token is blank, and responses carry
`Access-Control-Allow-Origin: *` **plus** `Access-Control-Allow-Private-Network:
true` — the header that lets a public page reach loopback. Any page the operator
opens can read the log or POST `{deleted:true}` tombstones the phone forwards
onward. **New:** a `localToken` field exists and is editable, but the bridge
hard-codes `fun token(): String = ""` (`MainActivity.kt:215`) — so an owner who
sets a token to close the hole gets 401s and sync silently dies. That's a trap.

- **Effort:** S–M, **blocked on hardware**. Random token on first run, return it
  from `token()`, drop the PNA header, narrow `Allow-Origin`. Token first.
- **Sharpened by the 2026-07-30 audit:** the exposure is worse than "another app on
  the phone". `Allow-Origin: *` **plus** `Allow-Private-Network: true` is exactly
  the header pair that lets a page on the public internet reach loopback, so any
  website the operator opens can read the log *and* the supervisor config
  (`supervisorPinHash` included) and post tombstones the phone forwards onward.
- **Status:** picked up in the same round by the Android worker. Code-verify, then
  hardware-verify — the fix is invisible to every gate in this repo.

## 9. localStorage fills at ~20,600 stops — and the first sync stops completing long before *(carried, refined)*

Active history is never pruned (`:895-898`); past the ceiling the operator sees
"The stop didn't save" forever. **New:** the first-enable push sends the entire
history in one request against an 8 s timeout — ~750 KB at 3,000 stops, which
times out on factory LTE, never clears the outbox, and re-uploads every 25 s
forever.

- **Effort:** M in three independent parts: **(a) chunk the push (~15 lines — do
  this first)**, (b) cap the supervisor table at ~200 rows, (c) bounded local
  retention.
- **Risk:** (c) is this project's historical failure mode — gate on
  `syncEnabled && outbox empty && cursor > record stamp`, never purge on a device
  that has never synced.

## 10. The browser stop flow — pause/resume banking — is still untested *(carried, partly addressed)*

Phases 2–3 now boot without the mock, so the browser *render* path is covered. But
the mock is still installed for every phase that **drives a stop**, so `useTimer`'s
pause/resume banking, `handleStop` and `pendingStop` have never been executed by
any test — the path for everyone who just opens `index.html` in Chrome.

- **Effort:** S. Run the drive-a-stop sequence once without the mock, with a
  Pause → wait → Resume → End leg asserting the paused span is excluded.

## 11. The PLC gateway still cannot deliver a stop — and the README says it can *(carried)*

`VALID_SINKS = ("console", "file")`. Micro-stops are the downtime operators never
log and usually the biggest hidden loss on a line; this is the highest-value *new*
capability in the repo and it's one adapter away.

- **Effort:** M, **fully runnable in this session**. `StopTrackSink(url, token)`
  mapping `stop_ended` → a real record with an on-disk outbox, plus an `auto` badge.
- **Risk:** Batch and honour 429. Auto stops must never carry a human operator name.
  **Until it exists, fix the README sentence — that part is 2 minutes.**

## 12. An operator can't correct a stop they just logged

Reason is a dropdown tapped with gloves right after an outage, often mis-preselected.
Once saved, Recent-stops rows are inert divs — the only remedy is a supervisor
Discard with a written explanation. Realistic outcome: a permanently mis-attributed
reason feeding the by-reason chart and the handout. `api.updateStop` already exists.

- **Effort:** M. Tappable for ~15 min after `loggedAt` → reason chips + notes.
- **Risk:** Must never change `start`/`end`/`duration`/`loggedAt` or the stop moves
  between shifts — the `loggedAt` lesson. Assert that in a test.

## 13. Supervisor analytics rank machines by minutes only — not frequency or money

40 × 2-minute stops and one 80-minute stop look identical but are completely
different problems. And "which machine is costing me most this month" has no answer:
rates are units/hour only.

- **Effort:** M. Add stop count + mean duration (~20 lines, data is already there),
  then an optional per-machine cost-per-hour and a column that appears only when set.
- **Risk:** Keep cost opt-in and blank by default, and currency-agnostic.

## 14. A failed CDN inline silently ships an online-only APK *(carried)*

`build-web-asset.mjs:42-46` warns and continues, so Gradle packages a
CDN-referencing asset. The emulator test can't catch it (CI has internet); it
surfaces only on a factory phone with no signal, as a blank app.

- **Effort:** S — exit non-zero on a failed inline for release builds.

---

# Filed by the 2026-07-30 security audit

## 15. ✅ CI handed the release signing key to every unreviewed branch *(fixed)*

`.github/workflows/android.yml` builds `push: branches: [main, "claude/**"]`, and
the "Configure signing key" step had no `if:` — so every agent-pushed branch
decoded the keystore to the runner's disk and ran a Gradle build *defined by that
same branch* with `STOPTRACK_STORE_PASSWORD` / `STOPTRACK_KEY_PASSWORD` in its
environment. One commit to a `claude/**` branch was enough to exfiltrate the
release key, which is the credential that can't be rotated without forcing every
operator to uninstall and lose local data.

- **Fixed:** step gated to `main` + `v*` tags. Branch builds still build, falling
  through to the debug-key path Gradle already handled.
- **Follow-up, not done:** the `build` job keeps `contents: write` on branch runs
  (GitHub scopes permissions per job, not per step). Splitting build and publish
  into two jobs closes it. Effort S, lower stakes — a run token expires.

## 16. ✅ `GITHUB_ENV` was newline-injectable *(fixed)*

`echo "STOPTRACK_STORE_PASSWORD=$STORE_PW" >> $GITHUB_ENV` — a secret containing a
newline defines arbitrary variables for every later step. Now the heredoc form
with a per-run random delimiter, for all three secret values.

## 17. ✅ Actions in the signing job were pinned by mutable tag *(fixed)*

`@v4` / `@v3` / `@v2` are tags the action owner can repoint at any time; in the one
job that holds the keystore that's a direct supply-chain path to it. All six are
now full commit SHAs with `# vX.Y.Z` comments.

- **Deliberately not done:** the other workflows (`ci.yml`, `web-test.yml`,
  `android-emulator.yml`) still use tags. They hold no secrets, so pinning them is
  churn plus a maintenance burden. Revisit if one ever gains a secret.

## 18. `X-Forwarded-For` defeated the auth rate limiter *(fix in flight)*

`clientIp()` (`server/server.js:40-43`) trusts `CF-Connecting-IP` /
`X-Forwarded-For` from any caller. Behind the Cloudflare tunnel the tunnel
overwrites them and the cap holds — but on the **LAN deployment this project
documents**, nothing strips them, so an attacker gets a fresh 20-failed-auths
budget per forged header value and can guess the token at line speed.
`SECURITY.md` credited this limiter with throttling token guessing; that claim is
now corrected there.

- **Fix in flight (server worker):** `TRUST_PROXY` opt-in, default off, keying on
  the socket address otherwise. Verify it exists, and that a test covers a forged
  header not resetting the counter.

## 19. Any token holder can seize or clear the supervisor PIN on every device

The PIN hash is an ordinary synced-config field (`StopTrack.tsx:2035`); the server
treats `/config` as opaque and never checks that a PIN change came from someone
who knew the old PIN — `updatePin` verifies that in the browser only (`:2133`),
which a direct `PUT /config` skips. So a token holder can push a config with no
`supervisorPinHash` and every device that pulls sets its PIN to null (`:2027`),
opening Settings everywhere; or push a hash of their own and lock the real
supervisor out of Settings on every device at once.

- **Documented in `SECURITY.md`, not fixed.** Under the stated model a token holder
  is fully trusted, so this is arguably in-model — but it deserves a decision
  rather than an accident, because the PIN's whole *appearance* is that it
  protects Settings from whoever is holding a phone.
- **Effort:** M and awkward — a real fix needs the server to hold the PIN and
  verify old-PIN-before-change, which means the config blob stops being opaque.
  Cheap partial: refuse to *clear* a PIN via sync (only via a local unlock), so a
  remote write can't silently disarm the gate.

## 20. ❎ The old signing key is still recoverable from git history *(won't fix)*

`git rev-list --all --objects` still resolves
`android/keystore/stoptrack-debug.jks`; it was deleted from the tip, not purged.
**Not worth rewriting history:** the key was committed while the repo was public,
so it is burned whether or not the objects are purged, and the repo is private
now. The mitigation is that the key is permanently retired and never reused —
`SECURITY.md` now says that plainly instead of claiming the key was "removed".

---

## TOP 3 NEXT

1. **#1 — fix the sync pull cursor, with #2's two-device test in the same PR.**
   Everything else degrades something; this one *loses* something. Reproducible in
   under a minute, and every gate in the repo is green while it happens.
2. **#4 — the UTC date range** (#3, its old partner, is being fixed in the audit
   round). Small, provably wrong today, and in the export path — the artifact that
   leaves the building. Ship it with #3 so the export path is tested once.
3. **#6 — stabilise the shift-window arithmetic.** v0.7 left two edges that produce
   a *confidently wrong document*: a handout claiming "0 stops" for a worked shift,
   and a double-counted day total. Same class as the `loggedAt` bug already paid for.

*(Not code, still real: the four APK signing secrets. Until they're added, every CI
build gets a fresh certificate, so the app can't be updated in place. Note also
that after #15, **only `main` and `v*` tags are signed at all** — a release cut by
`workflow_dispatch` from a feature branch is deliberately unsigned, and the release
banner now says which of the two reasons applies.)*

## NOT WORTH DOING

- **Moving the WebView off `file://` onto the loopback server.** `SECURITY.md` calls
  it the "proper fix", but it makes the app's ability to *render at all* depend on
  the in-app HTTP server starting — a new single point of failure for the whole
  operator UI, on hardware nobody here can test. Do #8's token instead.
- **Rejecting future-stamped writes instead of clamping them.** A phone with a wrong
  clock still belongs to an operator logging real stops; rejecting its writes
  discards the shop floor's data at the door. Clamping keeps the data and demotes
  the stamp. The missing half is telling the human (item 5), not tightening the server.
- **Real-time sync (WebSocket/SSE) instead of the 25 s poll.** Item 1 shows the
  delivery problem is cursor semantics, not latency — a push channel would have
  shipped the identical bug plus a persistent connection on battery-limited phones.
- **Refactoring `StopTrack.tsx` (3,975 lines) into modules, or adding types.**
  Re-listed because the file grew again. Every bug above is a contract, clock or
  timezone bug; not one would have been caught by a module boundary or a type.
