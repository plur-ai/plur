# Findings — Outbox delivery (field report 2026-09-29, cluster 3)

Model: `spec/formal/PlurSpec/Outbox.lean` (namespace `PlurSpec.Outbox`), plus
`R2CoreB.lean` §5–§7 for the remote-store surface it uses (see `r2-coreb.md`).
Check: `cd spec/formal && ~/.elan/bin/lake env lean PlurSpec/Outbox.lean` (exit 0,
no output; no `sorry`/`admit`/`axiom`/`native_decide`). Branch
`formal/field-report-2026-09-29`.

Tests (new): `packages/core/test/formal-fr-c3-outbox-delivery.test.ts` (9: 5 pass,
4 `it.fails` replays), `packages/core/test/formal-fr-c3-breaker.test.ts` (5: 4 pass,
1 `it.fails` replay). An `it.fails` test states the INTENDED behaviour and fails
today; the fix PR turns it into `it`. Each was also run with `it.fails` flipped to
`it` to confirm it fails on the duplicate assertion itself (`expected 2 to be 1`),
not on setup.

Run: `npx vitest run --testTimeout=60000 packages/core/test/formal-fr-c3-outbox-delivery.test.ts
packages/core/test/formal-fr-c3-breaker.test.ts packages/core/test/outbox-idempotency.test.ts
packages/core/test/outbox-breaker-refusal.test.ts packages/core/test/outbox-needs-action.test.ts
packages/core/test/feedback-source-remote.test.ts packages/core/test/outbox-flush-budget.test.ts`
→ 7 files passed, 56 passed, 5 expected fail.

