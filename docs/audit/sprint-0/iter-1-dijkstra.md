# Sprint 0 Audit — Iter 1 — Dijkstra

## Verdict
SHIP_WITH_FIXES

## Summary

The substrate is largely correct. The two algorithmic hot paths I cared most
about — RRF fusion in `hybrid-search.ts` and pgvector cosine in
`storage-pglite.ts` — are sound. The benchmark harness's percentile and
footprint math are *close* to right but have one cosmetic off-by-one. The
biggest correctness concern is `vectorLiteral()` silently substituting `0` for
non-finite numbers — that smuggles bad embeddings into the index instead of
failing loudly. The biggest elegance concern is that
`PGLiteAdapter.searchBM25/searchVector` are interface methods with no
production caller — they're scaffolding for Wave 1 but ship in the public
adapter surface today as dead code that the test suite implicitly blesses.

The single-promise `_pgliteInitPromise` write pattern in `Plur` is racy on
paper but the in-adapter `AsyncMutex` rescues it. The mutex itself has a
subtle order-of-operations issue (assignment before `await prev`) that should
be tightened. Embedder pooling for EmbeddingGemma is `mean`, which is
unconventional for that family — flagged as MINOR pending Phase C numbers.

## Findings

### BLOCKER (correctness bugs)

None that block ship. The `vectorLiteral` substitution below is one rung
below blocker because it only fires on already-broken embeddings (an embedder
returning NaN is itself a bug); but it does *hide* such a bug.

### MAJOR (simplification/elegance worth doing now)

- [F-DIJK-001] **`vectorLiteral()` silently substitutes `0` for NaN/Infinity.**
  `packages/core/src/storage-pglite.ts:544-554`. The current comment
  rationalises the substitution as "pgvector doesn't allow non-finite, so we
  keep writes from throwing on malformed input." This is the wrong call. A
  vector containing NaN is a bug somewhere upstream (almost certainly a
  pooling/normalisation degenerate case on empty text). Substituting `0`
  produces a perfectly cosine-able vector that simply gives wrong recall
  results forever, with no signal. Recommendation: throw a typed error and
  let the caller decide. The `EmbedderAdapter` contract in
  `embedders/types.ts:23` already says adapters "return Float32Arrays of
  exactly `dim` floats" — the contract should require *finite* floats and the
  storage layer should refuse to serialise non-finite values.

- [F-DIJK-002] **`AsyncMutex.run()` has a TOCTOU on `this.queue`.**
  `storage-pglite.ts:55-70`. The current body:
  ```
  const prev = this.queue
  this.queue = wait
  await prev
  ```
  This is correct *only* because JS is single-threaded — between reading
  `this.queue` and writing it, no other promise can interleave. But the order
  reads backwards: by the time you `await prev`, `this.queue` already points
  at `wait`. A new caller arriving during the `await prev` will read `wait`,
  set `this.queue` to a new wait promise, and `await wait` — which doesn't
  resolve until `release()` fires in *this* run's finally. That's correct,
  but it relies on a non-obvious invariant (Promise.resolve() chain semantics
  + single-threaded execution). Recommendation: assert the invariant
  inline with a one-line comment, or use the idiomatic
  ```
  const prev = this.queue
  this.queue = prev.then(() => wait)
  await prev
  ```
  which makes "next caller queues after both prev *and* this run" explicit.
  Functionally equivalent today; clearer for the reader who has to verify
  serialization at 2am.

- [F-DIJK-003] **`searchBM25` / `searchVector` are unused production code.**
  `storage-pglite.ts:355-398`, exposed in `storage-adapter.ts:45-49`. Grep
  shows zero callers outside the test suite. `recallHybrid` still goes
  through the in-memory `hybridSearch()` over a YAML-loaded engram array, not
  through the adapter. This is fine *if* the README/CHANGELOG says "PGLite
  adapter ships in Sprint 0; routing through it lands in Wave 1." If not,
  shippers will believe pgvector is doing work when it isn't. Recommendation
  for this iter: tighten the docstrings on those three methods to say
  "added for #XXX, not yet wired into `Plur.recall*` — see Wave 1 PR." And
  add an integration test that asserts the methods exist and return the right
  shape, so the dead code is at least pinned by its contract.

