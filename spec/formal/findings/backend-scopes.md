# backend-scopes

Model: `spec/formal/PlurSpec/BackendScopes.lean` (checks clean, no sorry/axiom/native_decide).
Tests: `packages/core/test/formal-backend-scopes-case.test.ts`, `packages/core/test/formal-backend-scopes-guard.test.ts`.

## Lead 1: scope classification across backends: CONFIRMED+FIXED (wider than the lead)

The in-memory predicate (`makeVisibilityPredicate`) case-folds the shared-family prefix
(`isSharedScope`) and compares containment exactly (`isScopeWithin`). Neither SQL backend matched it:

- PGLite and Postgres (same clause in both files): the personal arm used case-sensitive
  `scope LIKE 'group:%'`. So `Group:other`, `GROUP:acme`, `Project:other`, `SPACE:x`, `Team:t`, `Org:o`,
  `Public`, `PUBLIC:x`, `PROJECT:plur`, `Project:plur:sub` and `Group:acme/eng` passed a `project:plur`
  filter as personal. In-memory and SQLite hide them. That is a visibility leak of another team's rows.
- SQLite (not in the lead): the containment arms used `LIKE`, and SQLite LIKE ignores ASCII case.
  So `Project:plur:sub` and `project:PLUR/x` passed `project:plur`, which the in-memory path refuses.
- SQLite domain filter: `domain LIKE ? || '%'` ignored case and left the filter unescaped, so `plur_core`
  matched `plurXcore`. The in-memory path uses `startsWith`.

Replay (before the fix): `pnpm exec vitest run packages/core/test/formal-backend-scopes-case.test.ts`
gave 8 failed. PGLite adapter: "Received +ENG-…-006 (Group:other) … +024". The Postgres clause, run on a real
Postgres engine (PGLite WASM), gave the same rows. SQLite: "+020, +021", and both domain cases failed.
After the fix: 13 passed.

Fix:
- storage-pglite.ts, storage-postgres.ts: the personal arm tests `lower(scope) LIKE 'group:%'` etc.
- storage-indexed.ts: containment uses `instr(scope, ? || ':') = 1` (case-sensitive, needs no escaping).
  The domain filter uses `instr(domain, ?) = 1`.
- scope-util.ts: the doc comment now describes the SQL twins correctly.

Theorems:
- `like_esc_prefix`: `s LIKE escape(q)||':%' ESCAPE '\'` holds iff `q:` is a prefix of s, for every q.
  Proved with a LIKE matcher model, via `compile_esc` and `match_prefix`.
- `sqlShared_fold`: the folded SQL family arm equals `isSharedScope`.
- `pg_agrees`: PGLite/Postgres visibility equals the in-memory visibility for every scope, filter and grant list.
- `sqlite_agrees`: the same for SQLite.
- Counterexamples to the old code: `pg_unfolded_leaks`, `sqlite_ci_leaks`, `sqlite_domain_wildcard`.
- Non-vacuity: `mem_cases`.

Mutations, each run on a scratch copy:
- Drop `lower`: `sqlShared_fold` breaks, so `pg_agrees` breaks too.
- Put case-insensitive LIKE back into SQLite: `sqlite_agrees` breaks.
- Stop escaping `_`: `compile_esc` and `like_esc_prefix` break.

Assumptions: `lower` is ASCII `Char.toLower`. The family prefixes are ASCII, and JS toLowerCase and Postgres
lower() agree on them. SQLite `instr(s,p)=1` is modelled as "p is a prefix of s".

Note: the new case test boots PGLite but is not named `pglite-*`, so it runs in the parallel pool.
It only uses loadFiltered (no embedder), and it took under 1s locally.

## Lead 2: RemoteOnlyStoreGuard never writes locally: PROVED (model) + TESTED

Model: rows are abstract, and `vis` is `_visible`.
- `save_keeps_hidden`: a successful whole-corpus save leaves the hidden (personal) rows identical and in order.
- `save_writes_only_visible`: every row written is visible or carried through from the store.
- `update_keeps_hidden`: updateMany changes no hidden row and writes only visible rows.
- `append_safe`: append adds exactly one visible row.
- `read_only_visible`: reads return only visible rows.
- Refusals: `blocked_refuses_append` (blocked binding), `secondary_refuses_save` (secondary store).
- Reachability: `save_reachable` and `save_refuses_hidden`.

Mutations:
- Drop the visibility check from save: `save_keeps_hidden` breaks.
- Merge drops hidden rows: `mergeWalk_inv` breaks.
- Drop the hidden-target check from updateMany: `update_keeps_hidden` breaks.
- Drop the visibility check from append: `append_safe` breaks.

The four rules that had no backing now have tests. Each test was mutation-checked on the source and reverted.
- heldState (mutation `return e`: the test fails).
- `_queued` gains a marker only through the hold check (mutation: drop the newly-marked branch; the test fails).
- QueueHoldStore forwards every non-write member, bound to the inner store (mutation: forward only `role`; the test fails).
- allIds returns ids only.

## DECIDED (option b, "lookup"): queue hold trusts a stale "read all" cache

The queue hold (QueueHoldStore) skips the targeted read for an unmarked row whose id it never saw once a
whole-corpus read has happened (`!this._readAll && !this._seen.has(id)`). Suppose another writer queues
row X after that read, and the caller gets X through a forwarded read (`findActiveByContentHash`, not tracked).
Then `updateMany([X with marker stripped, scope global])` is accepted.

Replay: a throwaway vitest probe (deleted afterwards). Its result:
`ACCEPTED {"id":"X","scope":"global","status":"active"}`.
This needs a second writer (another instance or process) between the read and the write. A shipping caller
path that strips a marker has not been shown.

Options:
- (a) Accept it: the caller's store lock and re-read cover it.
- (b) Always do the targeted read for ids not in `_seen`. This costs one loadByIds, or a full load on stores
  without loadByIds, on every write of a new id.
- (c) Also track forwarded reads (`findActiveByContentHash`) in `_seen`/`_queued`. This narrows the gap
  but does not close it.

Decision: (b). `QueueHoldStore._current` reads every id not in `_seen` in a targeted way, whole-corpus read
or not; the `_readAll` flag is gone. Test: `formal-backend-scopes-guard.test.ts` "a row queued by another
writer after a whole-corpus read is still held when written unmarked" (updateMany, append and save each
refused; failed before the change). No Lean model covers this cache (BackendScopes part B models the guard,
not the hold).
