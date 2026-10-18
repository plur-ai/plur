# Findings: RoutingDiscovery (scope resolver, write paths, server scope discovery) — 2026-10-18

Model: `spec/formal/PlurSpec/RoutingDiscovery.lean` (+ owner decision 17 in
`spec/formal/PlurSpec/StoreEntry.lean` §3). Survey: `spec/formal/survey/routing-discovery.md`.
Branch formal2/epic-1797 (b22f01d0) plus the fixes below. Both files check with
`lake env lean` (no sorry/axiom/native_decide). The model is ~750 lines: four small models in
one file instead of one deep one. Each section lists what it leaves out.

## D1. resolveScopeTarget is total, deterministic, and its answers mean what they say — REFUTED (holds), one NEEDS-OWNER

- It is a total pure function (`resolve`), so it is deterministic by construction.
- `remote_is_exact_url`: a `remote` answer is always an exact-scope url entry of the config,
  and `writable` means exactly "that entry is not readonly".
- `conflict_iff`: outside the personal rule, `conflict` happens exactly when two distinct
  servers (`TwoServers`) claim the exact scope. Supporting lemmas: `mem_servers`,
  `nodup_servers`, `two_le_servers_iff`.
- `unauthorized_iff`: outside the personal rule, `unauthorized` happens exactly when no url
  entry claims the scope and a company server's org equals the scope's org.
- `answers_reachable`: every kind of answer can actually occur (non-vacuity).
- CONFIRMED + NEEDS-OWNER (Q1), `personal_two_servers_not_conflict`: rule 1 (the #1515
  personal selection) runs first. So a `user:` scope that two servers claim gets the first
  writable server as its answer, not `conflict`. This matches the plan's rule order.
  Replay (scratch test, removed afterwards): `resolveScopeTarget('user:acme:alice', [A, B])`
  returned `{"kind":"remote","entry":{"url":"https://plur.example.com",...},"writable":true}`.
  This is now pinned as an example in formal-routing-discovery.test.ts. Behaviour not changed.

## D2. Leak guard: the scan runs first, and only the resolver's `remote` is dialled — REFUTED for the router and the scan; two flush gaps CONFIRMED + NEEDS-OWNER

- `gate_open`: any url entry that names scope `s` exactly opens the scan gate for `s`.
- `no_flagged_content_leaves`: on any write path that is guarded and picks an exact-scope url
  entry, content the scan flags never leaves the machine. `route_exact` and `flushPick_exact`
  show that the router and the outbox flush both meet that condition. The scan-before-send
  order on each path was read from the code, not modelled per path:
  - learn and learnRouted use `_guardSensitiveScope`
  - updateEngram (about line 8650), rescope (about 9981), the flush (about 11445) and the
    improve walk (about 11972) each call `_offendingHitsForScope` before dialling.
- `route_only_remote`: the router dials only the entry the resolver answered `remote`,
  writable, for.
- `flush_agrees_with_router`: outside the personal rule, the flush and the router dial the
  same entry.
- CONFIRMED + NEEDS-OWNER (Q2), `flush_pushes_when_local`: a personal row was queued for the
  url store. A path store then took the same `user:` scope. The resolver now answers `local`,
  but the flush still pushes the row. Replay (scratch, removed): queued = true,
  resolver = `local`, flush → `{"flushed":1,"posts":[{"host":"plur.example.com"}]}`.
  The content is still scanned, so this is not a secret leak. It is a disagreement between the
  routing and the delivery report.
- CONFIRMED + NEEDS-OWNER (Q3), `flush_ignores_target_url`: a row queued for server A is pushed
  to server B once B replaces A for the same scope. `routeFor` never reads `target_url`.
  Replay: target_url `https://plur.example.com`, then the config had only other.example.com →
  `{"flushed":1,"posts":[{"host":"other.example.com","auth":"Bearer b"}]}`.
  `routeFor` is outside my files, and so is the Outbox model, so it is not changed.

## D3. acceptDiscoveredScopes decision table — REFUTED (holds)

- `nonempty_cache_replaced_only_by_ok`: a non-empty cache is replaced only by an error-free
  `ok` answer that names an org. A failed, auth-failed, not-synced, degraded or org-less answer
  never replaces it (owner decision 16).
- `kept_is_cached`: when the cache is kept, it is unchanged.
- `accepted_within_org`: every accepted scope was listed by the server, passes `inOrg` for the
  server's org, and is not served by another server.