- [F-DIJK-004] **`percentile()` off-by-one at the high end.**
  `benchmark/run.ts:196-200`. With `floor((p/100) * len)`, p=95 on a
  20-element array returns index 19 (the maximum), not the 95th percentile.
  For Sprint 0 N=30/cat this matters less than it sounds (the difference is
  one observation per category) but the formula reported in the headline
  table is wrong-by-one. Recommendation: switch to the nearest-rank linear
  interpolation
  ```
  const idx = Math.min(len - 1, Math.ceil((p / 100) * len) - 1)
  ```
  or, better, the simple-discrete formula
  ```
  const idx = Math.min(len - 1, Math.floor((p / 100) * (len - 1)))
  ```
  Both put p=95 on a 20-element array at index 18 (the 19th smallest),
  matching what `numpy.percentile(..., method='lower')` does. With N=500
  this shifts p95 by exactly one observation.

- [F-DIJK-005] **`_pgliteInitPromise` is the *latest* promise, not all of
  them.** `index.ts:215, 1849, 1881, 2051` reassign it; `waitForIndex`
  (`index.ts:1893-1897`) awaits whatever happens to be last. This is
  correct in practice *only* because every adapter mutation goes through the
  same `AsyncMutex` inside the adapter — the latest promise's resolution
  implies the prior ones have already resolved. That invariant is real but
  invisible at the call site. Recommendation: rename to `_lastIndexOp` and
  add a one-line comment explaining the "mutex inside adapter guarantees
  earlier promises are dead by the time we await this one" reasoning, so
  the next reader doesn't accidentally remove the mutex thinking it's
  redundant. Optionally, change `waitForIndex` to chain
  `await this._pgliteInitPromise` *in a loop* until the field stops changing,
  which would be defensive but unnecessary today.

### MINOR (taste)

- [F-DIJK-006] **`PGLiteAdapter` ctor default vs docstring drift.**
  `storage-pglite.ts:98-100` says default is 384 — BGE-small. Code at line 41
  says 768 (EmbeddingGemma). The docstring is stale. One-line fix.

- [F-DIJK-007] **EmbeddingGemma pooling is `mean`.** `embedders/embedding-gemma.ts:33`.
  The official EmbeddingGemma card recommends "last token" pooling for the
  generative-style encoder. The adapter's docstring (lines 10-13) explicitly
  acknowledges the choice but the transformers.js `feature-extraction`
  pipeline currently exposes only cls/mean/none. Recommendation: if Phase C
  shows EmbeddingGemma underperforming, revisit this — the pooling
  mismatch could be the cause. Document the assumption with a TODO and a
  link to the model card so the next person doesn't have to re-derive it.

- [F-DIJK-008] **`buildFilterClause` reuses `filter.scope` in two `$N`
  parameters.** `storage-pglite.ts:222-223`:
  ```
  conditions.push(`(scope = 'global' OR scope = $${i++} OR scope LIKE $${i++} || '%')`)
  params.push(filter.scope, filter.scope)
  ```
  Correct, but unnecessary — pgvector/PGLite supports parameter reuse:
  ```
  conditions.push(`(scope = 'global' OR scope = $${i} OR scope LIKE $${i} || '%')`)
  i++
  params.push(filter.scope)
  ```
  Saves one parameter slot per call and makes the SQL/params correspondence
  obvious.

- [F-DIJK-009] **`bytesToFloat32` returns a *view* when aligned.**
  `storage-pglite.ts:560-568`. If the underlying buffer is later mutated
  (e.g. PGLite reuses a pooled buffer for the next row), the Float32Array
  view changes. Current use is "view → cosine → discard" so this is safe,
  but the function name doesn't warn. Either always copy (one
  `Uint8Array(arr).buffer` allocation per row, cheap on small rows) or
  rename to `bytesToFloat32View` and document the aliasing.

- [F-DIJK-010] **`cosine` in adapter vs `cosineSimilarity` in
  embeddings.ts.** Two implementations, slightly different semantics: the
  adapter's `cosine` divides by `sqrt(na) * sqrt(nb)` (correct), while
  `embeddings.ts:152-156` returns the raw dot product on the assumption that
  vectors are already L2-normalised. The two diverge when an embedder
  forgets to normalise. Recommendation: have the adapter call out to a
  single shared `cosine()` helper, or at least add a debug assertion that
  vectors are unit-norm.

