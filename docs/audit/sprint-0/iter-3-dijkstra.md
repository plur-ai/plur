# Sprint 0 Audit — Iter 3 — Dijkstra verification

## Verdict
SHIP_WITH_FIXES

The big-hitter MAJORs from iter-1 are closed with tests. The new code (atomic
reembed, auto-embed wiring, dim-check) is algorithmically sound. The two
remaining open items (F-DIJK-002 mutex clarity, F-DIJK-005 _pgliteInitPromise
documentation) are tightening notes, not correctness defects — they can ship
as-is and be picked up in Wave 1. One new MINOR found: multi-statement
BEGIN/COMMIT in `db.exec` for the atomic swap relies on PGLite's
multi-statement-as-script semantics; worth a one-line comment but tests
demonstrate the end state is correct.

## Iter-1 finding closure

| Finding | Status | Evidence |
|---|---|---|
| F-DIJK-001 NaN/Infinity guard | CLOSED | `packages/core/src/storage-pglite.ts:655-673` — `vectorLiteral` now throws `Error("vectorLiteral: non-finite value at index N ...")` on any non-finite float. Tested in `packages/core/test/pglite-vector-literal.test.ts:41-69` for NaN, +Infinity, -Infinity. Throws are exercised through both `upsertEmbedding` and `searchVector`. |
| F-DIJK-002 AsyncMutex clarity | OPEN | `storage-pglite.ts:57-72` — body unchanged: `prev = this.queue; this.queue = wait; await prev`. No clarifying comment added and the `prev.then(() => wait)` form was not adopted. Functionally correct, but the 2am-reader hazard from iter-1 remains. |
| F-DIJK-003 dead code (searchBM25/searchVector) | PARTIAL | `searchVector` is now wired into production at `index.ts:1209-1241` (`_pgliteSemanticRecall`), `index.ts:1248-1290` (`_pgliteHybridRecall`), and `index.ts:1311-1329` (`similaritySearch`). `searchBM25` is still only called from `test/pglite-adapter.test.ts:274`. The hybrid path runs `searchEngrams(filtered, ...)` directly at `index.ts:1282` rather than going through the adapter's `searchBM25` method. The adapter method is still dead production code. |
| F-DIJK-004 percentile off-by-one | CLOSED | `benchmark/run.ts:196-206` — formula is now `Math.min(len-1, Math.floor((p/100)*(len-1)))`. Verified manually: N=20, p=95 → `floor(0.95*19) = floor(18.05) = 18` → array[18] = 19, not 20. Test at `benchmark/run.test.ts:73-81` asserts exactly this (p95 on `[1..20]` is 19, not 20). |
| F-DIJK-005 init promise doc | OPEN | `index.ts:189` field still named `_pgliteInitPromise`; comment at `index.ts:180-187` describes the adapter pattern but does not call out the "latest promise + adapter mutex orders earlier ops" invariant. `waitForIndex` at `index.ts:2111-2115` awaits whatever is most recent with no explanation of why that's sufficient. Reads correctly but the invariant remains invisible. |
| F-DIJK-006 options doc drift | CLOSED | `storage-pglite.ts:34-43` (`DEFAULT_VECTOR_DIM = 384`) and `:100-108` (`PGLiteAdapterOptions.vectorDim` docstring: "Default: 384 ... matches the v0.10 default embedder bge-small per iter-2 audit B-2 revert") now agree. The default flipped in #219 then reverted in iter-2 B-2; the docs reflect the post-revert state. `doctor.ts:583` also matches (BGE-small-en-v1.5 ~130MB). |

## Algorithmic audit of new code

- **Atomic reembed (storage-pglite.ts:537-639)**: CORRECT. The build-new-then-swap
  flow is the right pattern. Three failure modes traced:
  1. Embed loop throws mid-rebuild (line 596-625): scratch table is dropped,
     live table never touched, vectorDim never updated. Test
     `pglite-reembed-atomic.test.ts:131-151` verifies the live table still
     contains the pre-existing row and the dim is still 384 after a
     simulated failure.
  2. Process crashes between scratch CREATE and the swap exec: scratch
     persists on disk; next run's `DROP TABLE IF EXISTS engram_embeddings_new`
     at line 577 cleans it up. Safe.
  3. Crash mid-swap (`BEGIN; DROP; ALTER RENAME; COMMIT;`): depends on
     PGLite's multi-statement exec semantics — see new finding below.

  The mutex at line 575 serialises this entire flow against concurrent
  `learn()` / `upsertEmbedding()` / `syncFromYaml` — the swap cannot race
  the index mirror. Pre-flight non-finite check at line 599-607 surfaces
  the bug at the migration boundary with engram context instead of waiting
  for `vectorLiteral` to throw with only an index. Good defensive layering.

- **Auto-embed wiring (index.ts:2063-2108)**: CORRECT for the happy path,
  acceptable race. Order: `syncFromYaml` (relational row) → `_autoEmbedNewEngrams`
  (embedding upsert). Logical FK is honored. The dim-defense at line 2071-2078
  (skip the cycle when active embedder dim differs from indexed column) is
  exactly right — without it, every `learn()` after an embedder change would
  log a vectorLiteral throw warning forever.

  Concurrency: two parallel `learn()` calls produce two `_syncIndex` calls
  → two pending `_pgliteInitPromise` replacements. Each chain calls
  `_autoEmbedNewEngrams`, which is NOT mutex-wrapped. Two concurrent runs
  can both see an engram as "missing" (line 2086 `hasEmbedding` check),
  both compute its embedding, both upsert. The upsert itself is mutex-guarded
  and idempotent (`ON CONFLICT DO UPDATE`). Net effect: redundant compute on
  a narrow window, no corruption. Not a correctness bug.

  Filter at line 2082 `!(e as any)._originalId && !(e as any)._pack` is the
  right call — pack engrams have their own embedding lifecycle and shouldn't
  leak into the primary index.

