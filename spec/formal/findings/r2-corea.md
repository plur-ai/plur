# R2-CoreA findings — round 2, 2026-09-26

Model: `spec/formal/PlurSpec/R2CoreA.lean` (namespace `PlurSpec.R2CoreA`, no imports).
Check: `cd spec/formal && lake env lean PlurSpec/R2CoreA.lean` (clean, no sorry/axiom/native_decide).
Note for the coordinator: `PlurSpec.lean` (root) does not import `PlurSpec.R2CoreA` yet — not my file.

## Item 1 — Decision E6 applied: provenance `withheld`

**Decision E6 applied:** a provenance record counts an engram as withheld (not cleared to leave the machine) when its visibility is `private`, OR when its scope does not leave the machine (not `isSharedScope` and not remote-backed) and its visibility is not explicitly `public`.

Code (`packages/core/src/provenance.ts`):
- New exported `isWithheld(engram, remoteBacked = false)` — the one rule. A missing scope counts as not leaving (fail closed).
- `ProvenanceOptions.remoteBacked?: boolean` — only `Plur` knows its stores. `Plur.provenanceFor` (index.ts) passes `this._isRemoteBackedScope(engram.scope)` after `reloadConfigIfChanged()`. Absent ⇒ `false`, which can only withhold more.
- `buildProvenanceRecord` uses `isWithheld` for both `engram:maySharePlainly` and the `notShared` `odrl:distribute` prohibition (they cannot disagree). Prohibition note reworded: "private, or kept on this machine and not marked public".
- `summariseProvenance` now takes the record's own `engram:maySharePlainly` as authoritative; an older record without it is judged by `isWithheld` with backing unknown. The "Not permission to share" line names which reason applies.
- `docs/provenance.md`: the rule stated under "A licence is not permission to share".

Behaviour changes (all by the decision): `global`/`user:*`/`agent:*` memories not marked public and not remote-backed are now withheld (were shareable); `local` + explicit `public` is now shareable (was withheld); a url-backed `user:*` non-private memory is not withheld.

Consequence worth knowing (not re-opened): a pack member with `visibility: template` in a personal scope gets a record forbidding redistribution (exportPack excludes only `private`). Only `public` members are cleared.

Pinned tests checked, both still pass unchanged: `provenance-tester-round2.test.ts` "leaves a shareable memory alone"; `mcp/test/provenance-tool.test.ts` "honours a public visibility rather than dropping it" (core dist rebuilt).

Theorems (§1): `withheld_iff`, `public_never_withheld`, `private_always_withheld`, `onmachine_nonpublic_withheld`, `missing_scope_withheld`, `leaving_not_withheld` (non-vacuity), `unknown_backing_stricter`, counterexamples on the old predicate `old_global_template_shareable`, `old_local_public_withheld`.

Test: `packages/core/test/formal-r2-corea-provenance.test.ts` (12). Before the change: 8 failed | 4 passed. After: 12 passed.
Regression: `npx vitest run packages/core/test/{formal-r2-corea-provenance,provenance*,pack-provenance-preview,extraction-provenance}.test.ts` → 11 files, 228 passed, 2 skipped. `packages/mcp/test/{provenance-tool,agent-conversation}.test.ts` → 42 passed.

Mutation checks:
- Model: `withheld` else-branch → `false` ⇒ `withheld_iff`, `onmachine_nonpublic_withheld` fail; `leaves none => true` ⇒ `missing_scope_withheld` fails.
- Code: `isWithheld` body → `return scope === 'local'` (old rule) ⇒ 6 of 12 tests fail; restored ⇒ 12/12.

## Item 6 — core-policy#9: provenance summary defaults fail open

**Verdict: CONFIRMED + FIXED** (fixed together with E6, same function).

- `may_leave_this_machine` was initialised `true`; a record with no engram node kept it. Replayed: `summariseProvenance({'@graph': []}).fields.may_leave_this_machine === true` on the old code. Now initialised `false`; no subject ⇒ `false`.
- A missing `engram:licenseSource` was read as `'chosen'`, skipping the schema-default fail-closed branch, so `may_reuse_commercially`/`may_redistribute` answered yes on a record that never said anybody chose the licence. Replayed: old code → `licence_chosen: true, may_redistribute: true`. Now a missing or unrecognised value (not in `LICENSE_SOURCES`) is treated as not decided: both booleans `false`, `licence_chosen: false`, a line "The record does not say whether anybody chose this licence", and a `missing` entry. `fields.licence.source` is omitted rather than invented. Every record this code builds carries the field, so only older or hand-made records change.

Engineering call (fail closed, recorded): unknown source ⇒ treated like `schemaDefault` for the booleans.

Theorems (§1b, §1c): `summary_no_subject_closed`, `summary_agrees_with_record`, `summary_fallback_sound`, `missing_source_closed`, `recorded_source_kept`, `chosen_good_case` (non-vacuity), counterexamples `old_summary_no_subject_open`, `old_missing_source_open`.
Tests: the three "core-policy#9" cases in `formal-r2-corea-provenance.test.ts` (failed before, pass after) + good case.
Mutation: `mayLeave none => true` ⇒ `summary_no_subject_closed` fails; `srcNew none => .chosen` ⇒ `missing_source_closed` fails.