- `accept_reachable`: non-vacuity.
- `orgRejection` is an oracle in the model. Its string rules are pinned by examples in
  formal-routing-discovery.test.ts: a look-alike org, `group:acme:x`, a deeper `user:` scope
  and an upper-case kind are refused.
- Noted, not changed: an `ok` answer whose scopes are ALL refused still empties a non-empty
  cache, as the plan table says ("ok (any length, incl. 0)").
- CONFIRMED + FIXED (Codex round 2 finding 2, 2026-10-18), `malformed_keeps_cache` /
  `malformed_reachable`: `me()` turned a missing, null or non-array `scopes` into `[]` and kept
  `scopes_status: ok`, so a malformed answer cleared a non-empty cache. `me()` now sets
  `scopes_malformed` (also for a member the grammar drops), and `accept` treats it as
  `degraded` before any other rule. An explicit, valid `[]` with `ok` still clears the cache
  (plan B Task 4 table). The model's `Me` carries `wellFormed`.
  - Test first: codex2-refresh-server-scopes.test.ts §2, six malformed bodies through real
    HTTP, red (`status: ok, applied: true`), then green; the explicit-`[]` case stays green.
  - Mutation: deleting the `wellFormed` branch of `accept` breaks `malformed_keeps_cache` and
    `decide` refutes `malformed_reachable`.

## D4. refreshServerScopes: cache write rules — REFUTED (holds); answer mis-targeting CONFIRMED + FIXED

- `refused_keeps_discovered_at`: a refused answer never changes `discovered_at`.
- `unchanged_fresh_writes_nothing`: an unchanged answer with a fresh stamp writes nothing.
- `same_answer_within_a_day`: after a write at time t, the same answer writes nothing until 24 h
  have passed. `refresh_reachable`: non-vacuity.
- CONFIRMED + FIXED, `old_answer_mistargets` / `answer_lands_on_its_entry`: the bug was that
  each answer was applied to the FIRST server entry with that url (`findIndex`). With two
  server entries on one url, each with its own key, the second key's answer overwrote the first
  entry: the first entry's token stayed, but its scopes and personal `scope` became the other
  user's. Replay (scratch, removed):
  `[["t-alice","user:acme:bob",["user:acme:bob","group:acme/bob-team"]],["t-bob",null,[]]]`.
  - Fix (index.ts `refreshServerScopes`): when more than one server entry has the url, nothing
    is written. Both outcomes are `failed`, with the error "more than one server entry in
    config.yaml has the url …; nothing was changed". This is the same refusal as rotation and
    owner decision 17.
  - Test first: formal-routing-discovery.test.ts "neither entry is written and both outcomes
    are failed" was red (`[['ok',true],['ok',true]]`), then green.
  - Mutation: replacing `targetNew` with the old `find?` breaks `answer_lands_on_its_entry`.
    `decide` then refutes the fixed half of `old_answer_mistargets`.
- CONFIRMED + FIXED (Codex round 2 finding 1, 2026-10-18), `rotated_answer_mistargets` /
  `answer_lands_on_its_entry`: the D4 theorem assumed the requested entry was still in the list
  under the lock (`hp : p ∈ l`), which the code did not establish. A key rotated while `/me`
  was in flight got the old key's scopes, compatibility scope and identity.
  - Fix (index.ts `refreshServerScopes`, `serverCredential`): each answer carries the
    credential revision it was requested with (source `token` or `token_env:<NAME>`, plus a
    sha256 fingerprint of the resolved key, never the key). Under the lock an entry whose
    revision differs gets nothing written; the outcome is `failed`, "entry changed during
    refresh".
  - Model: `Srv` is (url, credential revision); `targetBound` adds the revision check, and
    `answer_lands_on_its_entry` now holds for ANY locked list, with no membership assumption.
  - Test first: codex2-refresh-server-scopes.test.ts §1 (inline key replaced, token_env value
    changed, inline→token_env) red, then green; an unrelated edit to the same entry still
    applies.
  - Mutation: dropping the revision check from `targetBound` breaks `answer_lands_on_its_entry`
    and `decide` refutes `rotated_answer_mistargets`.
- Also fixed in the same round (not modelled, tested): errors in outcomes have the request's
  key redacted (`redactToken`, every encoding; inline and token_env), and an accepted answer
  keeps unknown `discovery` keys while removing known ones the answer lacks
  (`key_expires_at`, `gitlab_host`).

## D5. Owner decision 17: collapse writes nothing for an ambiguous identity — CONFIRMED + FIXED

