# remote-health — findings

Model: `spec/formal/PlurSpec/RemoteHealth.lean` (checks cleanly, no sorry).
Sources: `remote-recall.ts`, `store/remote-store.ts`, `plur/remote-results.ts`, `seen-on-server.ts`.
Tests: `packages/core/test/formal-remote-health-{breaker,store,results}.test.ts`.
Promises: TEAM-1 (bounded local answer), TEAM-2 (never claims completeness), TEAM-5 (bounded network attempts).

## 1. Another token's 429 turned the network breaker into a host-wide 429 — CONFIRMED+FIXED

`last_state === 'rate_limited'` was how four sites (`dialHost`, `claimHalfOpenTrial`,
`isHostInCooldown`, `recordWriteOutcome`) recognised an older file's host-wide 429.
Tokens share the host entry, so when token A's network failure opens the breaker
and token B's 429 answers after it in the same call (or another process records a
429 meanwhile), `last_state` becomes `rate_limited` while `cooldown_until` is the
breaker's. Result: no trial read for the full 5 min, a successful save cannot end
the cooldown, and the write leg reports `rate_limit`. One token's 429 changed every
token's access to the host.

- Model: `Recall.old_race_parks_breaker` (counterexample on the replayed trace
  `afterRace`), `race_reaches_rate_limited`.
- Replay (before the fix): `pnpm exec vitest run packages/core/test/formal-remote-health-breaker.test.ts`
  → 3 failed: `expected +0 to be 1` (no trial dial), `cooldown_until` still set after a
  save, `expected 'rate_limit' to be 'breaker'`.
- Fix: `isLegacyRateLimitCooldown(h)` = `last_state === 'rate_limited' && cooldown_opened_at === undefined`.
  The breaker always records `cooldown_opened_at`; an older file's 429 never did, so
  the legacy case is still honoured (test "a host-wide 429 cooldown from an older file
  is still honoured to its end"; `legacy_still_honoured`).
- Proved: `breaker_never_legacy` (invariant `Inv`: every cooldown the code opens records
  its opening, preserved by `respond_inv`, `writeOk_inv`, `writeFail_inv`),
  `breaker_trial_reachable`, `save_clears_breaker`, `new_race_trial_and_save`.
- Mutation: reverting to the old discriminator breaks `breaker_never_legacy` and
  `new_race_trial_and_save`; dropping `opened := some t` from `openBreaker` breaks
  `openBreaker_inv` / `networkFailure_inv`.

## 2. A rejected remote leg read as "not dialed" (complete) — CONFIRMED+FIXED

`_startRemoteRecall`'s `.catch` returned `outcomes: []`; `buildRecallRemoteReport([])`
is `not_dialed`, and `results_complete = local && (ok || not_dialed)` was then `true`
for a recall whose implicated host was never reached (TEAM-2). `remoteRecall` is
written never to reject, so this is the fallback path.

- Model: `Completeness.old_catch_claims_complete` (counterexample).
- Replay: `formal-remote-health-results.test.ts` (remoteRecall mocked to reject) →
  before the fix `expected 'not_dialed' not to be 'not_dialed'`.
- Fix: the catch reports every dialed host `unreachable` / `internal_error`.
- Proved: `complete_means_reached` — complete only when no host was implicated or
  every host answered `ok`; non-vacuity `all_ok_complete`. Mutation: restoring the
  empty list breaks it.

## 3. RemoteStore host-down breaker (lead 1) — PROVED

`fetchBounded`/`load`, branch for branch (`StoreBreaker.act`, `apply`, `loadAll`).
- `marked_iff_last_net`: a host is marked iff the newest event touching its mark was a
  network throw the caller did not cause, at that time. So an HTTP answer (any status,
  any body, malformed included) never leaves a host marked, and a caller's abort never
  marks (`caller_abort_never_marks`). `other_origin_untouched`: per origin.
- `dead_host_dials_once` (TEAM-5): on a dead origin, any number of loads inside one
  cooldown dial at most once; `dead_host_dials_first` non-vacuity.
- Tests: RemoteAbortedError (in-flight and pre-aborted signal) leaves no mark, a
  network failure does, a 503 / unparseable 200 clears an earlier mark, the 30 s page
  and bounded-request timeouts.
- Mutations: caller abort marks → `caller_abort_never_marks`, `marked_iff_last_net`
  break; answer not clearing → `answered_clears`, `marked_iff_last_net`; load ignoring
  the mark → `dead_host_dials_once`.

## 4. Recall per-(url, token) state (lead 1) — PROVED, one design note

`Recall.respond` models `dialHost` after the gate, `gate` the pre-dial checks.
- `respond_token_isolation` / `others_never_touch`: no answer (any status, abort or
  error) for token k changes token k' — over every interleaving. Mutation: a 429 cooling
  every token breaks it.
- `refusal_never_counts`: 401/403/404/422/429 never raise `failures` nor extend the
  cooldown. `deadline_neutral`, `client_slow_neutral`: caller-side cuts are not evidence
  (`client_slow_streak_counts`: past the limit they are). `rate_limit_capped`: Retry-After
  ≤ 1 h (test with a 7-day header). `three_failures_open`.
- `at_most_one_trial`: claims serialised under the lock grant one trial per cooldown.
- Design, not a bug: on the recall leg an unreadable 2xx body and a 5xx DO count toward
  the breaker (`bad_body_counts`), as BREAKER_FAILURE_THRESHOLD documents; the lead's
  "a malformed body does not trip the network breaker" holds for RemoteStore's breaker
  (§3), not for the recall breaker.

## 5. Health-file merge (lead 1, lost updates) — PROVED (lead refuted)

`Persist.applyField` models `applyFieldChanges`. `untouched_survives` (a field this call
did not change survives another process's write), `increments_add` (two processes'
increments both count; `whole_loses_increment` shows the whole-value write it replaced),
`skip_never_written` (printed_state/printed_at), `other_token_survives`,
`time_never_backwards` (`readApplyWrite`). All writers re-read under the lock; with the
lock unavailable they run unlocked by design (`withRemoteHealthLock`; tested).
Mutations: counter written whole → `increments_add`; skip ignored → `skip_never_written`;
no time fix-up → `time_never_backwards`.

## 6. seen-on-server (lead 2) — PROVED with a narrowed rule

`Seen`: appends write to the inode they opened; rotation renames live over previous.
`append_survives_one_rotation`, `append_keeps`. `two_rotations_lose`: an append is lost
only if two rotations (two full 8 MiB generations) happen between its open and write.
The module comment claimed "concurrent appends are never lost"; corrected to state that
limit. Mutation: rotation dropping prev → `append_survives_one_rotation` breaks.

## Comment corrections (remote-recall.ts)
`closeBreakerIfTrial` and the `< 500` comment said any answer below 500 closes the
breaker; an unclassified 4xx (400, 409, …) still counts and re-opens a trial's breaker.

## NEEDS-OWNER
- Should an unclassified 4xx (400, 405, 409, 410, 413 …) count toward the host breaker
  on both legs? (a) keep: counts like a 5xx (today; the recall request clamps `limit` to
  avoid a 400 for this reason); (b) treat every 4xx as a refusal: neither counts nor
  resets. Changing it touches `outbox.ts` (not owned here) as well.

## Not covered
Budget-timer arithmetic (`startBudgetTimer`) and remote-results dialing selection
(already tested) are not modelled. RECALL_BOOKKEEPING_LOCK_WAIT_MS is backed by the
existing L3 test in `recall-deadline-1586-audit.test.ts`.
