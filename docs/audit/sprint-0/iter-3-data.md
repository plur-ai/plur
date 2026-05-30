# Sprint 0 Audit — Iter 3 — Data verification

## Verdict
SHIP_WITH_FIXES

The four iter-1 majors are addressed in code and have dedicated tests.
F-DATA-001 (atomic reembed) and F-DATA-003 (cache stamping) are fully
closed. F-DATA-002 (concurrent learn + reembed) is mostly closed but a
narrow race window remains. F-DATA-004 (adversarial Test B) is partially
closed — the new test exercises the application-level intersect defense
but does NOT probe the true DB-only insertion scenario it claims to test.

Separately, a real infrastructure issue surfaces under full-suite
concurrency: PGLite WASM workers fail to initialise (`mkdir ENOENT`,
`PGlite failed to initialize properly`) when many test files spin up
PGLite instances in parallel forks. Individual test files all pass when
run in isolation. This is a Sprint 0 test-infrastructure flake, not a
runtime bug, but it blocks the CI gate as-is and needs an iter-3 fix
before merge.

## Iter-1 finding closure

| Finding | Status | Evidence |
|---|---|---|
| F-DATA-001 reembed transactionality | **CLOSED** | `storage-pglite.ts:567-639` `_reembedFullAtomic` builds `engram_embeddings_new` first, populates it, then atomic `BEGIN; DROP; ALTER...RENAME; COMMIT;`. Mid-loop embedder failure drops the scratch table and bubbles up — live `engram_embeddings` is untouched. Test `pglite-reembed-atomic.test.ts:131-151` seeds the live table, runs `failingEmbedder(768, 2)`, asserts live table still has its 1 seed row at original 384d. Passes in isolation. |
| F-DATA-002 reembed-race with concurrent learn | **PARTIAL** | `index.ts:2036-2054` `_syncIndex` chains `syncFromYaml().then(_autoEmbedNewEngrams)` so learn → YAML write → relational insert → embed-and-upsert all happen in sequence. `index.ts:2063-2108` `_autoEmbedNewEngrams` skips when dims differ (defending against mid-process PLUR_EMBEDDER changes). For the common single-process case this closes the gap. Remaining race: reembed snapshots YAML at `storage-pglite.ts:540` BEFORE acquiring the mutex; if a learn writes YAML between snapshot and mutex acquisition, that engram lands in `engrams` table via syncFromYaml but is missing from the scratch `engram_embeddings_new` (the snapshot is stale). The follow-up `_autoEmbedNewEngrams` from the racing learn will queue behind the mutex and embed it post-swap, so the gap auto-heals on the next event-loop tick — but there is a window where the relational row exists without a vector. Acceptable given YAML is canonical, but the iter-1 wording "drops embeddings" is no longer accurate; it now "delays embedding by one tick under race." |
| F-DATA-003 cache dim-unaware | **CLOSED** | `embeddings.ts:198-247` introduces v1 format `{ meta: { embedder_name, embedder_dim, version }, entries }`. `loadCache` invalidates on (a) missing meta (legacy flat-object), (b) embedder_dim mismatch, (c) embedder_name mismatch even at same dim. Logs a one-line info on invalidation. Test `embeddings-cache-dim.test.ts` covers all three cases. `dim-check.ts:74-117` also reports the same mismatch through `plur doctor` for the JSON-cache path (B-3). New `rebuildJsonCache` (`embeddings.ts:412-443`) gives non-PGLite users a real migration path via `plur sync --reembed`. Test `reembed-json-cache.test.ts` confirms the path. |
| F-DATA-004 Test B adversarial | **PARTIAL** | `yaml-truth-traceability.test.ts:170-227` adds an adversarial describe block. The test calls `adapter.upsertEmbedding(syntheticId, ...)` to insert ONLY into `engram_embeddings`, then asserts that `getById`, `list`, `recall`, `recallHybrid`, `recallSemantic` don't return the synthetic ID. The first four trivially pass (they read YAML). `recallHybrid`/`recallSemantic` rely on `_pgliteHybridRecall`/`_pgliteSemanticRecall` to intersect vector hits with the YAML-rooted `filtered` set (`index.ts:1228-1234, 1267-1270`) — that intersect IS the new defense and the test does exercise it. **However**: the underlying `searchVector` query (`storage-pglite.ts:378-386`) does `JOIN engrams e ON e.id = em.engram_id`, so a synthetic row that only exists in `engram_embeddings` (no matching `engrams` row) will NEVER be returned by `searchVector` in the first place. The test thus exercises the JOIN filter, not the application-level intersect defense. To genuinely probe the "DB-only insert never surfaces" invariant, the test needs to insert the synthetic row into BOTH `engrams` AND `engram_embeddings` (bypassing YAML), then assert the intersect drops it. The test author acknowledged the limitation inline ("The adapter doesn't expose db; instead we leverage..."). The test now does something, but not the thing the comment claims. |

