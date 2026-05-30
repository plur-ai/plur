# Sprint 0 Audit — Iter 3 — Critic verification

Branch: `epic/sprint-0-substrate` @ `fbfa870` (PR #274 merged).
Reviewer: evaluator-critic (read-only). Comparing iter-2 against my iter-1 BLOCK verdict.

## Verdict

**SHIP_WITH_FIXES**

The three damaging structural issues that drove my iter-1 BLOCK are closed. The "tests that look like tests but aren't" list is mostly fixed — the marquee yaml-truth invariants now actually run against the marquee substrate, and a new adversarial Test B proves the synthetic-engram defence works on the PGLite path. The default flip is reverted, the cache is stamped, and the migration command works for non-PGLite users. The substrate is no longer decoration.

What remains is a small set of follow-on issues — most already filed (M-8 through M-12), a couple of weak-test holdovers from iter-1 that didn't get a sharper assertion, and two subtle new-in-iter-2 implementation gaps that I would file as MAJORs rather than block on. None of them re-create the "silent recall regression" failure mode that motivated the iter-1 BLOCK.

## Iter-1 BLOCK rationale: are the 3 damaging concerns actually closed?

### 1. PGLite write-only ghost

- **Status**: CLOSED
- **Evidence**:
  - `packages/core/src/index.ts:1160-1167` — `recallSemantic` routes to `_pgliteSemanticRecall` when `this.pgliteAdapter` is set.
  - `packages/core/src/index.ts:1189-1196` — `recallHybrid`/`recallHybridWithMeta` routes to `_pgliteHybridRecall`.
  - `packages/core/src/index.ts:1311-1330` — `similaritySearch` routes through `pgliteAdapter.searchVector`.
  - `packages/core/src/index.ts:1209-1240` — `_pgliteSemanticRecall` actually calls `pgliteAdapter.searchVector(queryVec, ...)` then intersects with the YAML-rooted `filtered` set (preserves the invariant).
  - `packages/core/src/index.ts:1248-1290` — `_pgliteHybridRecall` runs BM25 over filtered + pgvector via `searchVector` + RRF merge.
  - `packages/core/src/index.ts:2036-2054` — `_syncIndex` now chains `syncFromYaml` → `_autoEmbedNewEngrams` so every `learn()` auto-upserts the embedding into PGLite.
  - `packages/core/src/index.ts:2063-2108` — `_autoEmbedNewEngrams` walks active engrams missing from `engram_embeddings`, computes the canonical search text via `engramSearchText`, and calls `pgliteAdapter.upsertEmbedding`. Same canonical text the recall path uses, so vectors are comparable.
  - `packages/core/test/pglite-recall-wiring.test.ts:44-100` — three integration tests that actually exercise the PGLite path through `learn()` and assert `countEmbeddings() ≥ 1` and that `recallHybrid` returns the learned engrams.

The substrate is now consumed by the public API. RC-1 closed.

### 2. Default users have no safe migration

- **Status**: CLOSED
- **Evidence**:
  - `packages/core/src/embedders/index.ts:66` — `DEFAULT_EMBEDDER: EmbedderName = 'bge-small'` (reverted from `embedding-gemma`). Block comment at lines 54-65 explicitly cites the iter-1 audit B-2 deferral.
  - `packages/core/src/embeddings.ts:199-220` — `EmbeddingCache` is now `{ meta: { embedder_name, embedder_dim, version }, entries: {...} }`.
  - `packages/core/src/embeddings.ts:229-248` — `loadCache` invalidates on legacy format (no `meta`) AND on `embedder_name`/`embedder_dim` mismatch. Logs an info-level reason on each invalidation so users see why the first recall takes longer.
  - `packages/core/src/embeddings.ts:412-443` — new `rebuildJsonCache(engrams, storagePath, {full})` walks YAML and rebuilds entries against the active embedder.
  - `packages/core/src/index.ts:2275-2289` — `sync({reembed:true})` calls `rebuildJsonCache` on the non-PGLite path (was previously a `skipped: true` no-op).
  - `packages/core/src/index.ts:2303-2312` — `reembedAsync` does the same for the awaitable path.
  - `packages/core/src/embedders/dim-check.ts:74-117` — `checkEmbedderDimMismatch` now reads the JSON cache header, returns a JSON-cache-specific warning with the right `plur sync --reembed --full` command. Legacy flat-object cache returns a hard mismatch.
  - `packages/cli/src/commands/doctor.ts:388-402` — doctor passes `jsonCachePath` + `activeEmbedderName` so the warning fires for non-PGLite installs.
  - `packages/core/test/embeddings-cache-dim.test.ts` — four tests covering: header writes, dim-mismatch invalidation, same-dim-different-name invalidation, legacy-format invalidation.

The silent-poison failure mode from iter-1 concrete scenario 1 is closed: the cosine over `min(384, 768)` cannot fire because the cache invalidates first.

### 3. Bake-off doesn't justify default flip

- **Status**: CLOSED (as "decision deferred to Phase C with explicit acknowledgement")
- **Evidence**:
  - `docs/benchmarks/embedder-bake-off-2026-05.md:7-20` — "TL;DR (iter-2 audit revision)" section now explicitly states the default flip was reverted, BGE-small remains v0.10 default, and the bake-off methodology cannot support the swap at N=5/category.
  - `docs/benchmarks/embedder-bake-off-2026-05.md:130-141` — "Decision" rewritten to: deferred pending Phase C.
  - `docs/benchmarks/embedder-bake-off-2026-05.md:150-161` — new "Phase C — deferred" section spells out the methodology fix: import real LongMemEval-S OR run 100 reps of the 30-scenario fixture with explicit framing.
  - `CHANGELOG.md:7-11` — "Default embedder stays `bge-small` (iter-2 audit B-2)" section with rationale.
  - `CHANGELOG.md:247` — README/CHANGELOG text restored to `~130MB BGE` (matches the actual default again, not the misleading 325MB Gemma text).

RC-2 closed.

## "Tests that look like tests but aren't" — were they fixed?

| Test from iter-1 | Fixed? | Evidence |
|---|---|---|
| yaml-truth tests don't set `PLUR_BACKEND=pglite` | **YES** | `packages/core/test/yaml-truth-rebuild.test.ts:47-57` — `BACKENDS: Array<'sqlite' \| 'pglite'>` loop wraps the entire `describe` block; beforeEach sets `process.env.PLUR_BACKEND = backend`. Same pattern at `yaml-truth-traceability.test.ts:39-49`. Both backends now policed. |
| Adversarial Test B missing (M-2) | **YES** | `packages/core/test/yaml-truth-traceability.test.ts:170-227` — new describe block `yaml-as-truth Test B — adversarial direct PGLite insert (iter-2 audit M-2)`. Opens a second `PGLiteAdapter` on the same dbPath, calls `upsertEmbedding('ENG-9999-9999-001', new Float32Array(384).fill(0.5))` bypassing YAML, then asserts `getById`, `list`, `recall`, `recallHybrid`, `recallSemantic` all reject the synthetic id. This exercises the intersect-with-filtered defence I called for. |
| `pglite-adapter.test.ts:386-426` integration suite bypasses PGLite | **PARTIAL** | The original suite is unchanged — `plur.recall('first')` still uses sync BM25, which is the documented semantics (`recall` = BM25; `recallHybrid` = PGLite-routed). However the **new** `pglite-recall-wiring.test.ts` (90 lines, 4 tests) actually exercises `recallHybrid` and `recallSemantic` under `PLUR_BACKEND=pglite` and asserts (a) `countEmbeddings() ≥ 1` after `learn()`, (b) `recallHybrid` returns the seeded ids. Coverage gap closed via a new file rather than fixing the old one. |
| `reembed-migration.test.ts:236-257` never calls `recallHybrid` | **NO** | The test in question still asserts only `result.reembedded === 2` and that `list()` returns the same IDs. Never calls `recallHybrid` to verify the rebuilt embeddings actually produce sensible search. The migration could still finish with all-zero vectors and this test would pass. Mitigated by `pglite-reembed-atomic.test.ts:131-151` which uses a `failingEmbedder` to prove the live table is untouched on failure — but that doesn't replace a positive recall-quality check on success. |
| `benchmark/run.test.ts:156-175` runs in BM25 mode | **NO** | `benchmark/run.test.ts:190-209` still uses `searchMode: 'bm25'`. The new assertion `expect(j.embedder_stub_fallback).toBe(false)` is trivially true: `benchmark/run.ts:264` hard-codes `const embedderStubFallback = false`. The pre-warm `try { await adapter.embed('warmup') } catch { /*swallow*/ }` at `run.ts:265-276` makes the load attempt observable in stdout when not quiet, but the test runs with `quiet: true` and asserts on the wrong field. F-CRIT-012 unchanged. |
| `embedder-pglite-dim.test.ts:42-62` doesn't check `getVectorColumnDim()` | **NO** | Tests at `packages/core/test/embedder-pglite-dim.test.ts:43-64` still verify only that `upsertEmbedding` doesn't throw on a sized vector. On a CI runner without pgvector (BYTEA fallback) the column accepts any-dim blob and these tests pass. F-CRIT-011 unchanged. |
| `embedder-default.test.ts:72-76` is a one-line happy path | **PARTIAL** | Tests for resolver coverage have grown (`embedder-pglite-dim.test.ts:67-107` covers default, unknown-name fallback, known-name routing, dim agreement). OpenAI adapter still lacks 429/5xx/timeout/8191-token tests — filed as M-9 (#269). |

Net: yaml-truth invariant tests are now real. The adversarial Test B is the one I most wanted, and it's there with the strongest possible failure injection. The two unchanged weak tests (`run.test.ts`, `embedder-pglite-dim.test.ts`) are real holdovers but don't affect the production failure modes the iter-1 BLOCK was about.

## New findings (issues iter-2 introduced or left in place)

- **[F-CRIT-NEW-001] BYTEA-fallback dim guard is one-sided.** `packages/core/src/index.ts:2071-2078` skips `_autoEmbedNewEngrams` when `getVectorColumnDim()` returns a number that differs from the active embedder. But `getVectorColumnDim()` returns `null` on the BYTEA fallback (per `storage-pglite.ts:439`). On a CI runner or any environment where pgvector didn't load, the BYTEA path accepts any-dim blob via `float32ToBytes` (`storage-pglite.ts:419-424`) and the `cosine()` function at `storage-pglite.ts:689-700` iterates `min(a.length, b.length)` — silently returning meaningless scores if a user changes `PLUR_EMBEDDER` mid-process. Mitigation in practice: production installs almost always get pgvector via the WASM bundle, so this is an opt-in foot-gun rather than a default-user regression. Recommend: when `indexedDim === null`, peek the first existing embedding row's byte length and refuse to upsert if it doesn't match. MAJOR.

- **[F-CRIT-NEW-002] `_pgliteInitPromise` race after `sync({reembed})`.** `index.ts:2269-2274` assigns `this._pgliteInitPromise = adapter.reembedAll(...)`. If a `learn()` lands during the reembed, `_syncIndex` overwrites `_pgliteInitPromise` with a fresh `syncFromYaml().then(_autoEmbedNewEngrams)` chain — losing the awaitable handle to the in-flight reembed. `waitForIndex()` now waits on the syncFromYaml, not the reembed. The same issue I called out as F-CRIT-018 in iter-1 is structurally unchanged. Tests that rely on `waitForIndex` after `sync({reembed:true})` could observe a half-rebuilt index and pass. MAJOR.

- **[F-CRIT-NEW-003] `sync({reembed:true})` still swallows reembed errors.** `index.ts:2272-2274` catches the reembed failure with `logger.warning(...)` and returns the initial `SyncResult` synchronously. The CLI gets "Sync: ok" even when reembed failed. This was F-CRIT-006 in iter-1; filed as M-11 (#272) but not closed. Acceptable as a follow-on, but should be tracked.

- **[F-CRIT-NEW-004] Bake-off test mode unchanged.** `benchmark/run.test.ts:198` still uses `searchMode: 'bm25'`. The new `embedder_stub_fallback === false` assertion is hard-coded true. The test name still claims to "run the real adapter" but the assertion proves nothing about adapter load. Re-file F-CRIT-012 as a follow-on issue.

- **[F-CRIT-NEW-005] BYTEA path heterogeneous-dim safety unchanged.** `storage-pglite.ts:418-426` upserts BYTEA blobs of any length. `cosine()` at line 689 iterates `Math.min(a.length, b.length)`. Same silent-degradation risk as F-CRIT-010 from iter-1. Less likely to fire now because the auto-embed dim guard catches the most common case, but still present.

## Closing assessment

I'm switching from BLOCK to **SHIP_WITH_FIXES**.

Net delta: iter-2 closed every BLOCKER cleanly (B-1, B-2, B-3), seven of the eleven MAJORs from my iter-1 list (the surgical ones), and the substrate is no longer dead code. The three concrete failure scenarios that drove my BLOCK — silent recall regression on upgrade (closed by cache stamping), substrate doing nothing useful (closed by recall wiring + auto-embed), and bake-off justifying the default flip (closed by revert + Phase C deferral) — are all closed. Two new MAJORs land in their place (BYTEA dim guard, reembed promise race), neither of which re-creates a silent-correctness regression for the default user. The remaining unfixed iter-1 items (M-8 through M-12, the unchanged benchmark and pglite-dim tests) are follow-ons that should not block the epic→main merge.

The substrate now does what its name advertises.
