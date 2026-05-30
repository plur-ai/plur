# Sprint 0 Audit — Iter 1 — Data

## Verdict
SHIP_WITH_FIXES

## Summary

Sprint 0 lands the substrate (PGLite adapter, embedder factory + bake-off,
EmbeddingGemma default, reembed migration, benchmark extensions, two
YAML-as-truth invariant tests). The headline contracts hold in the happy
path. What fails the edge-case sweep:

1. `reembedAll({ full: true })` is **non-transactional**. The vector column
   is recreated BEFORE the embed loop starts. If `embedder.embed()` throws
   partway through (network blip on `openai-3-large`, ONNX runtime crash,
   process killed), the column lands at the new dim with a partial
   embedding set — no rollback, no resume marker. The next `plur sync
   --reembed --full` re-runs from scratch, but until then hybrid recall is
   silently degraded for any engram that hasn't been re-embedded.

2. **Reembed + concurrent learn is unsafe.** `reembedAll` reads YAML once
   at the top, then loops embedding + upserting. A concurrent `learn()`
   appends to YAML and fires `_syncIndex` → `syncFromYaml` which queues
   behind the PGLite mutex. After reembed finishes, the new engram lands
   in the `engrams` table via syncFromYaml but **never gets an embedding
   inserted into `engram_embeddings`** (there is no insert-time embedder
   wired into the YAML→PGLite sync). Engrams created during a long
   reembed run stay invisible to vector search until the next reembed.

3. **YAML-as-truth Test B does NOT actually probe DB-only insertion.** It
   asserts that every engram returned by public methods is in YAML — but
   today every public read path goes through YAML directly (`_loadAllEngrams`
   never reads PGLite). The test would pass trivially even if the PGLite
   adapter actively forged synthetic engrams, because no read path
   exercises the adapter's `loadFiltered`. The intended-future invariant
   is documented but not yet under test. Add a targeted test that calls
   `pgliteAdapter.loadFiltered({})` directly, inserts an engram into
   PGLite via raw SQL (not YAML), and confirms either (a) it doesn't
   appear via any public method or (b) a future implementation that
   reads from PGLite would reject it.

4. **PGLite is currently a dark path for reads.** `_filterEngrams` only
   uses the SQLite `indexedStorage`; when `pgliteAdapter` is set,
   `indexedStorage` is null and we fall through to a YAML scan. The
   entire PGLite vector column + dim mismatch detection chain is
   preemptive infrastructure with no production caller — pgvector
   `searchVector` is only called from tests. This is fine as Sprint 0
   scope, but the embedder-dim-mismatch warning in `plur doctor` warns
   about a degradation that does not yet happen in recall.

5. The benchmark with `iterations >> pool.length` ingests the same N
   engrams once (deduped by scenario.id) but issues N*pool query rounds
   against the SAME ingested set. So `--iterations 500` with the local
   5/category fixture is really "5 unique scenarios queried 100 times
   each per category." The reported `scenario_count: 3000` overstates
   independent samples. The README + tests need a callout — the
   numbers are statistically defensible only when the underlying pool
   matches `iterations`.

6. `embeddings.ts` and `index.ts` route through `getEmbedder(resolveEmbedderName())`
   — but the legacy `embeddings.ts` per-engram in-memory `.embeddings-cache.json`
   has no embedder identity in its cache key. After switching from
   bge-small to embedding-gemma, the on-disk cache returns 384d vectors
   for a 768d query → `cosineSimilarity` runs over the shorter dim and
   silently produces a nonsense score. The reembed migration only fixes
   PGLite; the JSON cache is still poisoned. (And the JSON cache is the
   path hybrid-search actually uses today.)

7. Minor doc drift: `PGLiteAdapterOptions.vectorDim` JSDoc says "default:
   384 — BGE-small" but the constant is now `DEFAULT_VECTOR_DIM = 768`
   (EmbeddingGemma). Fix the comment.

## Findings

### BLOCKER

(none — the substrate is sound enough to merge, but ship after fixing
F-DATA-001 and F-DATA-002 or the migration story has gaps.)

### MAJOR

