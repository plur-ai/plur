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