- [F-DIJK-011] **`hybridSearchWithMeta` mode signal is shared mutable state.**
  `embeddings.ts:30, 58-59`: `transformersUnavailable` and
  `embeddingsDisabled` are module-globals. `hybridSearchWithMeta` reads
  `embedderStatus()` *after* `Promise.all(...)` resolves, so a concurrent
  caller that fails mid-flight could flip the flag and make this call
  report `hybrid-degraded` even though it succeeded. Low probability in
  practice (recall isn't called concurrently in the MCP path), but a
  per-call status would be more honest.

### NIT

- `storage-pglite.ts:99` typo in PGLiteAdapterOptions docstring: "default:
  384 — BGE-small" — same as F-DIJK-006.
- `storage-pglite.ts:107, 120, 144, 234, 317, 325, 380, 392`: 9 `: any`
  annotations on `db` and `row`. Tightening to a minimal `PgliteDb` shape
  (`query`, `exec`, `waitReady`, `close`) would catch a future API rename.
- `benchmark/run.ts:42`: `export type EmbedderName = 'minilm' | 'bge-small'
  | 'bge-base' | 'embedding-gemma'` shadows the canonical
  `EmbedderName` from `embedders/index.ts` and silently *omits* `openai-3-large`.
  The intent is to limit harness CLI choices, but the type duplication will
  drift the next time someone adds a model. Use
  `Exclude<CoreEmbedderName, 'openai-3-large'>` instead.
- `storage-pglite.ts:99` comment says default 384, code says 768 — repeat
  of F-DIJK-006.

## Algorithm Audit

- **BM25 fusion**: correct. `searchBM25` delegates to the canonical
  `searchEngrams` in `fts.ts`, so there's a single tokenizer/IDF authority
  (stated in the docstring at `storage-pglite.ts:351-353`). Loading the
  candidate set into JS for ranking is the right call at this corpus size —
  no risk of PGLite's `to_tsvector` ranking diverging from the BM25 scorer
  used elsewhere.

- **Cosine similarity in PGLite (pgvector path)**: correct. `1 - (em.embedding
  <=> $1::vector)` uses pgvector's cosine-distance operator, where
  `distance = 1 - similarity`. The ORDER BY uses raw distance ascending,
  which matches similarity descending. No off-by-one.

- **Cosine similarity in PGLite (BYTEA fallback)**: correct. `cosine()` at
  `storage-pglite.ts:570-582` computes `dot / (sqrt(na) * sqrt(nb))` and
  handles zero-norm by returning 0. `Math.min(a.length, b.length)` defends
  against length mismatch (returns 0 if dims disagree because partial dots
  on truncated vectors still yield a finite similarity, but the zero-norm
  branch only catches *exactly* zero — a dim mismatch produces a
  meaningless-but-finite score, not an error). MINOR: should assert
  `a.length === b.length` and throw.

- **RRF**: correct. `rrfMerge` in `hybrid-search.ts:28-47` uses the standard
  `score = Σ 1 / (k + rank_i + 1)` with `k=60`. The `+ 1` converts 0-indexed
  loop counter to 1-indexed rank, matching the original Cormack/Clarke/Buettcher
  paper. Map-based accumulation handles "appears in both lists" by adding the
  two reciprocal-rank contributions. Final sort is descending by score. Clean.

- **Latency percentile calc**: minor off-by-one — see F-DIJK-004. The current
  formula `floor((p/100) * len)` clamps to `len-1`, so p=99 on small N
  silently degrades to the max. Use `floor((p/100) * (len-1))`.

- **Embedder dim check**: correct. `dim-check.ts:37-57` reads the column type
  via `pg_attribute.format_type(atttypid, atttypmod)`, parses the dim from
  `vector(N)`, and compares against the active embedder's `dim`. Returns
  null when the column doesn't exist or the BYTEA fallback is in use (safe
  default — no false-positive warnings). The function is pure (open → check
  → close) and swallows errors so `plur doctor` can't be brought down by a
  corrupt PGLite directory. Good.

## Mutation / State Hazards

- **`PGLiteAdapter.vectorDim`** is mutated in `recreateVectorColumn`
  (`storage-pglite.ts:464`). The constructor sets it from `opts?.vectorDim`,
  but after a reembed migration the field reflects the new dim. Callers
  that cached the value externally (none in the current codebase, but
  `index.ts` constructor reads `activeEmbedder.dim` once) won't see the
  change. Fine because nobody caches it, but the method name
  `recreateVectorColumn` doesn't tell you it also mutates the adapter's
  internal dim. MINOR rename: `recreateVectorColumnAtDim`.

- **`PGLiteAdapter.hasVector` / `hasAge`** are mutated in `initSchema` if
  the extension fails to load (`storage-pglite.ts:151, 161`). This is fine
  because `initSchema` is only called once before `initialized = true`.
  But there's a small window between the constructor returning and the
  first `getDb()` call where `this.hasVector === false` (the default field
  init) — *and* if `getDb()` itself throws partway through, the adapter is
  half-initialised. Recommendation: set `initialized = true` only after a
  successful `initSchema`, which it already does — good. The risk is that
  a partially-failed `initSchema` leaves `hasVector = true` but the table
  creation failed; subsequent `upsertEmbedding` calls would route to the
  pgvector branch with no table. This is theoretical — `CREATE TABLE IF NOT
  EXISTS` is non-throwing — but worth noting.