- **[F-DATA-001] reembedAll({ full: true }) is non-transactional.** If the
  embedder throws partway through the loop, the column is at the new dim
  but only some engrams have embeddings. There is no resume marker, no
  on-error rollback to the previous column dim, and no "I'm in a migration"
  state on the adapter. Fix options: (a) write all new embeddings to a
  temp table then RENAME; (b) record a `migration_in_progress` row with
  the target dim and the set of completed engram IDs, and resume from
  that on next sync. At minimum, the error message thrown should include
  "your index is in a partial-migration state, run `plur sync --reembed
  --full` again to retry" so the user understands recovery.
  File: `packages/core/src/storage-pglite.ts:497-528`.

- **[F-DATA-002] Reembed + concurrent learn drops embeddings.**
  `syncFromYaml` inserts new engrams into `engrams` but never populates
  `engram_embeddings` — that's only done by `upsertEmbedding` (called by
  reembedAll). After a reembed completes, engrams created during the
  reembed are present in the relational index but absent from the vector
  index. No alert, no warning. Fix: either embed-on-syncFromYaml (uses
  the active adapter), or have reembedAll watch for YAML mtime change
  during the loop and re-snapshot, or add a "missing embedding" check
  to `plur doctor`. Current behavior is "vector search silently misses
  recently-learned engrams under contention."
  File: `packages/core/src/storage-pglite.ts:283-315` + `497-528`,
  plus `packages/core/src/index.ts:1877-1890` (`_syncIndex`).

- **[F-DATA-003] embeddings.ts JSON cache is dim-blind.** The on-disk
  `.embeddings-cache.json` keys by `engram.id` and stores `embedding:
  number[]`. When the active embedder changes from 384d to 768d, the
  cache returns the stale 384d entry, gets passed to `cosineSimilarity`
  with a 768d query, and the dot-product loop happily runs over the
  shorter `a.length` — producing a meaningless score that pollutes RRF
  results. Fix: include the embedder name (or `dim`) in the cache entry,
  invalidate on mismatch, and ideally key the file path by embedder
  name (e.g. `.embeddings-cache.embedding-gemma.json`). This is the cache
  hybrid-search actually uses today, so the bug surfaces in production
  the moment a user flips PLUR_EMBEDDER.
  File: `packages/core/src/embeddings.ts:158-179, 196-243`.

- **[F-DATA-004] YAML-truth Test B is structurally weak — does not
  probe the actual invariant.** All public methods today read from YAML
  via `_loadAllEngrams`, so Test B trivially passes regardless of
  whether the DB has rogue data. Add a hostile scenario: open the
  PGLite store directly, INSERT a row with id=`ENG-9999-9999-001` into
  `engrams` (bypassing YAML), then assert that **no** public method
  returns that ID. Without this, the test is documentation, not
  verification.
  File: `packages/core/test/yaml-truth-traceability.test.ts:34-150`.

### MINOR

- **[F-DATA-005] Empty-iterations edge case throws unhelpfully.**
  `runBenchmark({ iterations: 0 })` and `runBenchmark({ iterations: -1 })`
  both reach `sampleScenarios` which returns an empty array, then
  `runBenchmark` throws `"No scenarios found."` — the same error path as
  "I gave you a category that doesn't exist." Validate
  `iterations >= 1` up front and surface a specific error.
  Same for `parseInt('--iterations abc')` which produces `NaN` and the
  comparison `n <= pool.length` yields false (NaN propagates), the else
  branch loops `for (let i = 0; i < NaN; i++)` zero times, and we end
  up in the same generic "No scenarios" error.
  File: `benchmark/run.ts:141-167, 283-285, 511-524`.

- **[F-DATA-006] Benchmark with `iterations > pool_size` reports
  inflated counts.** Sampling-with-replacement gives the harness N*K
  rows per category but only `min(N, K)` distinct engrams ingested
  (`ingestedScenarios` Set). Ingest dedupes; queries don't. Report
  metadata should expose the distinct-scenario count alongside
  `scenario_count`. Otherwise a 500-iter run on a 5-pool fixture
  produces graphs that look like a 500-sample evaluation but is
  statistically a 5-sample evaluation queried 100 times.
  File: `benchmark/run.ts:296-318, 403-422`.

- **[F-DATA-007] reembedAll skips the dim-check when `currentDim` is
  null** (BYTEA fallback or no embeddings table yet). The comment
  acknowledges this; the consequence is that on the BYTEA path,
  flipping embedders re-embeds at the new dim and the BYTEA blobs are
  now a mix of old-dim and new-dim byte strings. The JS cosine
  fallback in `bytesToFloat32 → cosine(a, b)` uses `Math.min(a.length,
  b.length)` so it doesn't throw — it just produces garbage scores.
  Same bug class as F-DATA-003. Either track dim per row or refuse
  vector search when the BYTEA path has mixed-dim rows.
  File: `packages/core/src/storage-pglite.ts:497-528, 560-582`.

- **[F-DATA-008] `vectorLiteral` silently substitutes 0 for non-finite
  inputs.** A NaN or Infinity in a vector becomes "0" in the pgvector
  literal — search proceeds with a corrupted query but no error. If an
  embedder is producing NaN (e.g. OpenAI returned an unnormalized
  vector after a model quirk), the engineer sees mediocre recall, not
  an error. Either reject the embed call upstream or throw from
  `vectorLiteral`. Same call site is used by `upsertEmbedding`, so a
  bad embedder can persist corrupted vectors to disk.
  File: `packages/core/src/storage-pglite.ts:544-554`.

- **[F-DATA-009] `searchVector` against a column with mismatched dim
  throws an uncaught pgvector error.** pgvector's `<=>` operator
  enforces dimension equality. Today no production caller of
  `searchVector` exists, but if a future PR routes recall through
  PGLite (which is the announced direction), the user is one
  PLUR_EMBEDDER flip away from a recall exception. The doctor warning
  is the only protection. Wrap `searchVector` in a try/catch that
  returns `[]` plus logs a once-per-process "vector index dim mismatch
  — run plur sync --reembed --full" line.
  File: `packages/core/src/storage-pglite.ts:364-398`.

- **[F-DATA-010] Plur constructor + PGLite + openai-3-large: vector
  column at 3072d is silently accepted.** pgvector supports up to
  16000 dims so the column creation succeeds, but the resulting on-disk
  footprint and query cost are 8x BGE-small. No warning. Document the
  consequence in the embedder factory header — or refuse and require
  explicit opt-in (e.g. PLUR_ALLOW_LARGE_VECTORS=1) for >1024.
  File: `packages/core/src/index.ts:202-217`.

- **[F-DATA-011] `resolveEmbedderName` warns once per process per
  module load.** `warnedUnknown` is a module-global latch. The first
  invalid PLUR_EMBEDDER value triggers a single warning; any subsequent
  invalid values (e.g. running the harness across different bad envs in
  the same Node process) are silent. Reset on a value-change boundary
  if multi-warning is desired.
  File: `packages/core/src/embedders/index.ts:106-118`.

- **[F-DATA-012] PGLite initial sync in Plur constructor runs in
  background but errors only logged.** If `syncFromYaml` fails on
  first construction (disk full, PGLite WASM crash), the user sees a
  log line. There's no health flag the caller can read. `plur doctor`
  doesn't probe PGLite explicitly; it only checks dim mismatch.
  File: `packages/core/src/index.ts:209-217`.

### NIT

- **[F-DATA-013] Stale JSDoc.**
  `PGLiteAdapterOptions.vectorDim` says "default: 384 — BGE-small" but
  the constant is now 768 (EmbeddingGemma). Fix the comment to match
  `DEFAULT_VECTOR_DIM = 768`.
  File: `packages/core/src/storage-pglite.ts:98-101`.

- **[F-DATA-014] `loadEngrams` is called twice in reembedAll-via-Plur
  path.** Plur.sync calls `_syncIndex` (which loads YAML), then
  reembedAll loads YAML again. Trivial overhead, but at large stores
  it's measurable. Pass the loaded engrams down.

- **[F-DATA-015] Benchmark `config.yaml: 'auto_learn: true\nindex:
  false\n'` sets index=false, but if PLUR_BACKEND=pglite is set in the
  parent shell the PGLite adapter spins up anyway. Either explicitly
  unset PLUR_BACKEND in `runBenchmark` or document that the bench
  measures whichever backend the caller's env selects.
  File: `benchmark/run.ts:287-293`.

