# StopTrack — improvement backlog

Maintained by the **scout** agent (`.claude/agents/scout.md`), refreshed on a daily
Routine (16:00 UTC). Ranked by (value × confidence) ÷ effort. The scout reads this
file before each run, so items get **re-ranked and marked done** rather than
re-proposed.

- **Last updated:** 2026-07-27 (scouting run #2)
- **Baseline:** `main` @ v0.7. `npm test` green (7 server cases, 4 browser phases).
- Items marked ⚑ were **reproduced empirically**, not just read.

> Owner: annotate freely (`— skip, we don't care about X`). The scout preserves
> annotations across runs.

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

## 3. CSV exports are formula-injectable *(carried, unchanged)*

`StopTrack.tsx:3096` quotes `"` but never neutralises a leading `=`, `+`, `-`, `@`.
Machine names, reasons, operator names, notes and discard explanations are all
free text typed on the floor, and the CSV is explicitly the artifact that leaves
the building.

- **Effort:** S — ~10 lines. **Risk:** nil; add a round-trip assertion.

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

## 8. The loopback API is unauthenticated — and the one control that exists breaks the app *(carried, refined)*

`authOk` returns true when the token is blank, and responses carry
`Access-Control-Allow-Origin: *` **plus** `Access-Control-Allow-Private-Network:
true` — the header that lets a public page reach loopback. Any page the operator
opens can read the log or POST `{deleted:true}` tombstones the phone forwards
onward. **New:** a `localToken` field exists and is editable, but the bridge
hard-codes `fun token(): String = ""` (`MainActivity.kt:215`) — so an owner who
sets a token to close the hole gets 401s and sync silently dies. That's a trap.

- **Effort:** S–M, **blocked on hardware**. Random token on first run, return it
  from `token()`, drop the PNA header, narrow `Allow-Origin`. Token first.

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

## TOP 3 NEXT

1. **#1 — fix the sync pull cursor, with #2's two-device test in the same PR.**
   Everything else degrades something; this one *loses* something. Reproducible in
   under a minute, and every gate in the repo is green while it happens.
2. **#3 + #4 together — CSV injection and the UTC date range.** Both small, both
   provably wrong today, both in the export path — the artifact that leaves the
   building. One afternoon.
3. **#6 — stabilise the shift-window arithmetic.** v0.7 left two edges that produce
   a *confidently wrong document*: a handout claiming "0 stops" for a worked shift,
   and a double-counted day total. Same class as the `loggedAt` bug already paid for.

*(Not code, still real: the four APK signing secrets. Until they're added, every CI
build gets a fresh certificate, so the app can't be updated in place.)*

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