## Edge case matrix re-run

| Operation | Edge case | Iter-2 status | File:line |
|---|---|---|---|
| Plur.sync | empty store | YES handled — `reembedAll` returns `{ reembedded: 0, skipped: true, reason: 'yaml not present' }` | `storage-pglite.ts:537-539` |
| Plur.sync | reembed with same dim | YES — `reembedAll` without `full` upserts in place; with `full` swaps atomically | `storage-pglite.ts:548-555, 567-639` |
| Plur.sync | reembed with same dim AND --full | YES — atomic build-new-then-swap, dim unchanged | `storage-pglite.ts:567-639` |
| Plur.sync | reembed mid-process: embedder throws | **YES — closed.** Scratch table dropped, live untouched | `storage-pglite.ts:623-626` |
| Plur.sync | reembed with embedder unavailable up front | YES — `{ skipped: true, reason: 'no embedder supplied' }` | `storage-pglite.ts:526-528` |
| Plur.sync | concurrent learn during sync | **MOSTLY YES — closed.** `_autoEmbedNewEngrams` post-syncFromYaml fills the gap; narrow snapshot-staleness window remains (see F-DATA-002 above) | `index.ts:2036-2108`, `storage-pglite.ts:540-555` |
| Plur.sync | PLUR_BACKEND=sqlite, reembed=true | **YES — now works** via `rebuildJsonCache` in `embeddings.ts:412`. Returns count instead of silent no-op | `index.ts:2303-2312` |
| PGLiteAdapter constructor | first cold start, no DB | YES — `getDb()` lazily creates dir + schema. (Note: doctor-dim-check path occasionally races on parallel tests, see "test infra" finding below) | `storage-pglite.ts:127-148` |
| PGLiteAdapter constructor | PGLite WASM unavailable | PARTIAL (unchanged from iter-1) — error caught, logged, no health flag exposed | `index.ts:217-219` (F-DATA-012 carries over) |
| PGLiteAdapter syncFromYaml | duplicate IDs in YAML | YES — `ON CONFLICT (id) DO UPDATE` last-write-wins | `storage-pglite.ts:332-353` |
| PGLiteAdapter syncFromYaml | empty YAML file | YES — `DELETE WHERE source='primary'` branch handles 0-id case | `storage-pglite.ts:295-315` |
| PGLiteAdapter syncFromYaml | YAML deleted between calls | YES — `existsSync` guard | `storage-pglite.ts:296` |
| PGLiteAdapter searchVector | empty embedding table | YES — short-circuit to `[]` | `storage-pglite.ts:373-374` |
| PGLiteAdapter searchVector | query dim != column dim (pgvector path) | PARTIAL — Plur-level callers wrap in try/catch + fallback (`index.ts:1236-1239, 1271-1275, 1326-1329`); raw adapter still throws. F-DATA-009 partially addressed for the wired callers but not at the adapter surface. | `storage-pglite.ts:371-391` |
| PGLiteAdapter searchVector | NaN/Inf in query | **YES — closed.** `vectorLiteral` throws on non-finite (was silent-substitute-0) | `storage-pglite.ts:655-673` (F-DATA-008 closed) |
| PGLiteAdapter upsertEmbedding | NaN/Inf in vector | **YES — closed.** Same `vectorLiteral` throw path | `storage-pglite.ts:407-428, 655-673` (F-DATA-008 closed) |
| Embedder factory | unknown name (getEmbedder) | YES — throws "Unknown embedder" (unchanged) | `embedders/index.ts` |
| Embedder factory | unknown name (resolveEmbedderName) | YES — warns once, falls back to default (unchanged) | `embedders/index.ts` |
| Embedder factory | OPENAI_API_KEY missing | YES — throws on first `embed()` call (unchanged) | `embedders/openai.ts` |
| Benchmark run | --iterations 0 | PARTIAL (unchanged from iter-1) — generic "No scenarios" error | `benchmark/run.ts:283-285` (F-DATA-005 carries over) |
| Benchmark run | --iterations > scenarios available | PARTIAL (unchanged from iter-1) — inflated `scenario_count` | `benchmark/run.ts:158-164, 296-318` (F-DATA-006 carries over) |
| YAML-truth Test B | adversarial DB-only insert | **PARTIAL** — test exists and runs but doesn't probe the actual claimed scenario (see F-DATA-004 above) | `yaml-truth-traceability.test.ts:170-227` |