- **[F-DATA-016] `_pgliteInitPromise` is reassigned without chaining.**
  If reindex() fires while syncFromYaml() is still in flight, the
  prior promise is dropped from the field but still running. PGLite's
  AsyncMutex serialises the work, so correctness holds; observability
  doesn't — `waitForIndex` only awaits the last assigned promise.
  File: `packages/core/src/index.ts:187, 215, 1849, 1881, 1893-1897`.

- **[F-DATA-017] `percentile([x], 99)` returns x.** Reasonable
  fallback for length-1 arrays, but the reported p99 latency on a
  single-scenario benchmark equals the p50 latency, which can hide
  outlier alarming if the bench is ever called with N=1. Minor; flag
  in the docs.
  File: `benchmark/run.ts:196-200`.

## Edge Case Coverage Matrix

| Operation | Edge case | Handled? | File:line |
|---|---|---|---|
| Plur.sync | empty store | yes (sync OK, reembed → "yaml not present" or 0-engram loop) | `packages/core/src/index.ts:2034-2059` |
| Plur.sync | reembed with same dim (not --full) | yes — re-embeds all (idempotent) | `packages/core/src/storage-pglite.ts:510-527` |
| Plur.sync | reembed with same dim AND --full | yes — drops + recreates + reembeds | `packages/core/src/storage-pglite.ts:508-527` |
| Plur.sync | reembed mid-process: embedder throws | NO — partial migration, no rollback | `packages/core/src/storage-pglite.ts:520-527` (F-DATA-001) |
| Plur.sync | reembed with embedder unavailable up front | yes — returns `{ skipped: true, reason: 'no embedder supplied' }` | `packages/core/src/storage-pglite.ts:500-503` |
| Plur.sync | concurrent learn during sync | partial — PGLite mutex serialises; embeddings NOT auto-applied to new engrams | `packages/core/src/storage-pglite.ts:283-315` (F-DATA-002) |
| Plur.sync | PLUR_BACKEND=sqlite, reembed=true | yes — silently no-op (no pgliteAdapter) | `packages/core/src/index.ts:2045` |
| PGLiteAdapter constructor | first cold start, no DB | yes — getDb lazily creates dir + schema | `packages/core/src/storage-pglite.ts:120-141` |
| PGLiteAdapter constructor | PGLite WASM unavailable | partial — error caught in Plur constructor `.catch`, logged but no health flag exposed | `packages/core/src/index.ts:215-217` (F-DATA-012) |
| PGLiteAdapter syncFromYaml | duplicate IDs in YAML | yes — ON CONFLICT (id) DO UPDATE last write wins | `packages/core/src/storage-pglite.ts:325-346` |
| PGLiteAdapter syncFromYaml | empty YAML file | yes — `if (ids.size > 0)` branch handles 0-id case via DELETE WHERE source='primary' | `packages/core/src/storage-pglite.ts:296-308` |
| PGLiteAdapter syncFromYaml | YAML deleted between calls | yes — existsSync guard, DELETE primary rows | `packages/core/src/storage-pglite.ts:289-295, 306-308` |
| PGLiteAdapter searchVector | empty embedding table | yes — short-circuit to `[]` | `packages/core/src/storage-pglite.ts:366-367` |
| PGLiteAdapter searchVector | query dim != column dim (pgvector path) | NO — pgvector throws; uncaught | `packages/core/src/storage-pglite.ts:368-384` (F-DATA-009) |
| PGLiteAdapter searchVector | NaN/Inf in query | NO — silently substituted with 0, returns garbage scores | `packages/core/src/storage-pglite.ts:544-554` (F-DATA-008) |
| PGLiteAdapter upsertEmbedding | NaN/Inf in vector | NO — same vectorLiteral path, persists 0s to disk | `packages/core/src/storage-pglite.ts:400-421, 544-554` (F-DATA-008) |
| Embedder factory | unknown name (getEmbedder) | yes — throws "Unknown embedder" | `packages/core/src/embedders/index.ts:71-74` |
| Embedder factory | unknown name (resolveEmbedderName) | yes — warns once, falls back to default | `packages/core/src/embedders/index.ts:107-118` |
| Embedder factory | PLUR_EMBEDDER="" (empty string after trim) | yes — falls through to default | `packages/core/src/embedders/index.ts:108-109` |
| Embedder factory | openai-3-large + OPENAI_API_KEY missing | yes — adapter constructs metadata only; throws on first embed() call with `OPENAI_API_KEY` mention | `packages/core/src/embedders/openai.ts:28-36` |
| Embedder factory | openai-3-large + dim/length mismatch from API | yes — throws "returned X-dim, expected 3072" | `packages/core/src/embedders/openai.ts:65-74` |
| Embedder factory | openai-3-large + non-array embedding from API | yes — throws "non-array embedding at index i" | `packages/core/src/embedders/openai.ts:64-66` |
| Embedder factory | openai-3-large + 500 from API | yes — throws "HTTP 500" with body slice | `packages/core/src/embedders/openai.ts:51-56` |
| dim-check | PGLite path missing | yes — returns null | `packages/core/src/embedders/dim-check.ts:38` |
| dim-check | dims match | yes — returns null | `packages/core/src/embedders/dim-check.ts:46` |
| dim-check | dims differ | yes — returns warning, message includes `plur sync --reembed --full` | `packages/core/src/embedders/dim-check.ts:48-50` |
| dim-check | adapter throws during getVectorColumnDim | yes — try/catch returns null | `packages/core/src/embedders/dim-check.ts:51-53` |
| Benchmark run | --iterations 0 | partial — generic "No scenarios" error (F-DATA-005) | `benchmark/run.ts:283-285` |
| Benchmark run | --iterations -1 | partial — same generic error | `benchmark/run.ts:283-285` (F-DATA-005) |
| Benchmark run | --iterations NaN (parseInt failure) | partial — same generic error | `benchmark/run.ts:283-285, 515` (F-DATA-005) |
| Benchmark run | --iterations > scenarios available | yes — samples with replacement, but ingest dedupes; ingest count is `min(N, K)`, queries are `N*K` per category (F-DATA-006) | `benchmark/run.ts:158-164, 299-318` |
| Benchmark run | --embedder openai-3-large (excluded) | yes — `KNOWN_EMBEDDERS` filter throws "Unknown embedder" | `benchmark/run.ts:231-242` |
| Benchmark run | --embedder gibberish | yes — throws "Unknown embedder" | `benchmark/run.ts:240-242` |
| Benchmark run | embedder cold load fails | yes — catches, logs, continues; bench reports `embedder_stub_fallback: false` (always — could be misleading) | `benchmark/run.ts:258-270` |
| YAML-truth Test A | nuke-the-db + rebuild on YAML | yes (in-memory cache today; PGLite gets a CI check via integration test in `pglite-adapter.test.ts:407-427`) | `packages/core/test/yaml-truth-rebuild.test.ts` |
| YAML-truth Test B | adversarial DB-only insert | NO — test doesn't construct this case (F-DATA-004) | `packages/core/test/yaml-truth-traceability.test.ts` |