- store-expand.ts `collapseExpandedStores` now writes nothing for an identity base in either
  of two cases:
  - it occurs more than once in the fresh read;
  - a typed entry carries `#1` or later, which means it was ambiguous at load.
- `persistStores` then emits those raw entries unchanged. Its own indexById placement writes
  only the raw content of each entry.
- StoreEntry.lean §3, `mistarget_impossible`: metadata recorded at load for entry e0 is written
  to e0 (if it is still on disk) or to nothing, whatever the other process inserted or removed.
  `fixed_same_base_insert`, `fixed_removed_twin`, `fixed_good_case` give the reachable cases.
  The pre-fix `same_base_insert_mistargets` is kept as the old lookup's counterexample.
- Tests first, formal-store-entry-ambiguous.test.ts. Four tests were red, for these cases:
  - insert of a same-base entry before ours
  - two same-base entries at load
  - loaded as two, then one removed
  - an unambiguous neighbour still written
  All 5 pass now, including the single-entry good case.
- Mutation: replacing `findIdFixed` with `findId` breaks `mistarget_impossible`, and `decide`
  refutes `fixed_same_base_insert` and `fixed_removed_twin`.

## D6. `_reconcileQueuedScope` used its own lookup (coordinator item) — CONFIRMED + FIXED

- The bug: an updateEngram that moved a queued row into a scope two servers claim retargeted
  the row to the first-listed server. The flush hold blocked delivery, so nothing leaked, but
  the code broke the one-resolver rule.
- The fix: the retarget now comes from `resolveScopeTarget`. `conflict` throws
  `ScopeConflictError` before anything is written; reconcile runs before the write, after the
  hard-tier check. `remote && writable` is the retarget, and a personal `local` answer cancels
  the delivery. Every other branch keeps its old behaviour.
- Model:
  - `retarget_is_router`: the retarget is exactly the router's entry.
  - `retarget_refuses_conflict`: a scope two servers claim is refused.
  - `old_retarget_picks_first`: the pre-fix counterexample.
- Test first: "is refused, and the row stays queued for its old server and scope" was red
  ("promise resolved true instead of rejecting"), then green.
- Mutation: making `conflict` return the old `find?` breaks `retarget_refuses_conflict`.

## Files changed

- `packages/core/src/store-expand.ts`: the ambiguous-base refusal in the collapse, plus
  docstrings.
- `packages/core/src/index.ts`: in `refreshServerScopes`, an ambiguous url is refused; in
  `_reconcileQueuedScope`, the retarget now comes from the resolver.
- New tests: `packages/core/test/formal-routing-discovery.test.ts` (8) and
  `packages/core/test/formal-store-entry-ambiguous.test.ts` (5).
- Lean and spec files:
  - `spec/formal/PlurSpec/RoutingDiscovery.lean` (new)
  - `spec/formal/PlurSpec/StoreEntry.lean` (§3 extension)
  - `spec/formal/PlurSpec.lean` (import)
  - `spec/formal/verify.yaml` (new model entry)
  - this file and the survey.

## Verification

- `cd packages/core && npx vitest run test/formal-routing-discovery.test.ts test/formal-store-entry-ambiguous.test.ts`
  gave 13 passed.
- The regression set was 50 files: formal-writepath-*, formal-apply-core-*, formal-audit-core-*,
  formal-r2-apply-core-*, outbox*, multi-store, learn-delivery, the resolver, discovery,
  refresh, server-entry and store-entry files, and routing-shared-resolver.
  Result: 435 passed, 1 failed. The failure is `multi-store > similaritySearch includes store
  engrams`, a 30 s timeout that is already recorded as environmental.
- `npx tsc --noEmit -p packages/core` exited 0.
- Not verified: the full suite, `pnpm typecheck:tests`, and `lake build`. The coordinator runs
  these.

## NEEDS-OWNER

- Q1 (D1): should a personal `user:` scope that two different servers claim be a `conflict`
  (refused), as other scopes are? Or should it keep the #1515 selection (the first writable
  server)?
- Q2 (D2): a queued personal row whose scope a path store now also holds. The resolver says
  local. Should the flush:
  - (a) hold or cancel the row, as `_reconcileQueuedScope` cancels;
  - (b) deliver it, as it does now; or
  - (c) report it as needs-action?
- Q3 (D2): a queued row whose `target_url` server is no longer configured for its scope, with a
  different server configured instead. Should the flush:
  - (a) hold it until the owner rescopes it or restores the server, using the `target_url`
    match that the retire queue already uses;
  - (b) deliver it to the new server, as it does now; or
  - (c) deliver it only when the new url is the same origin?