## New edge cases probed

- **Legacy flat-array `.embeddings-cache.json` invalidation**: covered.
  `loadCache` at `embeddings.ts:233-237` detects the missing `meta`
  field, logs an info line, returns `emptyCache(active)`. Test
  `embeddings-cache-dim.test.ts:141-163` writes a legacy-format file,
  runs `embeddingSearch`, asserts the rewritten file has `meta` and the
  new entry's embedding length matches the active embedder's dim.
  `dim-check.ts:81-92` also surfaces the legacy format as a hard
  mismatch in `plur doctor` output. Tested by
  `doctor-json-cache-mismatch.test.ts:88-103`.

- **Auto-embed when PGLite is unavailable mid-learn**: YAML still
  succeeds. `index.ts:498` writes YAML synchronously, THEN line 499
  fires `_syncIndex()` which goes async. `_syncIndex` at line 2044-2048
  wraps the entire chain in `.catch()` that logs a warning but doesn't
  propagate. So a PGLite WASM crash mid-learn writes YAML successfully
  and just leaves the index stale until the next sync. Confirmed by
  reading the call site; no dedicated test for the crash case but the
  YAML-as-truth tests passively assert this invariant.

- **Atomic reembed mid-swap crash recovery**: the swap is
  `BEGIN; DROP TABLE IF EXISTS engram_embeddings; ALTER ...; COMMIT;`
  inside a single `db.exec` call. If the process crashes between BEGIN
  and COMMIT, the transaction rolls back — both `engram_embeddings`
  (live, old) and `engram_embeddings_new` (scratch, populated) remain.
  On next reembed start, line 577 `DROP TABLE IF EXISTS
  engram_embeddings_new` cleans up the orphan. If the crash happens
  AFTER scratch populate but BEFORE the BEGIN, the scratch is orphaned
  until the next reembed cleans it. **Recovery is automatic but
  undocumented and would benefit from a startup-time orphan-table sweep
  in `initSchema`** — currently the orphan is only swept on the NEXT
  reembed call, which could be never.

- **Concurrent `_autoEmbedNewEngrams` + `_reembedFullAtomic`**: the
  reembed snapshots YAML at line 540 BEFORE entering the mutex. If a
  learn writes YAML during the populate phase, the new engram lands in
  `engrams` table via syncFromYaml but is NOT in the snapshot, so the
  scratch table is built without it. The post-learn
  `_autoEmbedNewEngrams` queues behind the mutex, runs after the swap,
  and embeds the missing engram into the new table at the new dim. Net
  effect: one-tick window where a relational row has no vector.
  Acceptable but worth documenting.

- **`vectorLiteral` non-finite throw**: confirmed in
  `pglite-vector-literal.test.ts` (passes in isolation; flakes under
  parallel-suite load). Behaviour is the documented one — throws
  immediately on NaN/Infinity, with index + value in the message.

- **Same-dim embedder family change** (e.g. minilm 384 → bge-small
  384): cache invalidation now correctly fires on `embedder_name`
  mismatch even when dims match. Tested by
  `embeddings-cache-dim.test.ts:119-139` and
  `doctor-json-cache-mismatch.test.ts:69-86`.

## New findings

- **[F-DATA-NEW-001] Adversarial Test B doesn't probe the claimed
  failure mode.** The test inserts into `engram_embeddings` only, but
  `searchVector` uses `JOIN engrams ON e.id = em.engram_id` which
  silently drops any row without a matching `engrams` entry. So the
  intersect-with-filtered defense at the application layer is never
  actually exercised — the SQL JOIN already filters the synthetic out
  before the application sees it. To genuinely test the invariant,
  insert into BOTH tables (bypass YAML for both). Either expose a
  test-only `_rawInsertEngram(id, statement)` helper on the adapter,
  or use a raw `db.query` via reflection. The test currently
  documents the architectural intent but does not verify it.
  File: `packages/core/test/yaml-truth-traceability.test.ts:185-226`.
  Severity: MAJOR — this was the iter-1 F-DATA-004 fix request and the
  fix is incomplete.

- **[F-DATA-NEW-002] Reembed snapshot is captured outside the mutex.**
  `storage-pglite.ts:540` loads YAML before entering the mutex at line
  575. A learn that writes YAML between these two steps will be invisible
  to the reembed's scratch table even though the syncFromYaml from that
  learn will see the updated YAML and insert the relational row. The
  follow-up `_autoEmbedNewEngrams` does heal the gap on the next tick,
  but a cleaner design would snapshot YAML INSIDE the mutex (right after
  acquisition) so the reembed sees a consistent point-in-time view that
  includes any concurrently-completed learns. Severity: MINOR — auto-heals,
  but the iter-1 claim that F-DATA-002 is fully closed is overstated.
  File: `packages/core/src/storage-pglite.ts:540, 575`.