## Cross-Feature Interactions Examined

- **PGLite + openai-3-large**: column auto-sized to 3072d. pgvector supports
  this but the on-disk + RAM cost is 8x BGE-small. No warning at
  construction. F-DATA-010.
- **PGLite + reembed + concurrent learn**: reembed reads YAML snapshot,
  concurrent learns get into YAML and into `engrams` table via
  syncFromYaml, but never get embeddings. F-DATA-002.
- **PGLite + reembed + embedder failure mid-loop**: column at new dim,
  partial embeddings. No rollback marker, next reembed starts over from
  scratch but until then vector search is broken for un-embedded rows.
  F-DATA-001.
- **PGLite + BYTEA fallback + embedder switch**: silently stores
  mixed-dim byte blobs. Cosine doesn't throw (Math.min(a.length,
  b.length)). F-DATA-007.
- **Bake-off harness + embedding-gemma + offline CI**: harness calls
  `adapter.embed('warmup')` which would download the model. The test
  uses `searchMode='bm25'` so recall doesn't touch embeddings, but the
  warmup itself will hit the network on first run. Tests in
  `embedders.test.ts` gate on `PLUR_EMBEDDER_NETWORK_TESTS=1` for the
  live loads; benchmark tests do not.
- **Embedder switch + JSON .embeddings-cache.json**: cache returns
  stale-dim vectors, cosineSimilarity loops over `Math.min(a, b)`
  shorter dim → silent garbage. F-DATA-003.
