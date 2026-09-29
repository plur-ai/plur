# WritePath findings — run of 2026-09-23 (origin/main 6200dbf6)

## Decision E7 applied (2026-09-26, ApplyCore) — contract for ApplySurface

- Export: `NO_SESSION` from `@plur-ai/core` (defined in `packages/core/src/session-scopes.ts`, re-exported from `index.ts`; core dist rebuilt). Value: the string `'\u0000plur:no-session'` — compare by identity with the import, never retype it.
- Semantics: pass it as `LearnContext.session` (learn / learnRouted), `RecallOptions.session`, or `InjectOptions.session_id`. `SessionScopeRegistry.get(NO_SESSION)` returns `null` — neither a keyed registration nor the process-default slot applies — so an unscoped write takes the genuinely-unscoped path (`_resolveUnscopedScope`: auto-route / `unscoped_default`; `scope_source` `'routed'` or `'default'`). An explicit `scope` still wins (`'explicit'`).
- `SessionScopeRegistry.set(scope, NO_SESSION)` (so `setSessionScope(..., { session: NO_SESSION })`) THROWS — a registration under the sentinel could never be read. `clear(NO_SESSION)` is a no-op.
- On inject, `session_id === NO_SESSION` is used only as the dial key; it is not written as `session_id` on the `co_injection` history event or used as the hook-dedup session key.
- Test: `packages/core/test/formal-apply-core-no-session.test.ts` (5; all 5 failed before — missing export / process default applied).

Model: `spec/formal/PlurSpec/WritePath.lean` (namespace `PlurSpec.WritePath`).
Check: `cd spec/formal && lake env lean PlurSpec/WritePath.lean` (clean, no sorry/axiom/native_decide).

## Candidate 1 — outbox delivery protocol races (core-index#1)

**Verdict: CONFIRMED + FIXED** (three distinct races, all replayed).