## Item 2 — core-index#7: forget/feedback treat any warm remote cache as proof of absence

**Verdict: CONFIRMED + FIXED** (cache half). The no-`probeById` fallback half: **DOWNGRADED**.

Defect: the #831 (forget) and #850 (feedback) ambiguity guards read `_loadRemoteCached(entry)` and, when non-empty, took "id not in cache" as "id not on the remote" — no freshness check. Worse than stale: `RemoteStore.append()` on a cold cache seeds `{ ts: 0, engrams: [stored] }`, a cache the store itself marks as a partial view. After one push to a team store, an unscoped `forget(id)` retired the LOCAL engram although the same bare id lived remotely (#831's wrong-target harm), and `feedback(id)` rated it.

Replay (`globalThis.fetch` mocked; remote holds the local engram's id; nothing real called):
```
npx vitest run packages/core/test/formal-r2-corea-guard-cache.test.ts
# before: × forget after a cold-cache push …  promise resolved "undefined" instead of rejecting
#         × forget: a stale (past its TTL) cache is re-checked live   (same)
#         × feedback after a cold-cache push …                        (same)
#         Tests 3 failed | 1 passed (4)
# after:  Tests 4 passed (4)
```

Fix (`packages/core/src/index.ts`): new `Plur._remoteCacheAnswer(entry, serverId)` → `present` (cached ⇒ refuse, as before) / `absent` ONLY for a complete load (`ts > 0`) younger than the driver's TTL (60 s default) / `unknown` otherwise ⇒ the existing bounded live probe (`existsById`, forget refuses on failure, feedback warns). Both guards use it. A fresh complete cache still answers without a probe (good-case test). Residual accepted window: a remote row created < TTL after a complete load (same as every cached read).

Theorems (§2): `peek_absent_sound` (under `Accurate` — cached ids are real, a fresh complete load lists every remote id — the fixed guard lets a local retire/rating proceed only when the id is absent remotely), `fresh_cache_answers` (non-vacuity), `old_partial_cache_retires_twin`, `old_stale_cache_retires_twin` (counterexamples = the tests).
Mutation: model `else .absent` in place of the freshness test ⇒ `peek_absent_sound` and both counterexample theorems fail. Code: `_remoteCacheAnswer` returning `'absent'` unconditionally for a non-matching cache ⇒ 3/4 tests fail; restored 4/4.
Regression: 16 files (cross-scope-recurrence, formal-apply-core-{retire-remote,scope-family}, formal-writepath-{outbox,rescope}, local-scope-never-routes-remote, multi-store, outbox, outbox-inspect, remote-exists-by-id, remote-guard-budget, remote-routing, rescope, secondary-store-retire-lock, set-pinned-remote, feedback) → 208 passed.

DOWNGRADED — no-`probeById` fallback (`getById` null → `'absent'`, forget's remote walk): the walk retires only on a positive `getById`, so the collapse cannot retire a wrong engram; the effect is that for a third-party driver without `probeById` a failed lookup is reported as "not found" rather than "could not reach" (message honesty only). Every in-repo driver (`RemoteStore`) implements `probeById`; the comment documents the fallback as deliberate for stubs. Left unchanged.

## Item 3 — core-index#8: reference-counted retirement (#107) not symmetric across stores

**Verdict: CONFIRMED + FIXED** (secondary path stores). Remote half: **DOWNGRADED** (consistent by design).

Defect: `forget()` DECREMENTS `write_count` in a writable secondary (path) store (audit iter-1 fix: "breaks the #107 contract for cross-store engrams"), and cross-scope recurrence PERSISTS its increment there — but a same-scope duplicate write whose hit lives in a secondary store was counted in memory only ("documented v1 behaviour"). Two writers of one team fact, one `forget()` ⇒ retired; the second writer's reference was gone.

Replay (temp dir, path store `group:acme/shared`, row seeded by a second Plur instance; no network):
```
npx vitest run packages/core/test/formal-r2-corea-refcount.test.ts
# before: × the increment is persisted to the secondary store — expected 1 to be 2 (in-memory hit said 2)
#         × two writers, one forget … — expected 'retired' to be 'active'
#         Tests 2 failed | 1 passed (3)
# after:  Tests 3 passed (3)
```

Fix (`index.ts`, `_recordDuplicate`): a hit in a writable secondary store (`_findEngramStore`, not primary, not readonly) is persisted under that store's lock with the load inside it (same lock order primary → secondary as `_recordCrossScopeRecurrence`); a row retired meanwhile is left alone; the caller gets the persisted count. Readonly stores and packs are never written (test "a readonly secondary store is never written").

DOWNGRADED — remote: a remote dedup hit is not incremented and a remote forget is a whole DELETE. Neither half counts on the remote (the server owns its row and this client never maintains its count), so the pair is consistent; making remote retire reference-counted would need a server-side count — a protocol change, not a local fix.

Theorems (§3): `dups_count`, `forgets_count`, `refcount_symmetric` (in every store where forget decrements: 1+n writers and m ≤ n forgets ⇒ still active), `refcount_last_retires` (non-vacuity), `readonly_untouched`, `old_secondary_two_writers_one_forget` (counterexample = test).
Mutation: model `dupNew` guard back to `k == .primary` ⇒ `dups_count`/`refcount_symmetric` and the counterexample's second conjunct fail. Code: the pre-fix `_recordDuplicate` is the mutant (2/3 fail, above).
Regression: 15 files (cross-scope-recurrence, set-pinned-remote, learn-async-scope, remote-routing, dedup-cosine, primary-store, secondary-store-retire-lock, reference-count, remote-write-contract, write-path-seams, readonly, tension-lifecycle, multi-store, corruption-matrix, + new) → 292 passed.

## Item 4 — core-index#9: egress guard — stale config, readonly URL stores, updateEngram walk

**(a) stale config — CONFIRMED + FIXED.** `reloadConfigIfChanged()` ran only on the unscoped path; an explicit-scope learn and `flushOutbox()` (whose re-guard comment promises "the target scope's CURRENT policy", R2-D #12) consulted the config the process started with. A team policy tightened out of process (another MCP server's `persistScopeMetadata`, a hand edit) was not seen: content it forbids was POSTed.
Fix (`index.ts`): `reloadConfigIfChanged()` at the top of `_guardSensitiveScope` (every learn / learnRouted / learnAsync egress decision), `_flushOutboxClaimed`, and `_updateEngramReturning`. One `statSync`; reloads only on an mtime change.

**(c) updateEngram guards every store before ownership — CONFIRMED + FIXED (narrowed).** The remote walk ran each writable store's `_guardExplicitUpdate` and PATCH in config order until one answered. For an id NAMESPACED to store B: store A's stricter policy refused B's update, and when A's guard passed, B's content was PATCHed to A first (A got the statement although it does not own the engram). The walk's own refusal rule already treats a namespaced id as naming one store. Fix: when the id is namespaced to one or more writable URL stores, only those are guarded/PATCHed; a bare id keeps the full walk (ownership unknown — the owner's guard still always runs before its PATCH, so no egress past policy was possible there; left as is).

**(b) readonly URL stores in `_isRemoteBackedScope` vs the router — DOWNGRADED for the leak guard, FIXED for provenance.** The guard counting a readonly URL scope as remote-backed only scans/demotes MORE (fail closed); kept, and the docstring's false "mirrors the router" claim rewritten to say the difference is deliberate. For Decision E6 the question is "does a write here leave the machine", so `provenanceFor` now uses the router's rule (`_isRemoteWriteScope`: writable URL store for exactly that scope) — a local row in a readonly-remote personal scope is withheld unless public.

Replay (`globalThis.fetch` mocked; config.yaml rewritten with a future mtime to simulate another process):
```
npx vitest run packages/core/test/formal-r2-corea-egress.test.ts
# before: × explicit-scope learn … — expected [ Array(1) ] to not include 'The staging box answers on 10.1.2.3:8…'
#         × flushOutbox … — expected 1 to be +0   (pushed under the stale policy)
#         × store A's stricter policy … — rejected "Cannot update a shared/remote engram with sensitive content: ipv4_port"
#         × store A never receives the PATCH … — expected [ 'a.example.com', 'b.example.com' ] to deeply equal [ 'b.example.com' ]
#         × a local row in a readonly-remote personal scope … — expected true to be false
#         Tests 5 failed (5)
# after:  Tests 5 passed (5)
```

Theorems (§4): `egress_current_policy` (nothing the on-disk policy forbids is pushed), `old_stale_policy_pushes` (counterexample), `update_only_named`, `update_bare_full_walk` (non-vacuity), `old_walk_patches_other_store` (counterexample).
Mutation: model `pushesNew` consulting `p.mem` ⇒ `egress_current_policy` fails; `candidatesNew := stores` ⇒ `update_only_named` fails. Code: removing the two reloads and the `namedBy` filter ⇒ 4/5 tests fail; restored 5/5.
Regression (37 files: formal-apply-core-*, formal-writepath-*, formal-r2-corea-*, guard-remote-*, guardrails, leak-surface, local-scope-never-routes-remote, outbox*, pr1-write-interactions, pr3-config-robustness, pr5-hardening, remote-routing, remote-write-contract, rescope-outbox-cancel, route-unscoped, scope-guard, scope-metadata*, set-pinned-remote, write-path-consolidation) → 386 passed.

## Applied on R2-CoreB's behalf (NEEDS-FILE → index.ts)

Details, theorems and mutation checks are CoreB's: `spec/formal/findings/r2-coreb.md` §1, §2b, §3.
1. `_loadSecondaryAndPacks` store loop: the clone / `global` narrow / non-idempotent regex namespace / stamp block replaced by `stampStoreRow(e, store.scope)` (imported from `./remote-recall.js`) — the same stamp as the recall leg; drops `_`-prefixed keys a row ships (a forged `_pack`).
2. Pack loop: `_`-prefixed keys dropped from the pack row before `_pack` is stamped (no forged `_storeScope`/`_originalId`).
3. `_flushOutboxClaimed`: `isHostInCooldown(url, now, healthPath, storeEntry.token)` — per-credential 429 cooldown. Without the token, CoreB's per-token split meant a flush never saw a 429 at all (it would push into the rate limit).

Test: `packages/core/test/formal-r2-corea-coreb-loader.test.ts` (3). Before: the two loader tests failed (`expected 'installed-pack' to be undefined`, `expected 'group:forged/x' to be undefined`); the cooldown test fails with the token argument removed (1 failed | 2 passed). After: 3 passed. With CoreB's suites + multi-store, remote-recall, outbox-circuit-breaker, remote-host-breaker: 7 files, 133 passed.

## Item 5 — core-index#10: dedup / cross-scope recurrence swallowing a write

**Verdicts:** (1) team-write swallow **CONFIRMED + FIXED**; (2) pack / readonly / remote-cache swallow **CONFIRMED + NEEDS-OWNER** (pinned on purpose); (3) backend divergence **DOWNGRADED** (deliberate, documented).

Replay (scratch vitest file in a temp dir, deleted after; no network):
```
REPLAY pack swallow: returned ENG-2026-09-26-001 group:packs/x p1 | primary rows: 0
REPLAY yaml: project:a 1 1 | delegated: project:b 0 2
```

1. **Explicit team write swallowed — CONFIRMED + FIXED** (also relayed by R2-Integrations). `learnRouted(X, {scope:'project:alpha'})` then `learnRouted(X, {scope:'group:acme/eng'})` (url-backed) returned the project:alpha engram; nothing POSTed, nothing queued — the team never got it. Same for `learn()`. Fix (`index.ts`): new `_crossScopeRecurrenceApplies(scope) = !_isRemoteWriteScope(scope)`; learn(), learnRouted()'s remote route and `wouldDeduplicate` skip #176 cross-scope absorption for a writable-remote scope. Same-scope dedup still applies (good-case test: two team writes → one POST); #176 unchanged for every non-remote scope (`plur.test.ts` "same statement in a different scope is a cross-scope recurrence" still passes). Test `formal-r2-corea-team-write.test.ts` (3): before 2 failed (`expected [] to include 'Every service exposes /healthz…'`) | 1 passed; after 3 passed. Theorems (§5b): `team_write_delivered`, `team_repeat_deduped`, `local_recurrence_kept` (non-vacuity), `old_team_write_swallowed`. Mutation: `writeNew` guard back to `if cross` ⇒ `team_write_delivered` fails.
2. **Swallow into a non-persistable hit — NEEDS-OWNER.** `learn('Prefer small pull requests', { scope: 'project:mine' })` with the statement in an installed pack returns the PACK engram (`_pack: p1`) and stores nothing (primary 0 rows); same branch for a readonly store and a remote-cache hit ("Readonly or remote — apply to hit only"); same-scope `_hashDedup` also matches pack / remote-cache rows. Uninstall the pack or let the cache expire and the write never existed. Contradicts learnAsync's "Dedup is a local decision", but `cross-scope-recurrence.test.ts` "emits in-memory history event on 1st hit when stored engram is in a remote/readonly store (audit iter-4 Data)" pins it. Theorems (§5): `pack_hit_swallows` (witness), `persistable_hit_durable`.
3. **Backend divergence — DOWNGRADED.** On a delegating store (PGLite/Postgres) a cross-scope hit on a PRIMARY row is not seen (YAML: 1 row, recurrence 1; delegated: 2 rows). The learn() comment documents this as deliberate: `findActiveByContentHash` is scope-bound so it cannot disclose another scope's engram — a store that opts into the seam treats scopes as a permission boundary. Not a bug; the importer's dry run now follows it (see R2-Retrieval below).

**NEEDS-OWNER Q-A: what should a write do when its statement already exists only somewhere the user cannot persist to (a pack, a readonly store, the remote cache of another scope)?**
- (a) keep: absorbed, nothing stored, `recurrence_detected` with `persisted_to: 'in-memory'`;
- (b) **recommended:** store the write as a new row in the requested scope; still log the recurrence against the hit (history only). Only hits that can be persisted absorb a write. Changes the pinned test.
- (c) store the write and skip recurrence for non-persistable hits entirely.

## Item 7 — follow-ups

**7a. One retrieval leg must not report `low_score` — CONFIRMED + FIXED.** After I3 (threshold 0.025, between 1/61 and 2/61) a recall with one leg (embeddings off, or the embedder failed: `mode !== 'hybrid'`) tops out at 1/61, so every non-empty recall was offered as a `low_score` miss. Fix (`index.ts`, `recallHybridWithMeta`): with one leg, only `no_results` is emitted. Test `formal-r2-corea-miss-oneleg.test.ts` (2; `emitMissSignal` replaced by a vi.mock spy — nothing sent, no install id written): before `expected [ { resultCount: 1, … } ] to deeply equal []` (1 failed | 1 passed); after 2 passed. With `telemetry-miss-signal` + `formal-apply-budget-miss`: 32 passed. Engineering call (telemetry is opt-in, nothing user-visible): degraded mode treated like bm25-only.

**7b. `listOutbox()` shows pending retire-on-remote entries — CONFIRMED + FIXED.** Decision D1's `_retireRemote` entries (queued remote DELETEs, retried by flushOutbox) were invisible: the inspector listed only `_outbox` on non-retired rows, so a stuck retirement read as "Outbox is empty". Fix: entries gain `kind: 'push' | 'retire'` (additive field); retire entries are selected exactly as flushOutbox selects them (any status); `target_url` still never returned. `outboxCount()` is now `listOutbox().length` (the existing test "agrees with outboxCount" pins that they match). Test `formal-r2-corea-outbox-retire.test.ts` (1): before `expected [] to have a length of 1`, after pass; with outbox-inspect, outbox, formal-apply-core-retire-remote, rescope-outbox-cancel: 34 passed. The CLI text (`plur outbox`) still words every entry as a write — R2-CLI may want to print `kind`.

**7c. rescope's local-family check stays case-sensitive — documented at the code** (`index.ts`, `rescope()` target validation): it is typo protection on an explicit move; the target is stored verbatim and every reader matches scopes exactly, so folding would strand `Global`/`Project:x` under a scope no filter treats as global, while `isSharedScope` would class `Project:x` as shared.

## Applied on R2-Retrieval's behalf (NEEDS-FILE → index.ts, importers/engine.ts wiring)

Details: `spec/formal/findings/r2-retrieval.md` §4 residual and §6b.

**§6b `injectHybrid` degraded silently — applied, as structured fields.** The silent `catch` now records the error and logs; after the block a failure swallowed by `embed()` is read from `embedderStatus()` (unavailable and NOT user-disabled). Reported as `InjectionResult.mode: 'hybrid' | 'hybrid-degraded' | 'bm25-only'` + `embedder_error` (types.ts), mirroring `HybridSearchResult` — the option R2-Retrieval offered — rather than a `warnings` line: `warnings` is rendered into the injected context on every prompt, and an install without the model would print the same line forever. One operator log line per process. User-disabled embeddings report `bm25-only`, never a fault. Test `formal-r2-corea-inject-degraded.test.ts` (2; embedder stubbed via vi.mock to throw "model crashed"): before, no mode/error (fails); after 2 passed.

**§4 importer dry-run parity on delegating stores — applied.** New public `Plur.wouldDeduplicate(statement, context?)`: the id learn() would resolve to, or null; same scope resolution (`_guardSensitiveScope`) and the same dedup code — learn() now calls the extracted `_learnCanDelegate()` / `_learnHashMatch()` helpers, and cross-scope uses `_crossScopeRecurrenceApplies`. `importers/engine.ts` dry run asks it instead of a scope-blind hash map (the map now only tracks earlier records of the same file). Test `formal-r2-corea-import-parity.test.ts` (3; in-memory store with the delegation seams): before, delegating case `expected [ +0, 1 ] to deeply equal [ 1, +0 ]` and no `wouldDeduplicate` (2 failed); after 3 passed. With `importers.test.ts` + `formal-r2-retrieval-importer.test.ts`: 52 passed. Residual: two records of ONE file with the same statement in different scopes, on a delegating store — the dry run still says the second is skipped, the real run imports it (in-file tracking stays scope-blind).

## Applied on R2-Integrations' behalf

1. Team-write swallow — item 5 (1) above.
2. `listOutbox()`/`outboxCount()` include `_retireRemote` rows as `kind: 'retire'` (push rows `kind: 'push'`) — item 7b above.

## Summary of files and verification

Files changed: `packages/core/src/index.ts`, `packages/core/src/provenance.ts`, `packages/core/src/types.ts` (InjectionResult doc + 2 optional fields), `packages/core/src/importers/engine.ts` (dry-run wiring only), `docs/provenance.md`. Not changed: `content-fields.ts`, `session-scopes.ts`.
New tests (all `packages/core/test/`): formal-r2-corea-provenance (12), -guard-cache (4), -refcount (3), -egress (5), -coreb-loader (3), -miss-oneleg (2), -outbox-retire (1), -import-parity (3), -inject-degraded (2), -team-write (3) = 38.
Pre-existing tests changed: none.
Regression: 66 files (all new ones + formal-apply-core-*, formal-writepath-*, outbox*, remote-*, rescope, readonly, plur, cross-scope-recurrence, importers, provenance, CoreB suites, …) → 899 passed. `npx tsc --noEmit -p packages/core` clean.

## Round-2 apply (owner decisions 2026-09-27)

**Decision A applied: "always store my write" (Q-A option b).** A write whose statement already exists only where the writer cannot persist it — an installed pack, a readonly store (path or URL), another scope's remote cache — is now stored as a NEW row in the requested scope through the normal learn path (normal routing, leak guard, outbox), and the recurrence is recorded against the hit in history only: `recurrence_detected` with `persisted_to: 'history-only'`, `stored_as: <new id>`, `held_in: pack|readonly|remote-cache`, `matched: same-scope|cross-scope`, and the hit's own `recurrence_count` unchanged. The hit is never mutated — not on disk, not in memory.
- Code (`packages/core/src/index.ts`): `_hitHolder(hit, scope)` classifies a hit (primary / writable secondary / `own-remote` = the writable URL store of exactly this scope are the writer's own; pack / readonly / another scope's remote cache are not). `_firstPersistableHit` returns the first own hit and the first foreign one in corpus order; `_learnHashMatch` and the new `_crossScopeMatch` use it. Wired into learn() (both history sites: local and outbox), learnRouted()'s remote route (same-scope match; POST and outbox-fallback history sites), `wouldDeduplicate` (a foreign-only hit answers null — dry-run parity), and learnAsync's hash step (`_learnAsyncDeps().hashDedup` returns only an own hit, so a pack match falls through to learn()). New `_noteUnpersistableRecurrence` writes the history note. The "Readonly or remote — apply to hit only" branch of `_recordCrossScopeRecurrence` is no longer reached from the write paths; kept as the defensive fallback for a store that vanished meanwhile (comment updated), and `_recordDuplicate`'s comment likewise.
- Unchanged by decision: same-scope dedup against the writer's own persistable rows (#107, incl. the writable remote of the same scope), #176 recurrence for local scopes against own rows, and the R2 team-write rule. Consequence worth knowing: with a statement both in a pack (scope X) and in the writer's primary store (scope Y), a write to X now graduates the primary row via #176 (the only own hit) rather than being absorbed by the pack row.
- Test (new) `packages/core/test/formal-r2-apply-core-always-store.test.ts` (7): pack hit other scope / same scope, readonly store, other-scope remote cache (seeded in memory, no network), `wouldDeduplicate`, learnAsync, good case (own rows still absorb). Before: 7 failed. After: 7 passed.
- Pinned test CHANGED by the decision: `cross-scope-recurrence.test.ts` "emits in-memory history event on 1st hit when stored engram is in a remote/readonly store (audit iter-4 Data)" → renamed "a hit in a remote/readonly store does not absorb the write: new row + history-only event (Decision A, was audit iter-4 Data)"; now asserts a new `project:b` row, the readonly row unmutated (write_count 1, recurrence 0), one `recurrence_detected` on the readonly id with `persisted_to: 'history-only'`, `stored_as`, `held_in: 'readonly'`. 17/17 pass.
- Model (§5): `storesNewRow := !persistable` (was: only on a miss, kept as `storesNewRowOld`); theorems `every_write_durable`, `foreign_hit_untouched`, `own_hit_absorbs` (non-vacuity), `persistable_hit_durable`; old counterexample renamed `old_pack_hit_swallows`. Mutation: `storesNewRow := storesNewRowOld` ⇒ `every_write_durable` and `foreign_hit_untouched` fail; `mutatesHit := true` (old in-memory mutation) ⇒ `foreign_hit_untouched` fails.
- learnAsync's LLM/cosine candidate step: closed by follow-up F1 below.

**Decision R applied: "a re-run changes nothing" (R2-Retrieval §4 option A).** `packages/core/src/importers/engine.ts`: the real run asks `plur.wouldDeduplicate(statement, context)` BEFORE learn(); an id ⇒ `skipped` with that id and learn() is not called, so the existing engram is untouched (no write_count bump, no sources append, no cross-scope recurrence / graduation). The secret scan now runs first in both modes; a secret record skips the pre-check and goes to learn(), which refuses it with its own message (so dry and real still report `error` alike). learn() resolving to a pre-existing id is still reported as skipped (defensive, a write between check and learn). Module header rewritten (it documented the bump).
- Test (new) `packages/core/test/formal-r2-apply-core-reimport.test.ts` (4): second run leaves every engram byte-identical in the fields that moved (write_count, recurrence_count, sources, scope, commitment); cross-scope re-import twice changes nothing (no graduation); in-file duplicate does not bump the first; dry and real agree on a re-run and the dry run writes nothing. Before: 3 failed | 1 passed (parity already held). After: 4 passed. Pre-existing `importers.test.ts` (incl. "re-importing the same file is idempotent", which only counted rows) unchanged and passing; `formal-r2-retrieval-importer` and `formal-r2-corea-import-parity` pass.
- Model (§6 `Reimport`): store = (key, write count) list; `realNew` skips without writing, `realOld` bumps. Theorems `rerun_changes_nothing` (re-running an import on the store it produced reports all skipped and returns the same store), `dry_predicts_real_store`, `reimport_reachable` (non-vacuity), counterexample `old_rerun_bumps` (= replay "write_count 3"). R2Retrieval's `dry_predicts_real` is untouched and still checks (actions did not change). Mutation: `realNew` bumping on a hit ⇒ `run_keeps`/`run_mem`/`realNew_present`/`rerun_changes_nothing` fail.
- Residual (two records of one file, same statement, different scopes, delegating store): closed by follow-up F3 below.

**Coordinator item applied: an update that retires leaves a trace ("every removal is explicit").** `_updateEngramReturning` (local branch) appends `engram_retired` `{engram_id, timestamp, data: {reason: null, via: 'update'}}` when the stored status was not `retired` and the written one is; nothing when already retired or unchanged. This covers `plur_validate_meta` (meta/validation.ts sets `status: 'retired'`, the MCP handler persists via updateEngram).
- Test (new) `packages/core/test/formal-r2-apply-core-update-retire.test.ts` (2): before 2 failed (`expected [] to have a length of 1`), after 2 passed.
- Model (§7): `retire_logged`, `no_event_unless_retiring`, counterexample `old_update_retire_silent`. Mutation: `retireEvent := false` ⇒ `retire_logged` fails.
- REMOTE branch: closed by follow-up F2 below.

Check: `cd spec/formal && lake env lean PlurSpec/R2CoreA.lean` clean (no sorry/axiom/native_decide); `PlurSpec/R2Retrieval.lean` still clean.

### Follow-ups applied (coordinator, owner principles, 2026-09-27)

**F1 — Decision A covers learnAsync's candidates.** `_learnAsyncDeps().recallHybrid/recall` now return only rows the writer can persist (`_persistableCandidates`: `_hitHolder` of each row in its own scope ∈ primary / writable secondary / own-remote; learnAsync then keeps only candidates in the requested scope, so "its own scope" is the writer's). A pack / readonly / other-scope remote-cache candidate is dropped before the LLM or cosine step; with none left the write is an ADD through learn(), which writes the history-only note when the dropped row was an exact hash match (a merely similar dropped candidate is not a recurrence and gets no note). learnBatch shares these deps (its accumulator only adds rows it wrote itself). Unscoped learnAsync judges each row against its own scope — an approximation of the scope learn() will resolve, the same one the hash step already used.
Test: `formal-r2-apply-core-followups.test.ts` F1 — an LLM `NOOP` naming the pack row: before `expected 'NOOP' to be 'ADD'`, after ADD + a primary row; good case (own primary candidate still NOOPs) passes both before and after.

**F2 — a remote update that retires is traced.** `_updateEngramReturning` remote branch: when the patch sets `status: 'retired'`, the driver's `getById` is read first; after a successful PATCH, `engram_retired` `{reason: null, via: 'update', routed_to: 'remote', scope}` is appended unless the previous status was `retired`; if the previous status could not be read (`getById` null — 404 and unreachable collapse there — or a throw) the event is still written with `previous_status_unknown: true`. No read and no event for a patch that does not retire; nothing on a 404 PATCH.
Test F2 (4, remote driver stubbed via `_getRemoteDriver`, no network): active→retired event; already retired → none; unreadable → flagged event; non-retiring patch → no read, no event. Before: 2 failed (`expected [] to have a length of 1`); after 4 passed.

**F3 — dry-run in-file key on a delegating store.** New public `Plur.dedupScopeFor(statement, context) → { scope, acrossScopes }`: the scope learn() would write into (sensitive-scope guard + routing) and whether its dedup matches another scope's primary row — `!_learnCanDelegate() && _crossScopeRecurrenceApplies(scope)`. The importer's dry run looks earlier records of the file up by `hash` when `acrossScopes`, else by `(hash, scope)` (both keys are recorded). YAML with ordinary scopes stays scope-blind as instructed; one deliberate extension: a writable-remote (team) scope on YAML is also keyed by scope, because learn() does not absorb a team write cross-scope (the R2 team-write rule) — that is the real run's behaviour.
Test F3 (2): same statement in scopes a, b, b — delegating store real `[imported, imported, skipped]`, dry before `[imported, skipped, skipped]`, after equal; YAML `[imported, skipped, skipped]` in both modes.

Model (§8): `async_target_persistable` (any target the LLM oracle picks from the offered list is persistable), `async_own_kept`, counterexample `old_async_pack_target`; `remote_retire_traced`, `remote_no_event_when_already_retired`, `remote_no_event_without_retire`, `old_remote_retire_silent`; `infile_parity` (dry = real in-file skips for both backends), `infile_cases` (non-vacuity: YAML vs delegating), `old_infile_diverges` (counterexample = the F3 test).
Mutation: candidate filter removed ⇒ `async_target_persistable`, `async_own_kept` fail; unknown previous status mapped to no event ⇒ `remote_retire_traced` fails; dry key back to scope-blind ⇒ `dryStepF_eq`/`infile_parity` fail.
Regression: 99 core test files (dedup, packs, readonly, learn*, recurrence, routing, outbox, import*, formal-r2-*, formal-apply-core-*, formal-writepath-*, rescope, tension, meta, update, promote, …) → 1353 passed, 0 failed. `npx tsc --noEmit -p packages/core` clean; core build OK.

Decision A1 applied (2026-09-29, "never"): no team save is absorbed, not even into
another team's engram; the match is credited and the save is written to its own
scope. Carried by #1275; on `formal/field-report-2026-09-29` the remote route keeps
this file's rule (no cross-scope absorption of a team-store write) and credits the
match (`_teamValidationMatch`). See writepath.md "Decisions applied" for A1–A3.

## Field report 2026-09-29 — cluster 1 (A1, A2, automatic feedback)

Model: `PlurSpec/R2CoreA.lean` §9 (and a note on §5b). Code: `index.ts` on
`formal/field-report-2026-09-29` (refresh 2); `feedback.ts`. Replays:
`packages/core/test/formal-fr-c1-replays.test.ts` (`it.fails` = confirmed defect, the
body asserts the intended behaviour; drop `.fails` when the owning PR fixes it).
No source file was edited.

### 9a. A1 — a shared-scope save lands in its own scope

- **learn() / learnRouted(): REFUTED (claim proved).** `a1_learn`, `a1_routed`; good
  cases `a1_credit_reachable`, `nonshared_still_absorbed`; old #1275 shared↔shared
  absorb kept as `old_shared_to_shared_absorbed`. §5b still holds for remote-write
  scopes; A1 is its refinement to every shared scope.
- **wouldDeduplicate / importer: CONFIRMED + NEEDS-OWNER.** `wouldDeduplicate()`
  still answers any `_crossScopeMatch` hit, the pre-A1 rule, while learn() now writes
  the team copy for a shared scope. The importer asks it before learn() (Decision R)
  and skips, so a shared-scope record whose text exists in another scope never reaches
  its own scope. `dedupScopeFor().acrossScopes` has the same drift (true for a shared,
  non-remote scope). Theorems: `would_dedup_disagrees` (counterexample),
  `would_dedup_fixed_parity`, `import_fixed_a1`, `import_fixed_still_skips` (fix:
  count a cross hit only when `!isSharedScope(scope)`).
  Replay (without `.fails`): `wouldDeduplicate(S, project:b)` → `expected
  'ENG-2026-09-29-001' to be null`; `runImport(..., scope: project:b)` → `imported`
  0, expected 1.
  Owner question: the fix flips `formal-r2-corea-import-parity.test.ts` › "YAML store:
  the same case is skipped in both", which pins the pre-A1 skip. Options: (a) apply
  A1 to the importer: import into the shared scope and credit the other engram (flip
  the test); (b) keep import as a true skip for cross-scope text (then the docstring
  "would learn() resolve to an existing engram" must say importer-specific). Owning
  PR: #1275 (carries A1).

### 9b. A2 — a queued team engram hit by the ladder

**REFUTED (claim proved).** `a2_row_kept` (scope + outbox kept, count +1),
`a2_at_most_one`, `a2_exactly_one_linked` (from a fresh queued row with no global
twin, after n ≥ 2 crediting saves: exactly one global engram, `derived_from` the row,
count n), `a2_first_save_no_copy`; old copy-only witness `old_copy_only_row_stuck`.
Scope of the model: the global twin search is the primary store (`_findGlobalTwin`);
a pre-existing unrelated global twin is credited instead of a linked copy (by design,
review finding 2); a flush that delivers the row between saves is out of model.
Existing tests: `recurrence-decisions.test.ts` › A2 (passes).

### 9c. Automatic feedback never changes commitment

**REFUTED (claim proved), with one out-of-cluster lead.** `auto_feedback_keeps_commitment`
(every destination: primary, secondary, pack apply `applyOpts`; a remote gets an auto
signal only when it advertises `feedback.source`, whose contract is the hypothesis),
`auto_not_sent_incapable`, `explicit_promotes`, `feedback_never_locks`,
`feedback_keeps_draft`. Existing tests: `feedback-auto-source.test.ts`,
`feedback-source-remote.test.ts` (pass).
Lead, not replayed, outside this cluster: the Hermes plugin
(`packages/hermes/plur_hermes/memory_provider.py` `sync_turn`, `__init__.py`) infers
feedback from the reply text and sends it through the CLI bridge as ordinary
feedback — `plur feedback` has no `source` option — so its automatic verdicts do
promote commitment, contrary to decision A′. Needs an owner for the Python adapter
and a CLI `--source auto` flag.

### Mutation checks (scratch copies, `lake env lean`)

| Mutation | Broken theorems |
|---|---|
| learn() absorbs a shared save (`!shared` dropped) | `a1_learn`, `a1_routed`, `import_fixed_a1`, … |
| wouldDedup fix undone | `would_dedup_fixed_parity`, `import_fixed_a1` |
| queued row not counted on promotion | `a2_row_kept`, `a2_exactly_one_linked` |
| second global copy despite a twin | `a2_at_most_one`, `a2_exactly_one_linked` |
| auto feedback promotes | `auto_feedback_keeps_commitment` |