- **[F-DATA-NEW-003] Orphan `engram_embeddings_new` not swept at
  startup.** If the process crashes after scratch populate but before
  the BEGIN-commit swap, the orphan persists until the NEXT reembed
  call drops it (line 577). For a user who doesn't run another reembed
  for weeks, the orphan occupies disk space silently and there's no
  doctor warning. Trivial fix: add
  `DROP TABLE IF EXISTS engram_embeddings_new` to `initSchema`.
  Severity: NIT.
  File: `packages/core/src/storage-pglite.ts:150-217`.

- **[F-DATA-NEW-004] `recreateVectorColumn` is now dead code.** Iter-2
  M-6 introduced the atomic build-new-then-swap path. The legacy
  `recreateVectorColumn` method at `storage-pglite.ts:482-503` is no
  longer called from production code (verified by grep). It still
  exists as a public method on the adapter. Either remove or document
  as "test/debug only — production uses `_reembedFullAtomic`."
  Severity: NIT.

- **[F-DATA-NEW-005] Full-suite test concurrency triggers PGLite WASM
  init failures.** Running `pnpm --filter @plur-ai/core test` produces
  16 failures across 9 files with errors like
  `mkdir ENOENT: ... store.pglite` and
  `PGlite failed to initialize properly`. Each individual failing test
  passes when run in isolation (verified: `yaml-truth-traceability`,
  `pglite-reembed-atomic`, `embeddings-cache-dim`,
  `reembed-json-cache`, `doctor-json-cache-mismatch`,
  `pglite-recall-wiring` all green individually). The vitest config
  uses `pool: 'forks'` which gives each test file its own process, but
  PGLite WASM startup appears to race when many forks instantiate
  fresh PGLite instances simultaneously. This is NOT a runtime bug
  (production never spawns multiple PGLite instances per machine like
  this), but it blocks the CI gate. Suggested fixes: serialize PGLite
  test files via `pool: { singleFork: true }` for those files, OR add
  retry logic to `getDb()` for the ENOENT mkdir race, OR pin the
  parallel-fork count via `poolOptions.forks.maxForks: 4`.
  Severity: MAJOR (blocks CI), but not a runtime bug.
  Files: `packages/core/vitest.config.ts`, `packages/core/src/storage-pglite.ts:127-148`.

- **[F-DATA-NEW-006] `_autoEmbedNewEngrams` doesn't update the
  `.embeddings-cache.json`.** When PGLite is active, auto-embed
  upserts vectors into PGLite only. The legacy JSON cache is not
  touched. If a code path falls back to `embeddingSearch` (e.g.
  PGLite searchVector throws on dim mismatch, `index.ts:1238`), it
  reads from the JSON cache which is missing the new engram — and
  will re-embed it inline. Not a correctness bug, but it means
  PGLite-active users build two redundant indexes over time (PGLite
  vectors AND JSON cache). Worth documenting or unifying.
  Severity: NIT.
  File: `packages/core/src/index.ts:2063-2108`.

## Closing assessment

Iter-2 makes meaningful, audit-driven progress on every iter-1 major.
The atomic-swap reembed and cache-stamping fixes are exactly right —
clean implementations with focused tests. The auto-embed wiring closes
the long-standing "PGLite is a dark path for reads" critique from
iter-1 (F-CTO-001 + F-DATA-002 spirit).

The two real concerns blocking a clean SHIP verdict:

1. **F-DATA-NEW-005 (test infra)**: 16 test failures under full-suite
   concurrency. All flakes pass individually, but the CI gate fails as-is.
   This is the single most concrete blocker. Mitigation is straightforward
   (serialize PGLite test files or cap forks).

2. **F-DATA-NEW-001 (Test B not adversarial enough)**: the iter-2 fix
   for F-DATA-004 added a describe block but the assertion is
   structurally trivial (JOIN filter, not application intersect). The
   architectural intent is correct; the test artifact is mislabeled.
   Either rewrite the test to insert into both `engrams` and
   `engram_embeddings`, or downgrade the comment from "exercises the
   wired PGLite path (B-1) and proves the intersect-with-filtered
   defense" to "documents the architectural intent."

Everything else (F-DATA-NEW-002/003/004/006) is minor cleanup that can
be deferred to Wave 1. The substrate is materially stronger than iter-1
— ship after the two blockers above are addressed.