| Race | What happened on main | Replay test |
|---|---|---|
| A. learn() push in flight + flushOutbox | flush selected the same row (attempt_count 0) and POSTed it again → remote got the engram twice | `A:` |
| B. forget() during a flush POST that succeeds (#766) | merge-back dropped the pushed row unconditionally → local retirement record erased, remote holds a live copy of a forgotten engram, nothing reported | `B:` |
| B2. forget() during learn()'s own push | learn()'s hand-off spliced the row unconditionally → same erasure | `B2:` |
| C. local rescope during a flush POST that fails (#848) | failure arm copied the snapshot's `_outbox` over the cancellation → delivery to the store the engram left re-queued | `C:` |
| C2. forget() during a flush POST that fails | retired row got `_outbox` back | `C2:` |

Theorems (§1 of the model):
- `merge_honours_cancellation` — fixed merge: a forget/rescope landing during the push leaves exactly the row that forget/rescope wrote, for both push outcomes.
- `cancelled_never_requeued` — corollary: a cancelled row never comes out `stillQueued`.
- `merge_good_case` — non-vacuity: no interference ⇒ hand-off on success, still queued on failure.
- `old_success_erases_forget`, `old_failure_requeues_cancelled` — counterexamples on the pre-fix merge (= tests B, C, C2).
- `guarded_at_most_once` — via invariant `Inv` (`inv_init`, `inv_step`, `inv_run`): for EVERY interleaving of learn()'s push and a flush (start, finish ok/fail in any order), with the in-flight claim the remote receives the engram at most once.
- `guarded_delivers` — non-vacuity: it is delivered, and a failed first push is retried by the flush.
- `unguarded_double_delivery` — counterexample without the claim (= test A).

Replay (deterministic interleaving: `globalThis.fetch` mocked, POSTs held open until the test releases them, no real service):
```
npx vitest run packages/core/test/formal-writepath-outbox.test.ts
# on main (before fix):
#  × A  … the remote received the same engram twice: expected 2 to be 1
#  × B  … the flush deleted the local retirement record: expected undefined to be defined
#  × C  … the flush re-queued delivery to the store the engram left: expected { attempt_count: 2, target_scope: 'group:acme/team', … } to be undefined
#  × C2 … a retired engram regained its queue entry: expected { attempt_count: 2, … } to be undefined
#  Tests 4 failed | 1 passed (5)      (B2 added with the fix; fails with the learn-arm fix reverted, see mutation)
# after fix:
#  Tests 6 passed (6)
```

Fix (packages/core/src/index.ts):
- `_outboxInFlight: Set<string>` — learn() claims the id before its fire-and-forget push and releases it in `.finally`; `flushOutbox()` (now a wrapper around `_flushOutboxClaimed`) selects only unclaimed rows, claims them, releases in `finally`. Also serialises two concurrent flushes in one process.
- `Plur._stillQueued(e)` = flush's selection predicate (`_outbox && !retired`), re-checked on the FRESH row: in learn()'s hand-off (don't splice a cancelled row; warn), in the merge-back success arm (keep a cancelled row; push a warning naming the server id the remote assigned), and in the failure arm (don't copy the stale `_outbox` over a cancellation).

Tests: `packages/core/test/formal-writepath-outbox.test.ts` (6). Regression set run:
`npx vitest run packages/core/test/{formal-writepath-outbox,outbox,outbox-circuit-breaker,outbox-inspect,rescope-outbox-cancel,inject-counter-and-flush-merge,supersedes-flush-remap,rescope}.test.ts` → 8 files, 77 passed.

Mutation checks:
- Model: `if stillQueued fresh then` → `if true then` (the old merge) ⇒ `merge_honours_cancellation` fails (unsolved goals). `(!guarded || !s.activeL)` → `true` ⇒ `inv_step` fails.
- Code: removing the learn-arm `_stillQueued` check and the flush `_outboxInFlight` filter ⇒ tests A and B2 fail (2 failed | 4 passed); restored ⇒ 6 passed.

Residue / NEEDS-OWNER:
- **Q1 (NEEDS-OWNER): the stray remote copy.** When a forget/rescope lands while the POST is on the wire, the remote accepts the engram anyway. The fix now keeps the local record and reports it (flush warning names the server id; learn() logs a warning), but does NOT retire the remote copy. Options: (a) leave as report-only (current); (b) on this path call `driver.remove(serverId)` automatically (a destructive remote action, only safe if the server id is known — learn()'s `append` discards it today); (c) queue a remote-retire intent in the outbox.
- Cross-PROCESS double delivery is not covered by the in-process claim (two MCP servers flushing one store). Closing it needs an on-disk lease on the outbox row — a persisted-format change → NEEDS-OWNER if wanted.
- Out of scope, noted: a concurrent `updateEngram` edit to a still-queued row that is then pushed successfully is dropped with the row (the remote got the pre-edit statement). Pre-existing, not changed.

Follow-up (same candidate): the in-flight claim is released as soon as learn()'s POST FAILS (before its bookkeeping write), not in `.finally` only. Holding it through the bookkeeping made a flush issued ~60 ms after a failed learn skip the row under load (seen once as a flake of `supersedes-flush-remap.test.ts` in a parallel run). The model already matches this: `finish p false` deactivates the pusher. 3 consecutive runs of the 9-file outbox set: 80/80 each.

## Candidate 2 — invariant `_outbox ⇒ scope = _outbox.target_scope` (core-index#3)

**Verdict: CONFIRMED + FIXED at the egress point; one policy question NEEDS-OWNER.**

Two writers change `scope` on a queued row and leave `_outbox` naming the old target:
- `updateEngram()` local branch writes the caller's row as-is (public API; no in-repo caller changes scope, embedders can);
- cross-scope recurrence `applyMutation` (#176): second cross-scope hit on a queued `group:*` row → `isSharedScope` → `scope = 'global'`.

`flushOutbox()` then POSTed the row with its NEW scope in the body to the OLD target store.

Theorems (§2): `deliver_scope_matches_store` (for any sequence of update/broaden/rescopeLocal ops, every delivery of the fixed flush carries the scope of the store it is sent to), `deliver_good_case` (non-vacuity), `old_delivers_wrong_scope` (counterexamples: broaden → `("group:acme/team","global")`, update → `("group:acme/team","local")`).

Replay:
```
npx vitest run packages/core/test/formal-writepath-outbox-scope.test.ts
# on main:
#  × updateEngram moving a queued row …: a row scoped "local" was delivered to the team store: expected [ 'local' ] to deeply equal []
#  × cross-scope recurrence broadening …: delivered to group:acme/team's store under scope "global" (row scope was global)
#  Tests 2 failed | 1 passed (3)
# after fix: Tests 3 passed (3)
```

Fix (index.ts, `_flushOutboxClaimed`): a row whose `scope !== _outbox.target_scope` is NOT pushed; it stays queued (non-destructive) and the flush warns "NOT pushed — its scope is now X but it was queued for Y. Rescope it …". Covers every writer (updateEngram, recurrence, hand edits, older clients), like the existing retired-row guard.

Tests: `packages/core/test/formal-writepath-outbox-scope.test.ts` (3).
Mutation: model — dropping the `if r.scope = t` guard ⇒ `deliver_scope_matches_store` fails; code — disabling the guard ⇒ 2 of 3 tests fail.

NEEDS-OWNER:
- **Q2: cross-scope recurrence on a row still queued for a team store.** Today the second cross-scope hit broadens it to `global` locally; with the fix it is then held back with a warning, so the team never gets it until someone rescopes. Options: (a) keep as is (held + warning); (b) do not broaden a row that carries `_outbox` — treat it like a remote-resident hit, whose broadening `_recordCrossScopeRecurrence` already never persists; (c) broaden and cancel the team delivery (drop `_outbox`); (d) broaden locally but deliver to the team under the target scope.
- **Q3: `updateEngram()` changing scope of a queued row.** Options: (a) keep hold-and-warn at flush (current); (b) mirror rescope: cancel `_outbox` when the new scope is local-family, retarget it when the new scope has a writable url store; (c) reject scope changes in updateEngram and point to rescope().

## Candidate 3 — auto-route + leak-guard pipeline (core-index#6, core-policy#2, core-policy#11)

**Verdicts:**
- Pipeline properties P1–P3: **REFUTED as bugs = proved** (the claims hold).
- core-policy#2 (auto-route into a REMOTE-backed personal scope): **CONFIRMED behaviour, NEEDS-OWNER (policy)** — pinned, not changed.
- core-policy#11 (`scope_source` forwarded unvalidated): **CONFIRMED + FIXED**.
- core-index#6 sub-suspicion (learnRouted re-resolves in learn() after `reloadConfigIfChanged`, so `_routed` for scope A could be stamped on an engram placed in B): **DOWNGRADED / not replayed** — needs the config file to change between two resolutions inside one `learnRouted` call; the persisted `_routed` is written by the inner learn() consistently with its own placement, and only the returned object is re-stamped by learnRouted. Cannot be closed by passing the resolved scope into learn(), because that would record `scope_source: 'explicit'` (#1221). Residual TOCTOU, left as is.

Theorems (§3):
- `decideRoute_not_shared`, `guard_shared_of`, `resolve_unscoped_not_shared` (lemmas).
- `final_shared_needs_human` (P1): final scope shared ⇒ source ∈ {explicit, session} ∨ `allow_shared_auto_route`, for any candidates and any scanner, given `WF` (fallback is `local|global` per the config schema's `z.enum`, and `local` never leaves the machine).
- `no_offending_egress` (P2): a final scope that leaves the machine (shared ∨ remote-backed) is never offending — whatever the source.
- `preview_is_write_decision` (P3): for an unscoped write the resolved scope is `previewAutoRoute`'s scope, or the default when the preview routes nowhere (the guard may still demote afterwards; the preview does not claim otherwise).
- `route_good_case` (non-vacuity), `routed_into_remote_personal` (core-policy#2 witness: an unscoped write is ROUTED to a url-backed `user:*` scope and leaves the machine with `allow_shared_auto_route` off).
- `wire_scope_source_valid`, `wire_scope_source_good`, `wire_scope_source_old_forged` (§3b).

Replay: `npx vitest run packages/core/test/formal-writepath-route.test.ts`
```
# on main:
#  ✓ PINS current behaviour: an unscoped write auto-routes into a url-backed personal scope and is POSTed
#      (POST body scope 'user:me', scope_source 'routed')
#  × scope_source outside the four ScopeSource values is not forwarded:
#      an arbitrary caller-set string rode the wire as scope_source: expected 'approved-by-admin' to be undefined
#  Tests 1 failed | 2 passed (3)
# after fix: Tests 3 passed (3)
```
Path of the forgery: `updateEngram()` writes caller-supplied `structured_data` on a queued row; `flushOutbox()` → `appendAndGetServerId` read `_scopeSource` as `string` and sent it. (`learn`/`learnRouted` cannot inject it: `_buildEngramShape` overwrites `structured_data`.)

Fix (packages/core/src/store/remote-store.ts): `scope_source` is forwarded only when it is one of `explicit|session|default|routed` (`SCOPE_SOURCES`, typed from `ScopeSource` via a type-only import); anything else is omitted — the same answer as a pre-#1221 engram.
Not changed: `_scopeSource` / `_routeRefused` / `_rescoped` are absent from `PLUR_BOOKKEEPING_KEYS` (content-fields.ts). Adding them would EXEMPT caller-settable keys from the scan, and `structured_data` never crosses the wire (appendAndGetServerId does not send it; rescope's copy strips `_` keys), so scanning them costs at most a false demotion. Left as is deliberately.

Tests: `packages/core/test/formal-writepath-route.test.ts` (3). Also run: `route-unscoped`, `leak-surface`, `write-path-consolidation`, `remote-routing` suites — pass. `npx tsc --noEmit -p packages/core` clean.
Mutation (model): removing the shared-skip in `decideRoute` ⇒ `final_shared_needs_human` and `route_good_case` fail; guard keyed on `isShared` only (dropping remote-backed) ⇒ `no_offending_egress` fails; `wireScopeSourceNew` = identity ⇒ `wire_scope_source_valid` fails. Code: the pre-fix run above is the code mutation (1 failed).

NEEDS-OWNER:
- **Q4: should auto-routing into a REMOTE-backed personal scope (url store, `user:*`/`agent:*`) be refused like shared scopes (#1115)?** The #1115 rationale — "pushed to its remote, where local cleanup could not undo it" — applies to a url-backed personal scope too, while `decideAutoRoute`'s docstring deliberately keeps personal routing ("a user whose personal `user:*` scope declares covers keeps the routing they had"). The leak guard already covers remote-backed scopes for sensitive content. Options: (a) keep (current, pinned by the test); (b) refuse remote-backed candidates unless a new opt-in (`allow_remote_auto_route`), falling to the next local candidate; (c) route but queue for confirmation. Covers can come from the server's `/me` (remote-store.ts `listScopeMetadata`), so under (a) the server partly decides where unscoped writes go.

## Candidate 4 — "private engrams stay local", three predicates (core-index#2)

**Verdict: CONFIRMED + FIXED (explicit private on learnRouted); NEEDS-OWNER on what the DEFAULT private means for a remote-backed write.**

The three egress predicates on main:
- `learn()`: remote iff remote-backed ∧ caller did NOT pass `visibility: 'private'` (#90 branch, warns and writes locally).
- `learnRouted()` (the primary path: `plur_learn`, CLI): remote iff remote-backed — visibility never read.
- `sync.ts pushKeep('shared')`: push iff `isSharedScope` ∧ RESOLVED visibility ≠ private (default private, #401).

So an explicit `visibility: 'private'` team-scope write left the machine via learnRouted but not via learn. The MCP schema describes `visibility` as "Whether this memory may leave this machine"; learn()'s #90 comment says "Private engrams stay local". Both callers agree on intent, so the fix aligns learnRouted with learn.

Theorems (§4): `write_paths_agree` (learnRouted = learn on every input, fixed), `explicit_private_stays_local` (no egress on any of the three paths), `team_write_still_pushed` (non-vacuity), `old_learnRouted_pushes_private` (counterexample, replayed), `default_private_diverges` (policy witness for Q5).

Replay: `npx vitest run packages/core/test/formal-writepath-private.test.ts`
```
# on main:
#  ✓ learn(): an explicitly private team-scope write is not POSTed (the #90 reference behaviour)
#  × learnRouted(): the same input is not POSTed either — learnRouted sent an explicitly private engram to the remote: expected 1 to be +0
#  ✓ good case: a team write that did not say private still reaches the remote via learnRouted
#  Tests 1 failed | 2 passed (3)
# after fix: Tests 3 passed (3)
```

Fix (index.ts `learnRouted`): `if (!remoteDriver || context?.visibility === 'private')` takes the local route, where learn() applies its existing #90 branch (local write, warning). Explicitly private team-scope engrams now sit locally with their team scope and no `_outbox`, exactly as learn() already did.

Tests: `packages/core/test/formal-writepath-private.test.ts` (3). Regression set (formal-writepath-private, remote-routing, write-path-consolidation, leak-surface, outbox, plur, local-scope-never-routes-remote, guard-remote-scope, guard-remote-boundary): 9 files, 202 passed.
Mutation: model — `learnRoutedEgressNew := remoteBacked` ⇒ `write_paths_agree`, `explicit_private_stays_local` fail; code — reverting the condition ⇒ 1 failed | 2 passed; restored ⇒ 3 passed.

NEEDS-OWNER:
- **Q5: what does the DEFAULT visibility (private, #401) mean for a write to a remote-backed team scope?** Today the store write path pushes it (only an EXPLICIT private stays local), while shared git sync excludes it, and the MCP schema says private = "may not leave this machine". Options: (a) keep: visibility governs packs and git sync only, explicit private is the one opt-out on the store path (current, after this fix); (b) make the store path honour the resolved default too — every team-scope write would need `visibility: 'public'` to reach the team store (breaking change for all agents); (c) default visibility to `public` when the scope is remote-backed/shared; (d) reword the MCP `visibility` description to say what the store path actually does.
- Minor, same family: an explicitly private team-scope engram written locally keeps `scope: group:*` with no outbox, so it never reaches the team and is not marked local. Options: keep, or rewrite scope to `local` like the leak-guard demotion.

## Candidate 5 — tension gate fails open (core-index#5) and readonly tension mutators (core-index#4)

**Verdict: both CONFIRMED + FIXED.**

5a. `hasUnresolvedTension` wrapped `loadTensions` in `catch { return false }`. `loadTensions` throws on an unreadable file on purpose (#794 F1: never read a corrupt store as empty); the consumer turned that back into "no tension", so a truncated `tensions.yaml` let contradicted knowledge escalate `decided → locked` — the outcome #181 / audit #213 item 3 exists to prevent. Fix: fail closed (return true, log a warning); a MISSING file still reads as no tensions (the parser returns [] for it), so installs without tensions are unaffected.

5b. `recordTensions`, `confirmTension`, `dismissTension`, `resolveTension` had no `_assertWritable()` (`readonly.test.ts` "the remaining mutators" omits them), and tensions.yaml is written with `atomicWrite`, outside the ReadonlyStoreGuard — so a readonly instance (#731) rewrote it. `resolveTension` wrote its claim before failing on the engram store and then rolled back (a second write, errors swallowed). Fix: `_assertWritable()` first in all four (before the claim in `resolveTension`).

Theorems (§5): `lock_only_when_known_clean` (escalation INTO locked only if the file is missing or read and clean), `lock_good_case` (non-vacuity), `old_unreadable_locks` (counterexample); `readonly_no_write`, `writable_still_writes`, `old_readonly_writes`.

Replay: `npx vitest run packages/core/test/formal-writepath-tension.test.ts`
```
# on main:
#  ✓ good case: a READABLE unresolved tension blocks lock escalation
#  × an UNREADABLE tensions.yaml does not let the engram lock — unreadable tension file answered "no tension": expected false to be true
#  ✓ a missing tensions.yaml still means no tension (the engram may lock)   [shows the same ladder reaches 'locked' when the gate says false]
#  × readonly: tension mutators throw ReadonlyStoreError … — expected function to throw an error, but it didn't
#  Tests 2 failed | 2 passed (4)
# after fix: Tests 4 passed (4)
```

Tests: `packages/core/test/formal-writepath-tension.test.ts` (4). Regression set (readonly, tension-lifecycle, tensions, tensions-e2e, purge-tensions, tensions-temporal, tensions-measured-under-gate + this): 8 files, 222 passed.
Mutation: model — `.unreadable => false` ⇒ `lock_only_when_known_clean` fails; code — the pre-fix run above (same two assertions fail).

Residual (not changed): `resolveTension`'s rollback failure is still swallowed (`catch {}`), leaving a resolved record with a live loser if both the retire and the rollback fail; the original error is still thrown. Quarantined (schema-invalid) tension records naming the engram are not consulted by the gate.

## Candidate 6 — rescope "atomic semantics" (core-index#11)

**Verdict: CONFIRMED + FIXED** (the push-failure half of the contract already held; the two defects are in the push-LANDED half).

- Push landed, then `_retireRescopedSource` threw (store unwritable, lock EACCES): the exception escaped `rescope()` — the remaining ids never ran, the per-id results were lost, and nothing reported that a copy now exists at the target (a retry pushes a second copy).
- Source vanished (another process forgot+compacted it) or was already retired during the push: `_retireRescopedSource` returned silently but `engram_retired` history was still appended — a retirement that did not happen (the #855 rule: history must not record one).

Theorems (§6): `rescopeOneNew_total`, `batch_new_complete` (every id gets a result; the batch never aborts), `rescope_one_reports` (a landed push always carries its server id; `engram_retired` history ⇔ push landed ∧ retire happened; `rescoped` ⇒ push landed ∧ retire did not fail), `rescope_good_case` (non-vacuity), `old_batch_aborts`, `old_vanished_history` (counterexamples).

Replay (fetch seam: the fake remote acts inside its POST handler — chmods the store dir to 0555, or has a second Plur instance forget --force + compact):
`npx vitest run packages/core/test/formal-writepath-rescope.test.ts`
```
# on main:
#  × a push that lands but whose local retire fails … — rescope threw instead of reporting per id: Error: EACCES: permission denied, open '…/engrams.yaml.lock'
#  × a source that vanished during the push … — history records a rescope retirement that never happened: expected [ { event: 'engram_retired', … } ] to deeply equal []
#  ✓ good case
#  Tests 2 failed | 1 passed (3)
# after fix: formal-writepath-rescope + rescope + rescope-outbox-cancel: 23 passed
```

Fix (index.ts): in `_rescopeOne`'s remote route the retire is wrapped; a failure returns `status: 'error'` WITH `new_id` and a message saying both copies are active and to retire the source rather than re-run the rescope. `_retireRescopedSource` now returns whether it retired anything, treats a missing OR already-retired row as nothing-to-do, and appends history only when it did. `npx tsc --noEmit -p packages/core` clean.

Tests: `packages/core/test/formal-writepath-rescope.test.ts` (3).
Mutation: model — `.landed, .throws => none` ⇒ `rescopeOneNew_total`/`batch_new_complete` fail; `.vanished` with history ⇒ `rescope_one_reports` fails. Code — the pre-fix run above.

## Files changed (whole run)

- packages/core/src/index.ts — candidates 1, 2, 4, 5, 6
- packages/core/src/store/remote-store.ts — candidate 3 (`scope_source` validation)
- New tests: packages/core/test/formal-writepath-{outbox,outbox-scope,route,private,tension,rescope}.test.ts
- spec/formal/PlurSpec/WritePath.lean (651 lines; 6 sections, one per candidate; no sorry/axiom/native_decide)
- Not touched: content-fields.ts, session-scopes.ts (no confirmed defect needed them).
- Suggested `verify.yaml` entry (file not owned by this agent): `{ model: PlurSpec/WritePath.lean, covers: [packages/core/src/index.ts, packages/core/src/store/remote-store.ts] }`.

## Decision E1 applied (2026-09-26, ApplyCore): me-only — answers Q4

- Code: `scope-routing.ts` `decideAutoRoute` gains `refuseScope?: (scope) => boolean`; a NON-shared candidate it flags is refused exactly like a shared one (`action: 'refuse-shared'`, `refusedShared`), whatever `allowSharedScope` says. `index.ts`: `_refuseRemotePersonalAutoRoute(s) = _isRemoteBackedScope(s) && !_isOwnRemoteNamespace(s)`, passed by BOTH `_resolveUnscopedScope` (write) and `previewAutoRoute` (plur_suggest_scope). `_isOwnRemoteNamespace`: the url store backing the scope (exact match, same rule as `_isRemoteBackedScope`) has a remembered `/me` identity and the scope, case-folded, is `user:<username>` or `user:<org_id>:<username>` or a segment-descendant (`isScopeWithin`). `agent:*` is never own. The identity map (`_meIdentities`, in memory, keyed normalized-url::token) is filled by every successful `/me` in `discoverRemoteScopes` / `checkRemoteHealth` and dropped when a later `/me` for that key fails → unknown ⇒ refuse (fail closed).
- Model (WritePath §3): `Env.own` oracle; `decideRoute` skips `¬shared ∧ remoteBacked ∧ ¬own`. New: `decideRoute_remote_personal_is_own`, `routed_leaves_only_own` (P4: with allow_shared off, a routed scope that leaves the machine is the user's own), `refused_foreign_remote_personal`, `routed_into_own_remote_personal` (non-vacuity), `old_routed_into_remote_personal` (pre-E1 counterexample; replaces `routed_into_remote_personal`). `decideRoute_not_shared` re-proved for the extra branch. Mutation: dropping the E1 branch ⇒ `decideRoute_remote_personal_is_own` and `refused_foreign_remote_personal` fail.
- Tests: new `packages/core/test/formal-apply-core-me-only.test.ts` (9; 6 failed before). Changed: `formal-writepath-route.test.ts` "PINS current behaviour … auto-routes into a url-backed personal scope and is POSTed" → now asserts the refusal (it pinned the pre-decision policy on purpose); `remote-routing.test.ts` "reports routed when the router picked the destination" → primes `/me` (username `plur-me`) via `discoverRemoteScopes()` before the write, so it still exercises `scope_source: 'routed'`.
- Open (question): is `user:<username>` / `user:<org_id>:<username>` the server's actual naming of a user's own namespace? The client has no other mapping; if the server uses another shape, own scopes will be refused (fail closed), never over-admitted.

## Decision D1 applied (2026-09-26, ApplyCore): queue-retire — answers Q1

- Code (index.ts): learn()'s fire-and-forget push now uses `appendAndGetServerId` and keeps the server id. When a push LANDS on a row that is no longer queued (forget/local rescope during the push) — learn()'s hand-off and the flush merge-back filter — `Plur._queueRetireRemote` stamps `structured_data._retireRemote = { target_url, target_scope, server_id, queued_at, last_attempt, attempt_count, last_error }` on the kept row (durable, in engrams.yaml). `_flushOutboxClaimed` selects rows carrying it (claimed in `_outboxInFlight` like pushes), DELETEs `server_id` on the store matching url+scope via the new `RemoteStore.removeIdempotent` (2xx → removed, 404/410 → already gone, both done; else throws → entry kept with attempt bookkeeping), appends `engram_retired` history (routed_to remote), and merges the outcome only onto a row whose entry still names the same server id. Never POSTs (cannot resurrect); a second entry for the same server id is a no-op (idempotent); `compact()` keeps a retired row until its entry is done (survives restart AND compaction). `_retireRemote` added to `PLUR_BOOKKEEPING_KEYS` (content-fields.ts) — it carries `target_url` like `_outbox`.
- Model (WritePath §1a'): `mergeD1`/`flushOneD1` — `cancel_during_landed_push_queues_retire` (a cancellation during an accepted push leaves the cancelled row AND a queued retire; a refused push queues none), `no_retire_without_cancel` (non-vacuity), `retireStep`/`retireRun` — `retire_done_is_final` (idempotent: a done entry issues no DELETE), `retire_retries_then_done`. Mutations: not queuing on landed-cancel ⇒ `cancel_during_landed_push_queues_retire` fails; a done entry issuing a DELETE ⇒ `retire_done_is_final` fails.
- Tests: new `packages/core/test/formal-apply-core-retire-remote.test.ts` (4; all failed before): flush path (DELETE once, no re-POST, second flush issues nothing), learn() path (server id kept), failed DELETE retried after a restart with 404 counted as done, local rescope during the flush POST. Regression: formal-writepath-outbox, outbox, outbox-circuit-breaker, outbox-inspect, rescope-outbox-cancel, inject-counter-and-flush-merge, supersedes-flush-remap, rescope, formal-writepath-rescope, remote-routing, leak-surface — 159 passed.
- Residue: `listOutbox()` / `plur_outbox` do not list pending retirements (surface is ApplySurface's; question below). A caller of `updateEngram` can write `structured_data._retireRemote` (like `_outbox` today) — D4's change below makes updateEngram keep the stored row's `_retireRemote` and ignore the caller's.

## Decision D3 applied (2026-09-26, ApplyCore): no-widen — answers Q2

- Code (index.ts `_recordCrossScopeRecurrence` → `applyMutation`): a shared-scope row that still carries `_outbox` is never widened to `global`; the recurrence (count, write_count, source, commitment ladder) is recorded, the scope is not — same rule as a remote-resident hit. An unqueued shared row still widens (control test).
- Flush-time hold-back (`scope !== _outbox.target_scope` → not pushed, warned): KEPT as defence — still reachable by a hand-edited engrams.yaml, an older client sharing the store, or an `updateEngram` that keeps the scope but supplies its own `_outbox`. The model proves it is defence only for in-process writers (`holdback_is_defence`). Comment updated.
- Model (WritePath §2b): `applyScopeOpD` (broaden is a no-op on a queued row), `QInv`, `applyScopeOpD_inv`, `ops_preserve_inv` (every sequence of update/broaden/rescopeLocal keeps `_outbox ⇒ scope = target`), `holdback_is_defence`, `retarget_delivers` (non-vacuity). Mutation: unconditional broaden ⇒ `applyScopeOpD_inv` and `retarget_delivers` fail.
- Test: `packages/core/test/formal-apply-core-queued-scope.test.ts` "D3: …" (failed before: scope widened to global) + control.

## Decision D4 applied (2026-09-26, ApplyCore): like-rescope — answers Q3

- Code (index.ts `_updateEngramReturning` local branch → new `_reconcileQueuedScope(stored, toWrite)`): when the STORED row carries `_outbox`, is not retired, and the update changes the scope — new scope local-family (`isLocalOnlyScope(scope, stores)`, E4-aware) → `_outbox` dropped (warning); a writable url store for the new scope → `_outbox` retargeted (`target_url`, `target_scope`, attempts reset); otherwise (no store / readonly only) → dropped with a warning. The leak guard (`_guardExplicitUpdate` against the new scope) runs first; a demotion lands on `local` and so cancels. The queue entry and the D1 `_retireRemote` entry are taken from the STORED row, never from the caller's object (a caller-set `_retireRemote` would direct a remote DELETE).
- Model: same §2b (`update` case of `applyScopeOpD`). Mutations: retarget keeping the old target ⇒ `applyScopeOpD_inv` + `retarget_delivers` fail; local-family keeping the entry ⇒ `applyScopeOpD_inv` fails.
- Tests: `formal-apply-core-queued-scope.test.ts` D4 cases (local-family cancel, retarget to a second url store delivered there under the new scope, leak-guard demotion cancels, readonly-only scope cancels, same-scope edit keeps the entry) — 4 failed before. Changed: `formal-writepath-outbox-scope.test.ts` "updateEngram moving a queued row to another scope…" — its precondition pinned "still queued for the team" (pre-D4); now asserts the entry is cancelled at update time; the "never POSTed to the team store" assertion is unchanged.

## Round-2 drift review (2026-09-27)

Drift check flagged `WritePath.lean` after round 2 changed `packages/core/src/index.ts` and
`store/remote-store.ts` (`git diff a831872b..HEAD`). Each section re-read against the current
code; verdicts: (a) still holds, (b) superseded and relabelled, (c) updated and re-proved.
Every section got a "Checked against round 2" line in its docstring. No theorem changed; all
counterexamples kept.

| § | Verdict | Why |
|---|---------|-----|
| 1a merge-back | a | merge-back, forget's `_outbox` strip and rescope's local route are not in the round-2 diff; the flush only reloads config first and `outboxCount` = `listOutbox().length` |
| 1a' D1 retire queue | a | `_queueRetireRemote` and the DELETE loop are unchanged; round 2 only lists these entries (`kind: 'retire'`) |
| 1b two pushers | a | `_outboxInFlight` claim unchanged; the cross-process lease (D2/F3) is not on this branch |
| 2 / 2b `_outbox ⇒ scope = target` | a | flush hold-back, `_reconcileQueuedScope` and D3 are unchanged; Decision A and the core-index#8 secondary-store persistence do not write a queued row's scope |
| 3 auto-route + leak guard | a | scope-routing.ts unchanged; E1 me-only was already in the model; `_guardSensitiveScope` now reloads config on every path, which is the model's one-`Env` assumption (current-config property: R2CoreA §4 `egress_current_policy`) |
| 3b `scope_source` on the wire | a | remote-store.ts round-2 changes (loader-marker strip, load-page errors) do not touch `appendAndGetServerId` |
| 4 private stays local | a | the learn()/learnRouted() visibility tests and `pushKeep('shared')` are unchanged |
| 5 tension gate, readonly | a | `hasUnresolvedTension` still fails closed; mutators still `_assertWritable()`; tensions.ts changed only `engramOrigin` |
| 6 rescope per-id reporting | a | `_rescopeOne` / `_retireRescopedSource` unchanged (only a comment added in `rescope`) |

`lake env lean PlurSpec/WritePath.lean`: clean.

## Decision D2 applied (2026-09-27, branch `formal/outbox-lease`) — on-disk outbox lease

The owner first accepted the cross-process gap of candidate 1 (2026-09-26, "a full fix changes the outbox row's persisted format"), then chose to ship format changes as separate PRs. This is that PR (`spec/formal/issues/outbox-lease.md`).

- Format (additive): `structured_data._outboxLease = { holder, expires_at }`. New module `packages/core/src/outbox-lease.ts` (`leaseFree`, `canStartPush`, `dropOwnLease`, TTL 10 min, margin 2 min). Rows without the field are unleased; older clients ignore it.
- `_flushOutboxClaimed` (index.ts): selection now happens UNDER the store lock and records a lease on every row it will push or retire (`_retireRemote` too); rows with a live foreign lease are skipped; a push/retire starts only while `canStartPush`; the merge-back releases this flush's own leases (success, failure, or not attempted) and runs whenever anything was leased. The pushed copy never carries the lease.
- `learn()` remote branch: the row is written already leased (the push starts at once); the failure bookkeeping and the cancelled-during-push hand-off release it.
- `content-fields.ts`: `_outboxLease` added to `PLUR_BOOKKEEPING_KEYS` (never scanned as content, stripped from pack exports). `_reconcileQueuedScope` keeps the stored lease and drops a caller-supplied one.

Model (§1c of `PlurSpec/WritePath.lean`): processes of any type with decidable equality; events take / start / finish ok|fail / abandon / crash / tick. Invariant `LInv` (`linv_init`, `linv_step`, `linv_run`), `pushing_unique`.
- `leased_at_most_once_across_processes` — for any number of processes, any TTL, any margin > 0 and every interleaving, the remote receives the engram at most once.
- `live_foreign_lease_blocks`, `expired_lease_taken_over` (a crashed holder does not block forever), `finish_releases_lease`.
- `leased_delivers` (non-vacuity: delivery; takeover after a crash; retry after a failed push).
- `pre_lease_cross_process_double_delivery` — the pre-lease counterexample (two processes, two deliveries). `guarded_at_most_once` (§1b) is kept and now says "per process".
- Assumptions, stated in the model and in `outbox-lease.ts`: one clock (skew within the margin); a push unanswered for the margin has failed (requests are bounded at 30 s); `finish` (remote accept + merge-back) is atomic — a kill between the two re-delivers after the TTL, the at-least-once edge the single-process path already had.

Replay: `npx vitest run packages/core/test/formal-outbox-lease.test.ts` — two `Plur` instances on one directory (separate in-memory claims, one store file), the in-process HTTP stub counting POSTs/DELETEs, one POST held open on the stub while the other instance runs.
```
# before (base verify/formal-lean):
#  × two processes flushing concurrently push a queued row at most once — B pushed a row A holds a live lease on: expected 1 to be +0
#  × a flush in another process skips a row whose learn() push is in flight — expected undefined to be truthy
#  × a crashed holder does not block forever … — expected 1 to be +0
#  × retire-on-remote entries honour a live foreign lease … — expected 1 to be +0
#  × the lease is bookkeeping, never content … — expected false to be true
#  Tests 5 failed | 3 passed (8)
# after: Tests 8 passed (8)
```

Mutation checks:
- Model (scratch copies): `leaseFree` ignoring the lease ⇒ `linv_step`, `live_foreign_lease_blocks`, `leased_delivers` fail; no expiry takeover ⇒ `expired_lease_taken_over` (and `linv_step`, `leased_delivers`) fail; no margin check on `start` ⇒ `linv_step` fails; an overdue push not timed out ⇒ `linv_step` fails; `finish` keeping the lease ⇒ `finish_releases_lease`, `linv_step`, `leased_delivers` fail.
- Code: the flush's lease filter disabled (`true || leaseFree(…)`) ⇒ 4 of 8 lease tests fail; restored ⇒ 8 passed.

Not done: an older client that does not know the lease still pushes a leased row (the lease protects between clients that know it). `listOutbox()` does not show who holds a lease.

## Audit fixes for #1231 (2026-09-27, branch `formal/outbox-lease`)

An independent review of the lease PR confirmed three findings and raised four unconfirmed ones. Each fix has a failing test first (`packages/core/test/formal-outbox-lease.test.ts`, "finding N"); replays use the reviewer's scripts (real processes, a fast shared clock where noted, the in-process HTTP stub).

1. **HIGH — stale clock for the lease.** `_flushOutboxClaimed` read `Date.now()` for the lease BEFORE waiting for the store lock. After a long wait, a lease another process wrote meanwhile looked more than `TTL + M` away, and `leaseFree`'s far-future clause treated it as free: both processes POSTed. Fix: the clock is read inside the lock, after the load. Replay `repro-stale-now.ts` (a 130 s lock hold, the other process waiting on the file lock): before 2 POSTs, after 1 POST. Model: the far-future clause is now in `leaseFree` (§1c); `take` carries the clock reading; `stale_clock_double_delivery` is the counterexample for a reading taken before the lock.
2. **MEDIUM — merge-back after the lease.** The flush hands rows off once, at the end of the batch; the margin (2 min) covered one request but not the wait for the store lock, so a merge-back queued behind a long lock holder landed after the lease had expired and another process re-pushed rows the remote had already accepted. Chosen fix: widen the margin to cover everything between a push's start and the hand-off — request (30 s) + store-lock wait (the file lock's own acquire timeout, 180 s) + write (30 s) + skew (60 s) = 5 min (`OUTBOX_LEASE_MARGIN_MS`, built from those constants). Per-row hand-off was rejected: it needs the same lock wait, so the same bound, and costs a full store write per pushed row (finding 3). Replay `repro-merge-late.ts` (17 rows, 29 s POSTs, fast clock ×5, the lock held 175 s from the batch's last push): before 34 POSTs, 17 statements delivered twice; after 11 POSTs, each delivered once, 6 rows left queued for the next flush ("lease ran short"). Model: `finish` is split into `respond` (the remote accepts: one delivery, a hand-off owed) and `merge` (the merge-back), with the bound `R + W ≤ M`; `short_margin_double_delivery` is the counterexample for the old margin.
   - Not fixed, by design: the reviewer's literal scenario holds the store lock for the whole 10-minute lease, past the lock's 180 s acquire timeout. The merge-back then fails ("Failed to acquire lock") and the rows it owed are delivered again once the lease expires (after: 11 statements twice, and the flush reports the failure; before: 17 twice, silently). A lock held past its acquire timeout already fails every other writer; the model names this `lost` and `lost_handoff_double_delivery` shows the edge. The merge-back now also warns when it finds another holder's lease on a row it delivered.
3. **MEDIUM (perf) — a flush that attempted nothing rewrote the store twice.** Rows are routed before they are leased: a row held back (scope mismatch), with no configured store, or whose host is in cooldown is reported exactly as before but neither leased nor claimed, and a flush that leased nothing skips the merge-back. Replay `perf-cooldown.ts` (5,000 engrams, one queued row, breaker open): before 785–849 ms and 2 full-corpus writes per flush; after 197–221 ms and 0 writes (base `verify/formal-lean`: 190–220 ms, 0 writes).
4. Unconfirmed items:
   - A throw between leasing and the merge-back left the leases on disk for a TTL. Fixed: `flushOutbox()` releases, best effort, the leases of rows the remote had not accepted (`_releaseOutboxLeases`); a row it had accepted keeps its lease, which is what stops another process re-delivering it. Test: "finding 4".
   - A short-lived process whose `learn()` exits during its immediate push leaves the row leased. Replayed (`repro-cli-learn.ts`: a child process learns into a slow remote and exits at once): the row stays leased, another process's flush skips it — and the remote DID receive the child's POST, which was on the wire. Releasing the lease would have duplicated it. Kept, documented: delivery by another process waits up to the TTL, never duplicates within it. (`plur learn` itself uses `learnRouted`, which awaits the POST and writes no lease.)
   - The forged-lease test used a 2099 expiry, which the far-future clause ignores anyway, so its `flushed === 1` held vacuously. It now forges `now + 9 min`.
   - `listOutbox()` reported `leased_until` for this instance's own in-progress push while the comment said "another flush". Kept the behaviour (a push this instance has on the wire is in progress too) and fixed the comment; a test pins it.

Model (§1c, `PlurSpec/WritePath.lean`): phases idle / leased / pushing / handing / lost; events take (with clock lag) / start / respond ok|fail / merge / abandon / crash / tick; config `LCfg` (leased, fresh, T, M, R, W). Invariant `LCore` under `NoLost` (`linv_init`, `lost_persists`, `linv_step`, `linv_run`). `leased_at_most_once_across_processes` — lease honoured, fresh clock, `0 < R`, `R + W ≤ M`: at most one delivery in every run with no lost hand-off. Also `live_foreign_lease_blocks`, `far_future_lease_ignored`, `expired_lease_taken_over`, `merge_releases_lease`, `abandon_releases_lease`, `leased_delivers` (non-vacuity), and the counterexamples `pre_lease_cross_process_double_delivery`, `stale_clock_double_delivery`, `short_margin_double_delivery`, `lost_handoff_double_delivery`.

Mutation checks (scratch copies):
- Model: clock always stale ⇒ `linv_step`, `live_foreign_lease_blocks`, `far_future_lease_ignored`, `expired_lease_taken_over` fail; lease not honoured ⇒ `linv_step`, `live_foreign_lease_blocks`, `leased_delivers` fail; no margin check on `start` ⇒ `linv_step` fails; an overdue hand-off never lost ⇒ `linv_step` fails; `merge` keeping the lease ⇒ `merge_releases_lease`, `linv_step` fail; a crash owing a hand-off not lost ⇒ `linv_step`, `lost_handoff_double_delivery` fail; no expiry takeover ⇒ `expired_lease_taken_over`, `leased_delivers` and two counterexamples fail; no far-future clause ⇒ `far_future_lease_ignored`, `stale_clock_double_delivery` fail; hypothesis `R + W ≤ M` dropped ⇒ `linv_step` fails.
- Code: margin back to 2 min ⇒ "finding 2" and the margin guard fail; the lease clock read before the lock ⇒ "finding 1" fails. On the pre-fix code, findings 1, 2, 3 and 4 fail (1 POST instead of 0; 4 POSTs instead of 2; 3 store writes instead of 0; a lease left on disk).

## Review of #1231 (2026-09-28): release is per lease, not per holder

Blocking finding: when `learn()`'s immediate push failed, it released the in-process claim before its bookkeeping write, and that write then dropped the row's lease by holder id (`dropOwnLease`). A flush in the same instance could take the store lock in the gap. It found the row free (the lease was its own holder's), wrote a new lease and put its POST on the wire, and the failed push's bookkeeping then deleted that lease. Another process saw the row unleased and delivered it again. The reviewer replayed this with two instances and a stub remote, and the remote accepted the engram twice.

Fix:
- Every lease carries a `nonce` (`makeLease`). `dropLease(sd, lease)` removes it only when holder, nonce and expiry all match the lease that push wrote. `learn()` keeps its lease object, and a flush records the one lease it wrote for its batch (`OutboxFlushLeases.lease`). Both the merge-back and `_releaseOutboxLeases` release exactly that lease.
- `learn()` holds its `_outboxInFlight` claim until the failure bookkeeping has been written. The IIFE's `finally` releases it, so a flush in the same instance cannot take the row in between.
- `assertLeaseMarginFits` runs at module load and throws unless `OUTBOX_LEASE_MARGIN_MS < OUTBOX_LEASE_TTL_MS`. Without it, raising `DEFAULT_ACQUIRE_TIMEOUT` to about 8.5 min would silently stop every push.

Model: the §1c text now says that `P` ranges over pushes (one lease each), which matches per-lease release. No definition or proof changed. `lake` is not installed on the machine that made this change, so the Lean build was not re-run. The edit touches comments only.

Tests (`formal-outbox-lease.test.ts`): "a failed learn() push does not release the lease a flush in the same instance just took" is the reviewer's interleaving. The store lock is held so that the flush queues ahead of the failed push's bookkeeping, and B flushes afterwards. "a flush whose lease runs short mid-batch does not start the remaining pushes / retirements" covers the two in-flush margin gates, which no integration test reached before. There are also unit tests for `dropLease` and `assertLeaseMarginFits`.

Mutation checks: reverting both `learn()` fixes makes the interleaving test fail (the remote accepts two copies). Reverting only the early claim release, with the nonce kept, leaves it green, because either fix alone closes this interleaving. Removing either margin gate fails its own test. `dropLease` matching by holder only fails the unit test.

Not done: #1248 (the in-process mutex queue in front of the file lock has no bound, so the margin's lock-wait budget covers only the file-lock part). Bounding it changes every store writer, not only the outbox, so it stays filed.

## Decisions applied — field-report formal board (2026-09-29)

Source: `docs/audits/2026-09-29-formal-decisions.yaml` (branch `docs/field-report-triage`).
Integrated and tested on branch `formal/field-report-2026-09-29`; the models in this
file are not yet updated (drift check lists WritePath and R2CoreA).

- **Decision A1 applied: a team save is never absorbed** ("never"). A save to a
  shared scope that matches an engram in any other scope (personal, global, or
  another team's) credits that engram as a recurrence and still writes its own
  row in its own scope, so it reaches its team store (`_isTeamValidation` is true for
  every shared-scope save). Carried by **#1275**. On the formal branch the
  remote route (`learnRouted`) keeps #1228's rule that cross-scope recurrence never
  absorbs a team-store write, and credits the match (`_teamValidationMatch`).
  #1228's `formal-r2-apply-core-always-store.test.ts` › "good case … cross-scope
  #176" still expects `project:a → project:b` to absorb and needs the A1
  expectation (two rows, the first credited).
- **Decision A2 applied: record on the queued row AND make the global copy**
  ("both"). A team engram still queued for its store (`_outbox`, D3) that the
  ladder would promote keeps its scope, records the recurrence on its own row, and
  the promotion goes to a linked global copy. Carried by **#1275**
  (`recurrence-decisions.test.ts` › "A2"). #1228's D3 test passes unchanged.
- **Decision A3 applied: `locked` is a policy setting, allowed by default**
  ("allow" as a setting). `recurrence.max_commitment` (config) caps the ladder;
  the default `locked` lets repeated validation reach `locked`, `decided` stops
  below it, also for the copy-on-promote global copy. Carried by **#1275**
  (`recurrence-decisions.test.ts` › "A3"). On the formal branch #1228's
  `formal-writepath-tension.test.ts` › "a missing tensions.yaml … may lock" still
  fails: under A1 the project:b/c/d saves each write a team copy, and the fourth
  save matches a team copy (shared hits are preferred) rather than the promoted
  engram, so that engram stops at `decided`. The fixture needs to reach `locked`
  through saves that match the same engram (for example non-shared scopes).