- **`testEmbedder`** at `storage-pglite.ts:48` is a module-level variable.
  Two test files that set it concurrently (or forget to reset) will see
  each other's state. Standard test-hook hazard; not specific to this PR.

- **`embedderStatus()` shared mutable state** — already covered in F-DIJK-011.

- **`Plur._pgliteInitPromise`** — already covered in F-DIJK-005. Briefly:
  shared field reassigned by every write path; `waitForIndex` only
  guarantees the *last* operation has completed. Safe today because the
  adapter's internal mutex orders the operations, but the invariant lives
  outside the call site.

- **`PgliteAdapter.db`** is mutated to `null` in `close()` and to a new
  PGlite instance in `getDb()`. A concurrent `close()` + `loadFiltered()`
  race would have one method see `null` after `await this.db.close()` while
  the other re-creates a fresh DB. No explicit guard. In tests with
  back-to-back `close()`/operation calls this could surface. Recommendation:
  guard `close()` with the mutex too.

## Types

- 0 `as any` casts across the audited files. Good.
- 9 untyped `any` declarations in `storage-pglite.ts` (`db: any`, `row: any`,
  etc.). All are pragmatic — `@electric-sql/pglite` types are imported
  lazily — but a one-line internal `interface PgliteDb { query, exec,
  waitReady, close }` would catch a future PGLite API rename and remove
  most of the `: any` noise. The `row: any` in `loadFiltered` and
  `searchVector` could be `{ data: unknown }` and `{ data: unknown; score:
  number }` respectively.
- `benchmark/run.ts:42` duplicates the `EmbedderName` type from core and
  silently excludes `openai-3-large`. Better: `Exclude<CoreEmbedderName,
  'openai-3-large'>`. See NIT entry above.
- `embedders/transformers-base.ts:54-57` casts the pipeline return value to
  `(input, opts) => Promise<{ data: Float32Array | number[] }>`. This is
  the only structural type assertion in the embedder layer and it's
  necessary because `@huggingface/transformers` ships generic `Pipeline`
  types. Acceptable.
- `embedders/openai.ts:57` parses the API response into `{ data?: Array<{
  embedding: number[] | string }> }`. The `string` branch is never handled
  — if OpenAI ever returns base64-encoded embeddings (they have an opt-in
  `encoding_format=base64` param), the code throws at the `Array.from(e)`
  line because `e` is a string. Today this is safe (we never request
  base64), but the `| string` in the type lies. Either drop it or handle
  it. MINOR.

## What I checked but didn't flag

- `storage-pglite.ts:283-315` `syncFromYaml` delete logic: correct. Drops
  primary-source rows not in YAML via a `jsonb_array_elements_text` join,
  which sidesteps the parameterised-IN size limit. Edge case `ids.size === 0`
  is handled (`DELETE FROM engrams WHERE source = 'primary'`). Good.
- `storage-pglite.ts:317-323, 325-346` upsert path: clean parameter binding,
  no SQL injection vectors, deterministic conflict resolution on `id`.
- `reembedAll` (`storage-pglite.ts:497-528`): the `full=true` /
  `full=false` branching matches the migration contract documented in
  index.ts:2017-2033. The `currentDim !== null && currentDim !== embedder.dim
  → skip` branch is the right safety guard.
- `embedders/index.ts:71-97`: exhaustiveness check via `_exhaustive: never`
  is the textbook way to make new enum values a compile error. Good.
- `embedders/dim-check.ts:46`: returns null when dims match, which is
  semantically "no warning needed". Caller treats null as "all clear".
  Clean.
- `benchmark/run.ts:141-167` `sampleScenarios`: correct Fisher-Yates partial
  shuffle for n ≤ pool, with-replacement sampling for n > pool. PRNG is
  mulberry32 with explicit seed — deterministic across runs. The categories
  are sorted before iteration so seed=1337 produces identical samples
  regardless of YAML order. Good.
- `benchmark/run.ts:299-314` ingest dedup: `ingestedScenarios` Set on
  scenario ID handles N > pool sampling-with-replacement correctly.
- `benchmark/run.ts:382` `store_size_bytes = dirSize(tmpDir)` measured at
  end-of-run after all writes have settled. `dirSize` recurses defensively
  and swallows `readdirSync` errors. Reasonable.