- **Plur.sync with both `--full` and `--reembed`**: order is reindex
  (drops engrams table, repopulates from YAML), then reembed (drops
  embedding table, recreates at new dim, re-embeds). Both fire async
  in background; `waitForIndex` only awaits the last assignment.
  Acceptable but fragile.
- **Plur constructor + PLUR_BACKEND=pglite + no engrams.yaml**:
  PGLiteAdapter.syncFromYaml gracefully no-ops (existsSync false).
  First learn() creates YAML, _syncIndex fires syncFromYaml, picks
  up the new engram. OK.

## Logical Inconsistencies

- **Sprint 0 PR 5 lifts the default embedder dim from 384 to 768, but
  the on-disk `.embeddings-cache.json` cache has no dim/embedder identity.**
  Existing v0.9.x users with a populated cache will hit
  `cosineSimilarity(query768, cached384)` on every recall after upgrade.
  The reembed migration fixes PGLite (which today isn't even on a read
  path) but doesn't touch the JSON cache (which IS the production read
  path). Net effect: users who upgrade and don't manually `rm
  ~/.plur/.embeddings-cache.json` get worse recall than v0.9.x.
  Same root cause as F-DATA-003; called out separately because this is
  the inconsistency between "we did a careful migration" and "the
  migration touches the wrong artifact."

- **`plur doctor` warns about a degradation that doesn't yet occur.**
  The dim-mismatch warning points at `plur sync --reembed --full`, but
  the PGLite vector column isn't on the recall path today. The warning
  is preemptive infrastructure for Wave 1. Fine, but it's an
  inconsistency between the doctor message ("hybrid recall will fall
  back to BM25") and the actual recall path (which doesn't use PGLite).
  Either update the message to "future hybrid recall…" or land the
  PGLite-routed recall first.
  File: `packages/core/src/embedders/dim-check.ts:46-50`,
        `packages/cli/src/commands/doctor.ts:546-559`.

- **YAML-truth Test B and the comment "if a future feature inserts
  engrams into the DB-only index without also writing them to YAML…
  this test fails" overstate the test's reach.** Today, the test
  cannot detect such a feature because no read path exercises the DB.
  Either revise the comment to "this test will fail once `_loadAllEngrams`
  is wired through PGLite" or add the adversarial-insert scenario from
  F-DATA-004.

- **Benchmark `embedder_stub_fallback` field is always `false`.**
  `const embedderStubFallback = false` is set unconditionally even when
  the embedder cold-load fails (caught + logged + continue). The field
  exists for the bake-off (PR 4) where stub adapters used to fall back
  to MiniLM; with all four adapters real, the field is a permanent
  false and the JSON consumers cannot distinguish "loaded successfully"
  from "load failed, hybrid degraded."
  File: `benchmark/run.ts:258, 407`.

- **`storage-pglite.ts` writes `source: 'primary'` for all
  syncFromYaml-driven engrams** but the schema supports a `source`
  column intended to distinguish primary / secondary stores. Secondary
  stores are loaded via Plur's `_loadAllEngrams` → YAML path, not via
  the adapter, so the source column is always 'primary'. The
  `idx_engrams_source` index is dead weight today. Drop it or
  populate the column from a real source field. Minor cleanup, but
  the schema implies a polymorphism the runtime doesn't deliver.
  File: `packages/core/src/storage-pglite.ts:163-180, 325-346`.