Source files changed: none (this round's override: defects are reported with a replay test).

Model assumptions (not modelled): the 7-day dedup window; a server that
honours lookup-by-key but not POST dedup (or the reverse); a claim file that
cannot be written at all (the push then goes ahead unclaimed); a network
error AFTER the server stored the write that is neither a timeout nor a cut
(it would count as a silent landing, §3).

---

## 1. Exactly-once delivery per logical write

### 1-honour. Key-honouring server — **REFUTED (holds), given a stable key**

`honour_one_key`: for ANY number and interleaving of POSTs carrying one key —
retries, cut-offs, crashes, several flushers, learn()'s background push — the
server holds at most one row. `ignore_bound` adds that an entry is never
dropped locally before a copy is stored. So on an honouring server exactly-once
reduces to property 2 (one key per logical write). Neither leases nor claims are
needed for it (see conflict I). Counterexample when the key changes:
`honour_two_keys_dup`. Replay of the good case: `C1a good case` and `conflict I
(Outbox.honour_exactly_once)` (claim deleted, lease expired: still one row).

### 1-ignore. Key-ignoring server — the precise duplicate bound

`ignore_bound` (any design, any schedule of outcomes): **copies ≤ 1 + silent
landings**, where a silent landing is an attempt the server stored while the
client recorded a definite failure and kept the entry queued (not in doubt).
In-doubt entries are never posted again automatically on such a server: the
lookup answers `unknown` (`R2CoreB.KeyLookup.ignoring_server_unknown`), the
flush `continue`s, and after 5 checks the entry is `needs_action`.

- **Current code, no merge-back throws: at most ONE duplicate** —
  `current_no_throw_le_two` (≤ 2 copies for any first-push outcome followed by
  any flush outcomes). The only silent landing left is the first push.
- **Fixed design: exactly once** — `fixed_at_most_once` (≤ 1 copy, never
  dropped), non-vacuity `fixed_delivers`.

### 1a. First push timeout is not recorded in doubt — **CONFIRMED + NEEDS-OWNER (needs index.ts)**

learn()'s background push and learnRouted()'s direct write catch every error
the same way: queued with `last_error`, never `in_doubt`. The contract
(`docs/remote-store-contract.md`) names a timed-out write as in doubt, and the
flush does mark a `RemoteTimeoutError` in doubt — only the first leg does not.
learnRouted's comment ("if that POST did land … the retry is collapsed") relies
on the server honouring the key.

Theorem: `firstLeg_timeout_dup` (2 copies). Replays (key-ignoring stub; fetch
wrapper lets the POST reach the stub, then throws `RemoteTimeoutError`):
- `C1a … learnRouted()` → after one flush `server.engramCount` = 2 (expected 1).
- `C1a … learn()'s background push` → 2 (expected 1).
- Good case, honouring stub: 1 row, one key across both POSTs.

Proposed fix (index.ts, not in this cluster's files): in learn()'s push catch
and learnRouted()'s catch, set `_outbox.in_doubt = true` when
`err instanceof RemoteTimeoutError` (learn(): also `RemoteAbortedError`). The
model's `fixed.firstDoubt`.

### 1b. A thrown merge-back forgets that a cut push is in doubt — **CONFIRMED + NEEDS-OWNER (needs index.ts)**

`flushOutbox`'s `finally` releases every #1277 claim whose entry is not
`settled` (integration commit c329872d). A push cut by the budget or a timeout
is deliberately not `settled`, so if the merge-back then throws (store-lock
timeout, disk full) its in-memory `in_doubt` is never written AND its claim —
the only other record — is deleted. The next flush posts it unprobed.

Theorems: `thrown_merge_loses_doubt` (counterexample), `cut_recorded_no_dup`
(same cut, merge-back lands: probed). Replays (stub stores at once, answers
after 2 s; flush budget 200 ms; `_writeEngrams` throws once on the merge-back):
- `C1b … key-ignoring server` → 2 copies (expected 1).
- `C1b good case` → in doubt, not re-posted, kept (passes).

Proposed fix: keep the claim of every entry this flush marked in doubt or
minted a key for (a `keepClaim` set next to `settled`, used in the `finally`).
The model's `fixed.keepOnThrow`; `kept_claim_same_key`.

### Mutation check (§1)

- `fixed` with `firstDoubt := false` → `fixed_step_cases` stops proving (and the
  chain to `fixed_at_most_once`).
- honouring `post` without dedup → `honour_one_key` stops proving.

---

## 2. The key is unique per logical write and stable across retries

**Unique: REFUTED (holds).** Every key is `randomUUID()`: learn() mints it
before the row is written, learnRouted() before its POST and persists it with
the queued row, the flush only for an entry that has none
(`keyFor = row ?? orphan ?? fresh`, `row_key_stable`). Pinned by
`outbox-idempotency.test.ts` F1/F2.

**Stable: CONFIRMED + NEEDS-OWNER** for one path — an entry queued by a client
that predates keys (such entries exist on upgraded installs). The flush mints
its key at claim time and persists it only in the merge-back; with 1b's
throw, the claim holding it is released and the next flush mints another.
Honouring server → two rows.

Theorems: `thrown_merge_new_key`, `thrown_merge_dup` (counterexample),
`kept_claim_same_key` (fix). Replay: `C1b/C2 … key-honouring server` → two
distinct `Idempotency-Key`s, two rows (expected one). Same fix as 1b; the
cleaner variant writes a minted key onto the row under the store lock with the
lease, before any POST.

Mutation: releasing the claim in `afterThrow true` → `kept_claim_same_key` stops proving.

---

## 3. needs_action entries are never deleted or rescoped — **REFUTED (holds)**

Branch for branch (§8): a `needs_action` entry inside its back-off window on an
automatic flush, or an `unconfirmed` one, is neither leased nor dialled and
left as it was (`held_untouched`); once dialled (`force`, or after the window)
it takes exactly the branch a `retrying` entry takes — the verdict only enters
through the skip decision (`verdict_only_skips`, `force_dials_needs_action`) —
and a kept entry changes only bookkeeping (`kept_only_bookkeeping`).

Boundary, not a defect: the R2-D policy re-guard DEMOTES any dialled entry
(scope → `local`) whose content the target scope's CURRENT `sensitivity.forbid`
refuses. That is a policy verdict, applied to retrying and needs_action
entries alike, so the docstring's "never … for being needs_action" holds.
Pinned by `outbox-needs-action.test.ts` ("nothing is removed or rewritten",
"only retry bookkeeping changes").

Mutation: a failure branch that rescopes → `kept_only_bookkeeping` stops proving.

---

## 4. A 401/403/404/422 never counts toward the per-host breaker

**Write leg: REFUTED (holds)** — `write_refusal_never_counts`, non-vacuity
`write_5xx_counts`; pinned by `outbox-breaker-refusal.test.ts`. The in-process
host mark never fires on any answered status (`R2CoreB.FetchBounded`).

**Recall leg: CONFIRMED + NEEDS-OWNER** — `remoteRecall` feeds the SAME
persisted breaker (`remote-health.json`, #785) that `flushOutbox` obeys.
401/403/404/429 have their own branches, but a **422** goes through
`!res.ok → networkFailure` and counts. Three 422s open a 5-minute cooldown
that also parks queued writes to every scope on that host.

Theorem: `recall_422_counts` (counterexample), `recall_401_403_404_no_count`,
`recall_fixed_refusal`. Replay (`formal-fr-c3-breaker.test.ts`, mocked
`fetchImpl`, temp state file): 3 × 422 → `isHostInCooldown(...).inCooldown` =
true (expected false); 401/403/404 × 4 → false; 503 × 3 → true.

Question for the owner: should a recall 422 (the host answered "your request
is invalid") leave the breaker alone like the write leg's (#1308), or is a
recall 422 treated as a broken host on purpose? Options: (a) add 422 to the
recall refusal branches (neither count nor reset), (b) keep it and document
the asymmetry. The recall code already clamps `limit` so that "an over-limit
request would 400 and feed the breaker for a client-side mistake" — which
reads as (a).

Mutation: `writeCounts` counting 422 → `write_refusal_never_counts` stops proving.

---

## 5. Automatic feedback reaches a remote only when it advertises `feedback.source` — **REFUTED (holds)**

Both remote send sites in `Plur.feedback` (scope-targeted and the store walk)
call `driver.feedback` only after `remoteAccepts = !auto || hasCapability(...)`,
and `source: 'auto'` goes on the wire exactly when `auto`
(`R2CoreB.FeedbackPayload`). The id-collision guard does not dial for an auto
rating. `auto_only_to_capable`, non-vacuity `explicit_always_sent`,
`auto_capable_sent`. The capability is read once per (url, token) and cached
for the process; a failed `/me` caches "not capable". So "advertises" means
"advertised when this process first asked". Pinned by
`feedback-source-remote.test.ts`.

Mutation: `remoteAccepts := true` → `auto_only_to_capable` stops proving.

---

## Open conflict I — leases (#1228) vs per-entry claims (#1277)

**Result: for property 1, the claims are needed and, with one fix, enough.
The leases are not needed.**

| Server | Leases alone | Claims alone | Both (branch today) |
|---|---|---|---|
| honours the key | exactly once (key does it: `honour_one_key`) | exactly once | exactly once |
| ignores the key | **duplicate** after a crash/abandoned hook: `leases_alone_crash_dup`, replayed | at most once: `claims_suffice` (any number of pushers, any interleaving), with an atomic takeover | at most once; the takeover race is masked by the lease |

- **Leases alone are insufficient.** A lease is released or expires; nothing
  remembers that a POST was on the wire. After a crash or a force-exited hook
  (TTL 10 min), the next flush posts unprobed. Replay `conflict I
  (Outbox.leases_alone_crash_dup)`: process A's POST stored, A frozen; lease
  expired and claim file removed → 2 copies. Same with the claim kept and
  lapsed (`claims_orphan_probe`): 1 copy, entry kept in doubt.
- **Claims alone suffice** (`claims_suffice`, key-ignoring server, from a
  queued entry with nothing stored yet; the crash-with-a-stored-copy start is
  §3's `claims_crash_no_dup`): a pusher
  posts unprobed only while holding a claim it took from a free path; an
  orphan takeover marks the entry in doubt, so it probes and cannot post; a
  second unprobed claim cannot happen while one is flying
  (`no_second_flyer`). No timing assumption is needed: a claim that lapses
  mid-POST is taken over as an orphan, which probes (`claims_lapse_takeover`).
- **The one fix claims-alone needs:** the takeover in `_claimOutboxEntry` is
  `rmSync` then an O_EXCL write. Between the two the path is free, so a second
  claimer can take a FRESH, non-orphan claim and post unprobed while the first
  gets EEXIST (`nonatomic_takeover_loses_doubt`). Taking over by renaming a new
  claim file over the stale one keeps the path occupied, so every claimer over
  a stale claim is an orphan (`atomic_never_none`, `atomic_got_orphan_step`).
  Today the lease keeps two pushers off one row, which masks this; it is not
  replayable in one process (the claim code is synchronous).

**Recommendation:** keep the claims, drop the leases from the push path (or
keep them only as the advisory `leased_until` in `listOutbox`), and, in the
same change, (1) make the claim takeover atomic, (2) keep in-doubt/minted-key
claims on a thrown flush (1b), (3) mark first-leg timeouts in doubt (1a).
With the lease no longer taken under the store lock before the POST, the
failing cli-spawn test `hook-outbox-flush` › "a hook abandoned after its POST
landed…" gets its POST out before the merge-back waits for the lock — the
ordering it pins (not verified here; cli-spawn not run). The retire DELETEs
(D1) lose nothing: `removeIdempotent` treats 404/410 as done, so two
concurrent retirers are harmless. If the owner prefers to keep both, the
theorems say that is also safe (the lease only adds exclusion); the cost is
the lock wait before every POST and that failing test.

## Theorem index (Outbox.lean)

§1 `honour_one_key`, `honour_two_keys_dup` · §2 `thrown_merge_new_key`,
`thrown_merge_dup`, `kept_claim_same_key`, `row_key_stable` · §3 `inv_run`,
`ignore_bound`, `fixed_at_most_once`, `fixed_delivers`, `firstLeg_timeout_dup`,
`thrown_merge_loses_doubt`, `cut_recorded_no_dup`, `current_no_throw_le_two`,
`leases_alone_crash_dup`, `claims_crash_no_dup` · §4 `cinv_step`,
`claims_suffice`, `no_second_flyer`, `claims_deliver`, `claims_lapse_takeover` ·
§5 `nonatomic_takeover_loses_doubt`, `atomic_never_none`,
`atomic_got_orphan_step` · §6 `lease_excludes` · §7 `write_refusal_never_counts`,
`write_5xx_counts`, `recall_401_403_404_no_count`, `recall_422_counts`,
`recall_fixed_refusal` · §8 `held_untouched`, `kept_only_bookkeeping`,
`verdict_only_skips`, `force_dials_needs_action` · §9 `auto_only_to_capable`,
`explicit_always_sent`, `auto_capable_sent`.

Size: ~700 lines, above the brief's ~400 guide; §4 (the concurrency
invariant) is most of it. Left out: the supersedes remap, D1 retire ordering
and the id map (unchanged, modelled in R2CoreA/WritePath).

Mutation results (scratch copies, `lake env lean`): each mutation named above
made the named theorem stop proving; additionally an orphan takeover that
does not mark doubt, or that posts, makes `cinv_step` stop proving.
