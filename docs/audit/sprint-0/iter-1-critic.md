# Sprint 0 Audit — Iter 1 — Critic

Branch: `epic/sprint-0-substrate` @ 626a960 vs `main`.
Reviewer: evaluator-critic. Read-only.

## Verdict

**BLOCK**

The epic looks clean on the diff but the marquee features are largely scaffolding without consumers. PR 2's PGLite adapter is never read by the engine (only written to). PR 5's default-flip to EmbeddingGemma silently breaks recall for the 99% of users who don't run PGLite, with no migration path, no warning, and a benchmark sample size too small to justify the swap. The "YAML-as-truth" invariant test (PR 1) doesn't actually run against the new substrate (PR 2). The bake-off (PR 4) made the default-flip decision on 30 questions (5 per category) and the data inside it does not justify the conclusion.

## Summary

Three damaging concerns:

1. **PGLite is a write-only ghost** (BLOCKER). The PGLite adapter is mirrored from YAML on every write but is **never queried by any public read method**. `recall`, `recallHybrid`, `recallSemantic`, `list`, `getById` all bypass the adapter entirely (see `_filterEngrams` lines 1224-1262: the PGLite branch falls through to `_loadAllEngrams` (YAML). `learn()` never calls `pgliteAdapter.upsertEmbedding()`. So the substrate gets disk, CPU, and a 2-3MB WASM bundle in `dependencies` for zero benefit. Users who opt in to `PLUR_BACKEND=pglite` get a worse experience (extra IO on every write) with no read-path improvement.

2. **Default users have no migration when switching embedders** (BLOCKER). The new default `embedding-gemma` (768d) replaces `bge-small` (384d) for everyone, but `.embeddings-cache.json` is keyed only by `engramId + statementHash` — **not by embedder**. After upgrade, every cache hit returns a 384d Float32Array; the new 768d query computes cosine over `min(384, 768) = 384` indices and silently mis-scores. `plur sync --reembed` only works under `PLUR_BACKEND=pglite` (lines 2067-2069 of `index.ts`: "reembed requires PLUR_BACKEND=pglite"). `plur doctor`'s dim-mismatch warning only checks PGLite. Existing v0.9.12 users get silent recall degradation with no signal and no remediation.

3. **Bake-off does not justify the default-flip** (BLOCKER). The bake-off is N=5/category (30 questions total). Headline:
   - MiniLM: R@5 80.0%, R@1 **50.0%**, Acc 80%, p50 18ms, 585MB RSS, 97MB disk
   - bge-small: R@5 80.0%, R@1 46.7%, Acc 80%, p50 19ms, 689MB RSS, 128MB disk
   - **embedding-gemma: R@5 80.0%, R@1 43.3%**, Acc 83.3%, p50 72ms, 1684MB RSS, 325MB disk

   The plan's spec (sprint-0-plan.md:95-96) explicitly said: "confirm EmbeddingGemma as the new default **unless another candidate beats it by ≥2pp R@5 at or below its CPU cost**." MiniLM matches R@5, **beats it by 6.7pp on R@1**, at 1/4 the latency and 1/3 the RAM. The defining acceptance metric is R@1 (right answer at top), where EmbeddingGemma is the **worst** of the three local candidates. The decision is justified on "Accuracy" (+3.3pp on 30 questions = 1 query difference). The plan's exit criterion #4 — "LongMemEval R@5 ≥ 95% local" — is not met (80%) and there is no plan for how the planned "Phase C N=500" run will produce real signal given the underlying scenarios.yaml only contains 30 scenarios and `sampleScenarios` will sample with replacement.

## Findings

### BLOCKER

- **[F-CRIT-001] PGLite is mirrored-on-write but never read.** `_filterEngrams` (packages/core/src/index.ts:1224-1262) reads only from `indexedStorage` (SQLite) or YAML. PGLite has no read path. `recallHybrid` (line 1151) routes to `hybridSearch` which uses the `embeddings.ts` JSON cache, not PGLite's vector column. `learn()` writes YAML and calls `_syncIndex` which fires `syncFromYaml` on the PGLite adapter, but the adapter's `searchVector` is never invoked from a user-facing API. Verdict: the entire PGLite layer is dead code from the consumer's perspective. Either wire it into `recallHybrid`/`recallSemantic` or pull it out before shipping.

- **[F-CRIT-002] Embeddings cache poisons silently across embedder switches.** `packages/core/src/embeddings.ts:200-243`. The cache schema is `{ [engramId]: { hash, embedding } }`. The embedder identity is not part of the key. Switching `PLUR_EMBEDDER=bge-small` → `embedding-gemma`:
  - Query vector is 768d.
  - Cached engram vector is the old 384d Float32Array (deserialized from the JSON `embedding: number[]`).
  - `cosineSimilarity(a, b)` iterates `a.length` (768) reading `b[i]` for `i >= 384`: Float32Array returns 0 for out-of-bounds, so dot product is computed over only the first 384 indices and the cached vector dominates with random alignment.
  - Result: silently wrong recall scores. No throw, no warning, no fix path for the default backend.

- **[F-CRIT-003] No reembed migration exists for the default (no-PGLite) install path.** `Plur.reembedAsync` (packages/core/src/index.ts:2066-2072) immediately returns `{ skipped: true, reason: 'reembed requires PLUR_BACKEND=pglite' }` if no PGLite. The new default embedder is 768d. Existing v0.9.12 users on SQLite/YAML — the documented default — have no way to invalidate `.embeddings-cache.json`. `plur sync --reembed` is a silent no-op. They need to manually `rm ~/.plur/.embeddings-cache.json`, but nothing tells them.

- **[F-CRIT-004] `plur doctor` dim-mismatch warning is PGLite-only.** `packages/core/src/embedders/dim-check.ts:38`: returns null when no PGLite store exists. The default install has no PGLite store, so the warning never fires. The README and CHANGELOG both pitch "`plur doctor` surfaces the dim mismatch" as the user-facing signal that drives the migration command — but the warning is gated to a backend the vast majority of users don't use.

- **[F-CRIT-005] Bake-off does not meet its own spec gate.** PR 4 spec (plan line 95-96): "confirm EmbeddingGemma as the new default unless another candidate beats it by ≥2pp R@5 at or below its CPU cost." All three local candidates tie at R@5=80% on N=30. MiniLM is at less than half the CPU cost (18ms p50 vs 72ms) and beats EmbeddingGemma by 6.7pp R@1 (50% vs 43.3%) — which is the more rigorous metric for "did you find the right thing at top?". The gate "≥2pp R@5 at or below its CPU cost" cuts BOTH ways but is interpreted only one way. EmbeddingGemma should not be default until either (a) the rule is rewritten and stated, or (b) a real run (true N, not sample-with-replacement) shows a real R@1 win.

- **[F-CRIT-006] `Plur.sync({reembed: true})` swallows errors and returns a stale `SyncResult`.** packages/core/src/index.ts:2045-2057: kicks off `adapter.reembedAll` in the background, catches errors with `logger.warning`, and the function returns the initial git `SyncResult` synchronously. The CLI awaits `waitForIndex()` but if the reembed failed the user gets "Sync: ..." with no indication. The MCP handler (packages/mcp/src/tools.ts:751) returns `{...result, ...(reembed ? {reembed: true, full} : {})}` — no failure surface. Migration can fail silently for hundreds of thousands of engrams with the user seeing success.

- **[F-CRIT-007] `reembedAll` has no progress, no atomicity, no batching.** packages/core/src/storage-pglite.ts:520-528:
  ```ts
  const engrams = loadEngrams(this.yamlPath)
  let count = 0
  for (const e of engrams) {
    const vec = await embedder.embed(e.statement)
    await this.upsertEmbedding(e.id, vec)
    count++
  }
  ```
  Each upsert acquires the adapter's mutex separately. For 100k engrams that's 100k separate transactions. If the process dies mid-loop (or the OpenAI API rate-limits), the user is left with a partially-rebuilt embedding column and zero indication. With `--full` the column was dropped first, so failure = no embeddings, hybrid recall returns nothing, silent.

- **[F-CRIT-008] OpenAI adapter has no retry, no timeout, no token limit check.** packages/core/src/embedders/openai.ts:38-75. Single `fetch` POST with no AbortSignal timeout. No 429 backoff. No 5xx retry. `text-embedding-3-large` has an 8191-token input limit; an oversize engram statement returns HTTP 400 mid-migration and aborts the whole reembed. No per-request batching for `embed(text)` — every recall query is a fresh round-trip. For a 10k-engram migration with one 8200-token statement, the migration dies and leaves the embedding column half-populated.

- **[F-CRIT-009] yaml-as-truth invariant tests don't run against PGLite.** packages/core/test/yaml-truth-rebuild.test.ts and yaml-truth-traceability.test.ts construct `new Plur({ path: dir })` with no `PLUR_BACKEND=pglite`. `nukeDerivedState` deletes `store.pglite/` paths that were never created. The test confirms YAML is the source of truth for the legacy SQLite/in-memory path — exactly the path PR 1 was supposed to defend against being weakened by PR 2. The "policed against the invariant from day one" promise in the plan is empty: PR 2's PGLite write path has no invariant test in front of it. (Verdict aligned with the broader F-CRIT-001 observation: there's no PGLite read path to test against the invariant anyway.)

### MAJOR

- **[F-CRIT-010] PGLite BYTEA fallback stores variable-length vectors without validation.** packages/core/src/storage-pglite.ts:412-419 (BYTEA upsert) and bytesToFloat32 (lines 560-568): no length check on insert; `cosine()` (lines 570-582) iterates `min(a.length, b.length)`. So if anyone calls `upsertEmbedding` with a 384d vector then later with a 768d vector for a different engram (different embedder, or a partial migration), the table contains heterogeneous-dim rows and `searchVector` silently returns scores computed over only the first 384 elements of the 768d query. There is no integrity invariant on the embedding column when pgvector is unavailable. Since CI environments typically lack pgvector, this is the path exercised by tests.

- **[F-CRIT-011] PGLite embedder-dim wiring test never checks the column.** packages/core/test/embedder-pglite-dim.test.ts:42-62. The tests construct `new PGLiteAdapter(..., {vectorDim: 768})` and `upsertEmbedding` a 768d vector. They pass even if pgvector failed to load and the column is `BYTEA NOT NULL` (which accepts any blob). `getVectorColumnDim` is never called — the test verifies "the upsert didn't throw" rather than "the column is vector(768)." A regression that ships `vector(384)` schema with a 768d default embedder would still pass these tests.

- **[F-CRIT-012] Bake-off "ran the real adapter" test runs in BM25 mode.** benchmark/run.test.ts:156-175. The test says it validates the EmbeddingGemma adapter is wired in, but uses `searchMode: 'bm25'` — which never calls the embedder. The test passes whether or not the embedding pipeline can load. The only check is that `j.embedder === 'embedding-gemma'` (the string passed in is the string echoed back).

- **[F-CRIT-013] `plur doctor` still tells users about BGE-small.** packages/cli/src/commands/doctor.ts:577: `"BGE-small-en-v1.5 download (~130MB)"` — stale text after the default flipped to EmbeddingGemma. New users see the wrong model name and the wrong size (325MB, not 130MB). Doctor advice is wrong on day one.

- **[F-CRIT-014] StorageAdapter interface is half-done.** packages/core/src/storage-adapter.ts declares an async interface, but only `PGLiteAdapter` implements it. `IndexedStorage` is sync and does not declare `implements StorageAdapter`. The codebase has `indexedStorage: IndexedStorage | null` and `pgliteAdapter: PGLiteAdapter | null` as parallel fields rather than a unified `adapter: StorageAdapter`. The "pluggable backend" refactor in PR 2 didn't actually plug; it added a second backend alongside the first with no shared dispatch.

- **[F-CRIT-015] `learn()` writes YAML, then fires syncFromYaml on PGLite as fire-and-forget without backpressure.** `_syncIndex` (index.ts:1877-1890): `this._pgliteInitPromise = this.pgliteAdapter.syncFromYaml().catch(...)`. Concurrent `learn` calls each replace `this._pgliteInitPromise` with the latest promise. The previous in-flight sync's success/failure is no longer awaitable by `waitForIndex`. Failures are logged but never bubble. If a YAML write produces a malformed engram that throws during PGLite sync, the YAML wins but the index is permanently stale (until next `plur sync --full`). Worse, in a hot write loop, `syncFromYaml` is called once per learn — each one scans the full YAML and runs `INSERT...ON CONFLICT...` for every engram — quadratic on hot paths.

- **[F-CRIT-016] N=500 "full LongMemEval" is fake.** benchmark/data/scenarios.yaml has 30 scenarios (5 per category). `sampleScenarios` (benchmark/run.ts:141-167) samples WITH REPLACEMENT when N > pool size. Requesting `--iterations 500` resamples the same 5 scenarios 100x each per category. The spec's "Phase C: 500 questions per category" is impossible with the current fixture. The ingest loop deduplicates by scenario ID (lines 297-302), so 500x replacement gives identical recall quality results to N=5. The plan's exit criterion of "LongMemEval-S full run" cannot actually be performed.

- **[F-CRIT-017] Pooling for EmbeddingGemma may not match the published numbers.** packages/core/src/embedders/embedding-gemma.ts:33: `pooling: 'mean'`. The adapter's own docstring (lines 10-12) notes: "Pooling for EmbeddingGemma is the 'last token' / mean of the prompt+content tokens; we use mean here". EmbeddingGemma was trained with task-specific prompts ("query: ...", "passage: ...") and last-token pooling on the appended `<|im_end|>` token. Using `mean` over the entire sequence with no prompt prefix produces vectors that are NOT comparable to the published MTEB scores cited in the bake-off rationale. The "matches BGE-small" claim is suspect because the adapter is using EmbeddingGemma the wrong way.

- **[F-CRIT-018] `_pgliteInitPromise` race after `reembedAll`.** index.ts:2045-2057: `sync({reembed: true})` assigns `_pgliteInitPromise = adapter.reembedAll(...)`. If a `learn()` lands during the migration, `_syncIndex` will overwrite `_pgliteInitPromise` with a `syncFromYaml`, hiding the reembed completion. `waitForIndex()` waits on the syncFromYaml, not the reembed. Test assertions like `await waitForIndex(); expect(reembedCount).toBe(N)` can return before the reembed finishes.

### MINOR

- **[F-CRIT-019] CHANGELOG over-claims test coverage as proof.** "Full suite: 1224 passed, 24 skipped." None of those 1224 tests run against PGLite-as-read-source (because there is no read source). The number is real but the implication that PGLite is exercised end-to-end is misleading.

- **[F-CRIT-020] First-run UX for EmbeddingGemma is undocumented.** Cold load: 325MB download. The `transformers-base.ts` `loadPipeline` produces no progress; the user sees their first `recallHybrid` call hang for 60-300 seconds with no output. The embedder probe in `plur doctor` has a 10s timeout (doctor.ts:298) which is shorter than the cold download on most laptop connections — `doctor` will report "embedder probe failed (signal SIGTERM)" on the first run for any user not on fiber. The plan's "first-run users incur a ~325 MB model download" promise is documented in the CHANGELOG and bake-off report — but the actual user sees a hang, then a doctor failure.

- **[F-CRIT-021] PGLite WASM is a hard dependency.** packages/core/package.json declares `@electric-sql/pglite` in `dependencies`, not `optionalDependencies`. Every install pulls the ~2-3MB WASM bundle whether or not PGLite is opted in. Reasonable, but worth noting for a substrate that is currently inert.

- **[F-CRIT-022] Cache file format conflates old and new vectors.** `.embeddings-cache.json` `embedding: number[]` is JSON-array-of-floats. With a 768d default, the file gets ~3x larger. No format versioning. A future change can't tell if it's reading a v1 (BGE-cached) or v2 (Gemma-cached) entry.

- **[F-CRIT-023] PGLite vector path is unreachable on common CI shapes.** PGLite's pgvector extension load is async-import gated; on the CI runners we observe in the diff (the tests timeout at 30s), pgvector typically falls through to BYTEA. The "vector(N)" column code path may have zero coverage in CI. `getVectorColumnDim` returns null on BYTEA and the dim-check skips. The whole "pgvector" capability is unverified.

- **[F-CRIT-024] Outbox / remote store dim mismatches.** Remote engram stores (`config.stores` with `url`) hold engrams whose embeddings are computed by the remote server. If the remote uses BGE and the local switches to Gemma, the local PGLite vector column dim (sized to local embedder) won't match remote embeddings even after a successful sync. Out of scope but unaddressed.

- **[F-CRIT-025] Cache path collision risk between scopes.** `embeddings.ts:200`: the cache lives at `<storagePath>/.embeddings-cache.json`. Same engram-id collision potential with the `_originalId` namespacing logic in `_loadAllEngrams` (multi-store ENG-NS-2026-...).

### NIT

- **[F-CRIT-026] Bake-off N=5 conclusions are presented as fact in the CHANGELOG.** The CHANGELOG (line 9) says "winning on Accuracy" — a +3.3pp delta on 30 questions is a single query swing.

- **[F-CRIT-027] OPENAI_3_LARGE adapter advertises 3072d but supports Matryoshka.** The adapter ignores the `dimensions` request param; users who'd benefit from 1024/512-dim Matryoshka truncation have no opt-in.

- **[F-CRIT-028] `IndexedStorage` ALTER TABLE swallows all errors.** storage-indexed.ts:55-59: every SQLite open runs `ALTER TABLE engrams ADD COLUMN source ...` inside `try/catch{}`. Real errors (corrupt DB, locked file) are silenced.

- **[F-CRIT-029] PGLite adapter close swallows errors silently.** storage-pglite.ts:530-540: comment says "occasionally throws on shutdown" but does not distinguish that case from a real corruption-on-close. Crash signals to subsequent open paths are lost.

- **[F-CRIT-030] Documentation drift in `plur doctor`.** doctor.ts:577 references "BGE-small-en-v1.5 (~130MB)" as the recommended embedder to trigger.

## Concrete Failure Scenarios

1. **Silent recall regression for default users upgrading 0.9.12 → 0.10**. User upgrades `@plur-ai/mcp`. New default embedder is EmbeddingGemma (768d). Their cache `.embeddings-cache.json` is populated from BGE-small (384d). First `plur_recall_hybrid` call: query encodes to 768d; cache hits return 384d; `cosineSimilarity` reads `b[i]` for `i in [384, 768)` as `0` (Float32Array out-of-bounds returns 0); dot product is meaningless. The user sees worse recall quality "for no reason" and there is no error, no warning, no fix command that works. `plur doctor` reports everything green (no PGLite, no dim warning). The user blames PLUR and stops using it. Mitigation today: manually `rm ~/.plur/.embeddings-cache.json` — but no doc tells them.

2. **First-run UX hang on a flaky connection.** User installs PLUR for the first time; default embedder is EmbeddingGemma. First MCP call (`plur_session_start` or `plur_recall_hybrid`) triggers a 325MB ONNX download from `huggingface.co/onnx-community/embeddinggemma-300m-ONNX`. Their connection is 5 Mbps. Download takes 9 minutes. Their MCP client (Claude Code) times out the tool call. They try `plur doctor` — its 10-second embedder probe times out and reports "embedder probe failed (signal SIGTERM)". They conclude PLUR is broken and uninstall.

3. **Reembed migration on a real-sized store dies and silently corrupts the index.** PGLite user has 30k engrams. They flip `PLUR_EMBEDDER` for the first time and run `plur sync --reembed --full`. The CLI calls `reembedAsync({full: true})`. Step 1: drops embedding table, recreates at 768d (vector column empty). Step 2: iterates engrams, embedding one at a time. Engram 12,847 has a 9000-token statement (rare but possible for a journal-import engram); OpenAI returns HTTP 400. `reembedAll` throws. `Plur.sync` catches and logs a warning; CLI returns "Sync: ok". User sees success. PGLite has 12,846 embeddings out of 30,000. `recallHybrid` now returns 12,846 results max, no warning, no doctor signal.

4. **PGLite opt-in user observes their substrate doing nothing useful.** User reads the CHANGELOG, sets `PLUR_BACKEND=pglite`. Their writes are now slower (YAML + PGLite mirror). Their reads are NOT faster (PGLite is never queried). Their vector search is NOT better (still goes through the JSON cache via `embeddings.ts`). They file an issue saying "PGLite seems broken".

5. **Test suite blesses the wrong thing.** A future PR re-introduces a bug where `recall` returns engram IDs that aren't in YAML (the exact failure mode the yaml-as-truth tests claim to defend). The yaml-truth-traceability test runs on the legacy in-memory path and still passes — because the legacy path always reads from YAML. The new PGLite path is the one that COULD diverge (e.g. a synthetic engram inserted at upsert time, an AGE-graph-derived engram), and that path has zero invariant coverage. The test names give false confidence.

## Things That Look Like Tests But Aren't

- `benchmark/run.test.ts:156-175` — "accepts the four embedder names and runs the real adapter (PR 4)" — runs in `searchMode: 'bm25'` which never calls the embedder. Passes whether or not the adapter loads. The test name is a lie.

- `packages/core/test/embedder-pglite-dim.test.ts:42-62` — claims to verify the PGLite vector column is sized to the embedder's dim. Never calls `getVectorColumnDim`. Passes when pgvector falls through to BYTEA (no dim constraint).

- `packages/core/test/yaml-truth-rebuild.test.ts` (all tests) — claims to defend the invariant "any derived state must be rebuildable from YAML." Does not run against PGLite (no `PLUR_BACKEND=pglite`). The "nukeDerivedState" function deletes a `store.pglite/` path that never existed.

- `packages/core/test/yaml-truth-traceability.test.ts` (all tests) — same problem. Defends only the legacy in-memory path. Does not exercise PR 2.

- `packages/core/test/pglite-adapter.test.ts:386-426` — "Plur — PGLite backend integration" suite verifies `plur.list()` returns engrams when `PLUR_BACKEND=pglite` is set, but `list` reads through `_loadAllEngrams` (YAML), not through PGLite. The test passes even if PGLite was never queried. No `recallHybrid` or `recallSemantic` is exercised in PGLite integration tests.

- `packages/core/test/reembed-migration.test.ts:236-257` — "reembedAsync({ full: true }) re-embeds yaml engrams without touching yaml" — verifies `result.skipped === false` and `list()` returns the same IDs. Never calls `recallHybrid` to confirm the rebuilt embeddings actually produce sensible search results. The migration could finish with all-zero vectors and the test would still pass.

- `packages/core/test/embedder-default.test.ts:72-76` — "embed() throws a clear error when OPENAI_API_KEY is missing" — good. But there is no test for: 429 rate limit handling, 5xx retry, oversize-input handling, network timeout, malformed JSON response. The OpenAI tier is a one-line happy path.

## Spec Drift (vs sprint-0-plan.md)

- **PR 1 spec line 58-59** said both yaml-truth tests are required to pass on every PR. They are present, but they don't actually exercise the substrate PR 1 was supposed to police. The intent (defend YAML-as-truth against PR 2's substrate change) is missed.

- **PR 2 spec line 70-73**: "Storage adapter interface refactor: pluggable backend, YAML always primary." Only PGLite uses the new interface; SQLite never adopted it; the dispatch logic in `Plur` is `if pglite ... else if indexedStorage ...` rather than `adapter.x()`. Refactor is half-done.

- **PR 2 spec line 72**: "PGLite + pgvector + AGE bundled and lazy-loaded." Lazy-loaded yes. But AGE schema is only initialised (line 200-209) — the graph is not used by anything in this PR. Acceptable since the spec said "schema is ready for #200", but worth noting it adds latency and surface area now for a future benefit.

- **PR 2 spec line 74**: "Migration: existing `~/.plur/engrams.yaml` users get a one-time index build on first run". This happens (background syncFromYaml in constructor, line 215). But the user never sees a success/failure signal and reads still go through YAML, so the "index build" has no visible effect.

- **PR 3 spec line 84**: "Multi-system harness: PLUR vs gbrain vs Letta vs Zep adapter shims". No shims exist. The harness still only runs against PLUR. The spec allowed "cite their published numbers" as a fallback for gbrain, but no comparison numbers are surfaced. Drift accepted by silence.

- **PR 3 spec line 81**: "Extend to support full LongMemEval-S (500 questions per category) via `--iterations 500`". The flag exists; the underlying data does not. `sampleScenarios` samples with replacement when N > pool. The "full LongMemEval-S" promise cannot be fulfilled with the current fixture. Either ship the real LongMemEval-S data or downsize the spec.

- **PR 4 spec line 95-96**: "Decision: confirm EmbeddingGemma as the new default unless another candidate beats it by ≥2pp R@5 at or below its CPU cost." The data does not pass this gate (no candidate beats by ≥2pp R@5, but EmbeddingGemma is dominated on R@1, latency, and RAM by both MiniLM and BGE-small). Decision made anyway. The gate cuts both ways but is interpreted asymmetrically.

- **PR 5 spec line 101**: "EmbeddingGemma-300M (int8) wired as the default". Adapter uses `dtype: 'q8'`, which the comment claims is int8-equivalent. Acceptable.

- **PR 5 spec line 103**: "Surface a `plur doctor` warning when the configured embedder differs from the indexed model." Implemented for PGLite users. The 90%+ of users on the default backend get no warning — material drift from spec intent. The spec assumed PGLite-as-default; in practice PGLite is opt-in.

- **Plan exit criterion #4** (line 170): "LongMemEval R@5 ≥ 95% local with EmbeddingGemma default." Current data shows 80% on N=30. Cannot be re-run honestly without real LongMemEval-S data.

- **Plan rollback section** (line 174-180): "YAML-as-truth means user data is intact regardless — only the index/derived state is at risk." True for PGLite. For the default-flip migration, derived state (`.embeddings-cache.json`) silently corrupts recall and there's no rollback signal beyond "user deletes a file they don't know about."

## Closing

This sprint did real work — five PRs, well-organised TDD, clean code. But the visible polish hides four fundamental issues: (1) the new substrate is plumbed in but not consumed; (2) the new default embedder is unsafe to roll out to existing users; (3) the bake-off does not justify the swap on the metrics that matter; (4) the marquee invariant test does not run against the marquee substrate. Fix these and the sprint ships. Don't and the substrate is decoration.