- **dim-check.ts comparison logic**: CORRECT. Edge cases traced:
  - `indexedDim === null` (BYTEA fallback or missing column): no warning, line 59.
  - `indexedDim === activeDim`: no warning, line 59 inequality.
  - `indexedDim !== activeDim`: warning, line 59-64. ✓
  - Legacy JSON cache (no `meta` block): hard mismatch warning at line 81-92.
  - JSON cache `meta.embedder_dim === activeDim` but `embedder_name !== activeName`:
    warning fires (line 96-99 — checks both dim AND name independently).
    This is the "same-dim, different-family" case (e.g. BGE-base 768 →
    EmbeddingGemma 768). Correct.
  - `activeEmbedderName === undefined`: name comparison short-circuits via
    `inputs.activeEmbedderName !== undefined` guard at line 97. No false
    positive. ✓
  - Corrupt JSON cache: try/catch at line 77-116 swallows and returns null.
    Doctor continues other checks. ✓
  - Theoretical `indexedDim === 0`: `0 !== null` → enters branch, `0 !==
    activeDim` → warns. `vector(0)` is illegal in pgvector so this can't
    occur on a real DB, but the comparison wouldn't produce a wrong result
    either way.

  The adapter is constructed with `vectorDim: inputs.activeEmbedderDim`
  (line 55) — that's a sneaky detail. If the on-disk schema disagrees
  with the requested dim, `getVectorColumnDim()` reads the on-disk type
  via `format_type(...)`, not the constructor arg, so the mismatch is
  still detected. Verified by reading `getVectorColumnDim` at
  `storage-pglite.ts:437-452` — it queries `pg_attribute`, not adapter state. ✓

## New findings

- **[F-DIJK-NEW-001]** **Multi-statement `BEGIN; ... COMMIT;` sent via
  `db.exec` for the atomic swap.** `storage-pglite.ts:629-634`. PGLite's
  `exec(string)` accepts multi-statement input and runs it as a script.
  Whether the script is itself transactional in the presence of a mid-script
  crash depends on PGLite's WASM persistence semantics, which differ from a
  proper `db.transaction(async () => {...})` API. For DROP+RENAME at the
  same logical instant this matters less than for arbitrary data
  modifications (worst-case partial failure: live table dropped, scratch
  rename not yet committed → next process startup sees no embeddings, but
  YAML is still source of truth and `plur sync --reembed --full` rebuilds).
  RECOMMENDATION: prefer `db.transaction(async (tx) => { await tx.exec('DROP
  TABLE IF EXISTS engram_embeddings'); await tx.exec('ALTER TABLE
  engram_embeddings_new RENAME TO engram_embeddings'); })` if PGLite exposes
  the closure form; otherwise add a one-line comment at line 627 noting that
  the atomicity guarantee here is "best-effort multi-statement exec; YAML
  rebuilds the lost index in the worst case." MINOR.

- **[F-DIJK-NEW-002]** **Auto-embed's `hasEmbedding` loop is N round trips.**
  `index.ts:2085-2088`. For each missing-candidate ID, one `SELECT 1 ...
  WHERE engram_id = $1` query. With M new engrams and N already-indexed,
  this is M queries even when M is small. The cheaper alternative is one
  query: `SELECT engram_id FROM engram_embeddings WHERE engram_id = ANY($1)`
  returning the set of indexed IDs, then compute the missing set in JS.
  Today's volumes don't justify the refactor (M is usually 1-5 per learn
  cycle, queries are local in-process), but at 10k+ engrams the chatter
  becomes measurable. NIT — optimisation, not correctness.

- **[F-DIJK-NEW-003]** **`_reembedFullAtomic` holds the mutex across the
  entire embed loop.** `storage-pglite.ts:575-638`. For a 10k-engram corpus
  on an ONNX BGE-small embedder at ~50ms/embed, that's an 8-minute mutex
  hold. Any concurrent `learn()` blocks until the migration completes.
  Correctness-safe (intent: migration is exclusive) but a latency surprise
  if the user runs `plur sync --reembed --full` while a chat session is
  active. RECOMMENDATION: document this expectation in the `reembedAll`
  docstring at line 521 — "concurrent learns block until migration
  finishes" — so callers aren't surprised. NIT.

## Closing assessment

- **Verdict**: SHIP_WITH_FIXES. The two correctness-critical iter-1 MAJORs
  (vectorLiteral guard, percentile) are fixed with tests; the searchVector
  dead-code concern is resolved by wiring; the doc drift is resolved; the
  new atomic-reembed and auto-embed code is algorithmically sound. The two
  remaining iter-1 items (F-DIJK-002 mutex clarity, F-DIJK-005 init promise
  documentation) are clarity/tightening notes and do not block ship — they
  can land as a one-PR follow-up in Wave 1. F-DIJK-NEW-001 (multi-statement
  swap semantics) is the only new finding worth a second look before the
  Wave 1 work touches this path again.
