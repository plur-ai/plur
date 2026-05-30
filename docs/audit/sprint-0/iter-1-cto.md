# Sprint 0 Audit — Iter 1 — CTO

## Verdict
SHIP_WITH_FIXES

## Summary
Sprint 0 lands a clean, well-tested substrate: a YAML-as-truth StorageAdapter abstraction, a PGLite/pgvector/AGE-backed adapter, four ONNX embedder adapters behind a uniform factory, an OpenAI opt-in tier, dim-mismatch detection, a re-embed migration path, and an extended benchmark harness. 1224 tests pass locally (verified). The integrated change is backward-compatible at the public API level (default `backend: sqlite`, embeddings still flow through `embeddings.ts` cache, MCP tools unchanged in shape). The two blocking concerns are (a) the PGLite vector index is **wired but unused at recall time** — every consumer still routes through `embeddingSearch` / `.embeddings-cache.json`, so `PLUR_BACKEND=pglite` users pay the WASM/disk cost for no recall benefit, and (b) the default embedder was switched on an N=5 fixture where R@5 was tied with bge-small but p99 latency is 11x worse and peak RSS is 2.4x larger — a real performance regression for the median user.

## Findings

### BLOCKER (must fix before merge to main)

- [F-CTO-001] PGLite vector path is never invoked from recall
  - File: `packages/core/src/index.ts:1151` (`recallHybrid`), `packages/core/src/hybrid-search.ts:107`, `packages/core/src/storage-pglite.ts:364` (`searchVector`)
  - Issue: `Plur.recallHybrid` / `recallSemantic` / `injectHybrid` all route through `embeddingSearch(engrams, query, limit, this.paths.root)` in `embeddings.ts`, which keeps a JSON-on-disk cache at `<root>/.embeddings-cache.json`. `PGLiteAdapter.searchVector` and `upsertEmbedding` are implemented, tested in isolation (`pglite-adapter.test.ts:218`), and reachable only via the `reembedAll` migration helper — they are NEVER called from any public recall path. The doctor warning at `dim-check.ts:48` reads "Hybrid recall will fall back to BM25 until you run: plur sync --reembed --full" — that sentence is misleading: hybrid recall does not consult PGLite at all today, so the dim mismatch doesn't actually degrade anything in production. Conversely, the PGLite vector column is essentially write-once-on-migration dead state. The plan's stated benefit ("PGLite + pgvector + AGE bundled and lazy-loaded" with "`learn` write latency, `recall` cold/warm, `recallHybrid` p95" benchmark gains) is not delivered.
  - Fix: either (a) wire `recallHybrid` to call `pgliteAdapter.searchVector(...)` when the adapter is active and route the resulting hits into the RRF merge in `hybrid-search.ts`, write embeddings into PGLite from `embeddings.ts` (or a new hook) on each `learn()`, and update the doctor message to match reality; OR (b) explicitly mark PGLite-vector as experimental / Wave 2 in the docs and remove the "Hybrid recall will silently degrade" warning + the reembed migration command from CLI/MCP surfaces until the wiring exists. Choosing (a) is the spec — choose (b) only if Phase A scope-bounds it. Either way, the iter-1 fix must align doctor messaging, MCP tool descriptions, and CHANGELOG with what actually runs.

- [F-CTO-002] Default embedder switch ships a 2.4× RSS and 11× p99 latency regression on N=5 evidence
  - File: `packages/core/src/embedders/index.ts:60` (`DEFAULT_EMBEDDER`), `docs/benchmarks/embedder-bake-off-2026-05.md`
  - Issue: The bake-off doc itself notes "**Provisional**: EmbeddingGemma remains the planned default … (a) ties BGE-small at R@5 on this small N, (b) wins on Accuracy" and that the decision "defers to the data" of the Phase C N=500 run. PR 5 shipped the default flip without Phase C. Headline numbers from the doc: bge-small R@5=80.0%, p95=26ms, p99=555ms, peak RSS 689MB. embedding-gemma R@5=80.0%, p95=227ms, p99=6116ms, peak RSS 1684MB, on-disk 325MB. R@1 is actually worse (43.3% vs 46.7%). The plan's PR-4 decision rule was "≥2pp R@5 *at or below* its CPU cost"; embedding-gemma neither beats R@5 nor matches cost. New installs are also forced into a ~325MB first-run download vs the prior 130MB, and `PLUR_BACKEND=pglite` users with an existing 384d index get a silent "hybrid degrades to BM25" warning that is itself wrong (F-CTO-001) but loudly tells them to run a destructive migration.
  - Fix: either (a) revert the default to `bge-small` in `embedders/index.ts:60` and keep `embedding-gemma` as opt-in until Phase C N=500 produces evidence that meets the plan's documented decision rule, OR (b) run Phase C now and gate the default switch on its results. Option (a) is the conservative move and is what the bake-off doc explicitly leaves room for ("If Phase C shows EmbeddingGemma underperforming … BGE-small ships as the v0.10 default").

### MAJOR (should fix; impacts production)

- [F-CTO-003] `@electric-sql/pglite` is a non-optional dependency for the default sqlite path
  - File: `packages/core/package.json:14-17`
  - Issue: `@electric-sql/pglite` (a ~50MB WASM bundle in dependencies) is now a hard dependency of `@plur-ai/core`, but the default `backend: 'sqlite'` path never imports it. `better-sqlite3` is `optionalDependencies`. Inconsistent: the actually-used default backend is optional, the opt-in one is required. Every install — including `@plur-ai/claw` and `@plur-ai/mcp` users on the default — now pulls the WASM blob.
  - Fix: move `@electric-sql/pglite` to `optionalDependencies`. The dynamic `await import('@electric-sql/pglite')` at `storage-pglite.ts:74` already tolerates absence; add a clear error message at construction time when `PLUR_BACKEND=pglite` is set but the package is missing, pointing at `pnpm add @electric-sql/pglite`.

- [F-CTO-004] Background PGLite sync failure is logged but never surfaced
  - File: `packages/core/src/index.ts:215`, `packages/core/src/index.ts:1881`
  - Issue: Both the constructor's initial sync and every subsequent `_syncIndex()` swallow errors with `logger.warning(...)` and stash an already-resolved promise. There's no health flag, no metric, no way for `plur doctor` or `plur_status` to report "the PGLite mirror has been failing silently for the last N writes." On an enterprise install with a flaky disk or a permissions issue, the index slowly drifts from YAML and the only signal is log spam (which is often suppressed for MCP servers). `_pgliteInitPromise` is also overwritten on every write, so multiple failures cascade and only the last is observable via `waitForIndex`.
  - Fix: track a `_pgliteLastError: { ts, err } | null` on the Plur instance, expose it in `status()` and `embedderStatus()`-style getters, surface it in `plur doctor` and `plur_status`, and consider auto-promoting a series of N failures into "fall back to YAML-only-read mode and require manual `plur sync --full`".

- [F-CTO-005] PGLite mutex is per-adapter-instance, not per-database
  - File: `packages/core/src/storage-pglite.ts:55-70`, `packages/core/src/storage-pglite.ts:111` (`new AsyncMutex()` on each adapter), `packages/core/src/embedders/dim-check.ts:41` (constructs a second adapter pointed at the same `dbPath`)
  - Issue: `checkEmbedderDimMismatch` opens a second `PGLiteAdapter` instance on the same `dbPath` to read the column dim. Because the mutex is an instance field, two adapters on the same DB serialize independently. PGLite is single-writer per file: if `plur doctor` runs while a `learn()` is in flight on a long-lived Plur instance (e.g. the MCP server process), the doctor's `loadFiltered({})` triggers schema creation against a DB that the other adapter has open. PGLite tolerates this in practice because both are in the same process, but the contract is fragile — a future multi-process scenario (e.g. CLI + MCP server) would corrupt.
  - Fix: either (a) make the dim-check use the *existing* Plur instance's adapter rather than constructing a second one (add `plur.getIndexedDim()`), or (b) keep a process-level `Map<dbPath, AsyncMutex>` so two adapters on the same path share the lock. Option (a) is cleaner and removes the second `getDb()` call.

- [F-CTO-006] OpenAI adapter is per-text, no batching, no retry, no timeout
  - File: `packages/core/src/embedders/openai.ts:38-75`, `packages/core/src/embedders/openai.ts:82-88`
  - Issue: `embed(text)` calls `postEmbed([text])` — every single embed call is a separate HTTP request. `embedBatch` batches but the caller path (`transformers-base.ts:78-81`) iterates one at a time anyway, and the embeddings cache loop in `embeddings.ts:214-235` is also sequential. For a 1k-engram index this is 1k OpenAI round trips on first reembed. There is no fetch timeout (a hung request blocks indefinitely), no retry on 429/503, and no respect for rate-limit headers. A naive user enabling `openai-3-large` against a large store will burn money, hit rate limits, and have no recourse but Ctrl-C.
  - Fix: (1) add `AbortController` with a configurable timeout (default 30s). (2) On 429/503 with `Retry-After`, sleep and retry up to 3 times. (3) Batch in groups of 100 inputs per OpenAI request (the API supports it). (4) In `reembedAll`, call `embedBatch` on chunks of N rather than the current 1-at-a-time loop at `storage-pglite.ts:521-525`.

- [F-CTO-007] Reembed migration is non-transactional — partial failure leaves a half-built index
  - File: `packages/core/src/storage-pglite.ts:497-528`
  - Issue: `reembedAll({ full: true })` calls `recreateVectorColumn(newDim)` (which DROPs and CREATEs), then iterates engrams calling `upsertEmbedding` one at a time. If iteration fails halfway (network error on OpenAI, OOM on EmbeddingGemma, process crash), the user is left with: column type = new dim, vectors = partial, embedder = new — and no marker recording that the migration is incomplete. A subsequent run with `full=false` will think dims match and skip; a subsequent run with `full=true` redoes everything but only if the user notices. No checkpoint, no resume.
  - Fix: wrap the iteration in a single transaction (PGLite supports it; the mutex already exists), or write a `migration_state` row before starting and clear it on success so `plur doctor` can detect "migration in progress" / "migration incomplete." At minimum the catch path in the loop should not silently swallow — `reembedAll` should bubble.

- [F-CTO-008] `parseInt`-style trust of PGLite `format_type` output for dim
  - File: `packages/core/src/storage-pglite.ts:430-445`
  - Issue: `getVectorColumnDim` runs raw SQL against `pg_attribute`, `pg_class` and parses `vector(N)` out of `format_type`. PGLite 0.4.x is the only version this is tested against; the pgvector text representation differs across major versions (e.g. `vector` vs `public.vector`). If pgvector's text-format changes upstream the regex silently returns null and the dim-mismatch check reports "no mismatch" when there actually is one. No unit test exercises this with a real pgvector column to catch a format change at upgrade time.
  - Fix: add a guarded path that, when the regex doesn't match but `format_type` returned something, logs the unexpected string at WARNING level and surfaces via doctor. Also consider asking pgvector directly: `SELECT typname FROM pg_type WHERE oid IN (SELECT atttypid ...)` and `SELECT attndims, atttypmod` — typmod encodes the dimensions explicitly.

- [F-CTO-009] `_resolveBackend` ignores defaults and `config.yaml` precedence is wrong vs schema
  - File: `packages/core/src/index.ts:240-246`, `packages/core/src/schemas/config.ts:89`
  - Issue: `_resolveBackend` checks `env`, then `config.backend`, then defaults to `sqlite`. But `PlurConfigSchema.backend` has `.default('sqlite')` (config.ts:89), so `(this.config as { backend?: string }).backend` is **always** defined after Zod parse — the env var override path is the only way to reach `pglite`. Wait — actually `PlurConfigSchema` is `.partial()` at the top, so Zod skips defaults for unset fields. Verified by re-reading: `partial()` makes every field optional and drops defaults. So `config.backend` is `undefined` for users who don't set it, and the fallback `'sqlite'` runs. This works today but is brittle: if anyone removes `.partial()` (a reasonable refactor), every existing install silently flips to `sqlite` and ignores `backend: pglite` in their YAML… actually no, `sqlite` is the default. Conversely if `pglite` becomes the schema default, existing users get migrated without consent. The intent is implicit, not enforced.
  - Fix: replace the `(this.config as { backend?: string }).backend` cast with a typed read after using a non-partial subschema for `backend`, OR add a unit test that pins "config.backend = 'pglite' in YAML → pgliteAdapter is constructed" so a future schema refactor can't break it silently.

### MINOR (would improve; not blocking)

- [F-CTO-010] `setEmbeddingsEnabled(true)` does not re-set `disabledReason` to null after env-var disable
  - File: `packages/core/src/embeddings.ts:91-98`
  - Issue: When `PLUR_DISABLE_EMBEDDINGS` is set at import time, `disabledReason` is captured. A subsequent `setEmbeddingsEnabled(true)` sets `disabledReason = null` correctly, but `transformersUnavailable` is not cleared — so the next embed() call may still short-circuit on a stale failure flag from a prior crash. The probe path in `getEmbedder()` does retry but `embedderStatus().available` reads `!transformersUnavailable`. Minor: callers checking `available` see false even when re-enabled.
  - Fix: in `setEmbeddingsEnabled(true)`, also `transformersUnavailable = false; lastLoadError = null`.

- [F-CTO-011] `dim-check.ts` opens PGLite read-only conceptually but writes schema on every call
  - File: `packages/core/src/embedders/dim-check.ts:43`
  - Issue: The comment says "stateless and safe to call on every doctor run" but `loadFiltered({})` triggers `getDb()` → `initSchema()` which runs CREATE TABLE IF NOT EXISTS. On a fresh PGLite this means doctor materializes the schema even if the user never opted into PGLite. The function correctly bails when `existsSync(inputs.pglitePath)` is false (line 38), so this only fires when there's already a PGLite dir. Still, schema-on-doctor-check is surprising.
  - Fix: add a `readonly: true` flag on the adapter that skips `initSchema` and silently returns null from `getVectorColumnDim` when the table doesn't exist.

- [F-CTO-012] PGLite vector literal serialization loses precision on float boundaries
  - File: `packages/core/src/storage-pglite.ts:544-554`
  - Issue: `vectorLiteral` calls `String(n)` for each Float32. The default toString loses precision vs `Number.prototype.toFixed(7)` for small denormals. With normalized embeddings most values are in [-1,1] where this rarely matters, but a model with un-normalized output (or a future fp16 adapter) could see rounding drift. The roundtrip test isn't asserting this.
  - Fix: use `n.toPrecision(9)` (single-precision float has ~7 decimal digits of significance; 9 is safe), or document that the column truncates Float32 to its native precision and add a property test that round-trips a known vector through write → read.

- [F-CTO-013] `bytesToFloat32` aliases when alignment is right — caller can mutate stored embedding
  - File: `packages/core/src/storage-pglite.ts:560-568`
  - Issue: When `(arr.byteOffset % 4) === 0`, the function returns a Float32Array view ON the underlying buffer. The caller of `searchVector` then iterates these in `cosine()` (no mutation today), but any future code path that mutates the returned vector would corrupt the BYTEA cache in-memory. Defensive copying is cheap relative to PGLite round-trip cost.
  - Fix: always copy (`new Float32Array(new Uint8Array(arr).buffer)`) or document the aliasing contract on the type.

- [F-CTO-014] `_syncIndex` overwrites in-flight promise — callers awaiting `waitForIndex` race
  - File: `packages/core/src/index.ts:1881`
  - Issue: `_syncIndex` is called from every write. Each call replaces `this._pgliteInitPromise = adapter.syncFromYaml().catch(...)`. If write A starts syncing, then write B happens before A's promise resolves, write B's syncFromYaml runs (serialized by the mutex inside) but the test/CLI's `await plur.waitForIndex()` only awaits B's promise — and B started before A finished. The mutex serializes the actual DB work, but `waitForIndex` does not wait for the queue. CLI tests that rely on quiescence ("all writes mirrored") may see flakiness.
  - Fix: keep `_pgliteInitPromise = Promise.all([_pgliteInitPromise, newWork])` so waitForIndex covers the queue, OR document that `waitForIndex` only waits for the last sync (current behavior) and route CLI quiescence through `Promise.allSettled` over an internal queue array.

- [F-CTO-015] CHANGELOG line wraps and version mismatch
  - File: `CHANGELOG.md:36`
  - Issue: CHANGELOG says `@plur-ai/core: 0.9.12 → 0.10.0` but `packages/core/package.json` shows `"version": "0.10.0"` and `git log --oneline main..HEAD` shows the previous version on main was 0.9.11. The bump skips 0.9.12 entirely. Either the prior version was 0.9.12 in a sub-branch the changelog is referencing, or the line is wrong.
  - Fix: confirm the source state of main (`git show main:packages/core/package.json | grep version`) and reconcile the CHANGELOG line with reality, OR add a "0.9.12 was an unreleased internal tag" footnote.

### NIT (taste / style)

- [F-CTO-016] Magic constant DEFAULT_VECTOR_DIM mismatches the embedder-default fallback story
  - File: `packages/core/src/storage-pglite.ts:41`
  - Issue: `DEFAULT_VECTOR_DIM = 768` with a comment explaining it "matches the dim of the default embedder (EmbeddingGemma, 768d)". This is fine but the comment also says "the integration path in index.ts always passes the active adapter.dim so this default is only the bare-PGLite-adapter fallback." That's true for production but four tests in `pglite-adapter.test.ts` instantiate with no `vectorDim` and then call `upsertEmbedding` with 8-dim vectors — they pass because pgvector accepts any dim into a `vector` column with no fixed N? Verify the schema actually uses `vector(N)` not `vector` — the migration assumes a fixed N.
  - Fix: confirm by reading the schema after one of those tests that `engram_embeddings.embedding` is typed `vector(768)`. If so the 8-dim test should be failing (it currently passes — likely because pgvector validates on insert and the test uses an 8-vec which fails dim check… actually re-reading: those tests pass `{ vectorDim: 8 }` explicitly. False alarm. Remove this nit or rephrase as documentation polish.

- [F-CTO-017] `embedders/index.ts` factory comment lists "four candidate models" but ships five
  - File: `packages/core/src/embedders/index.ts:6-12`
  - Issue: Header comment lists five (including openai-3-large) but text says "four candidate models" both in dim-check.ts and various places.
  - Fix: search/replace "four candidate" → "five adapters (four local + OpenAI API)".

- [F-CTO-018] `EmbedderAdapter` lacks a `close()` / cleanup hook
  - File: `packages/core/src/embedders/types.ts:17-28`
  - Issue: Transformers pipelines pin native ONNX sessions until process exit. For long-lived MCP servers that switch embedders at runtime (e.g. an enterprise admin flips `PLUR_EMBEDDER`), there's no way to free the previous pipeline. Not a Sprint 0 problem but worth a future-work note.
  - Fix: defer; add a TODO comment on the interface.

## Things Done Well

- The StorageAdapter abstraction (`storage-adapter.ts`) is cleanly typed and explicit about which methods exist on each backend.
- YAML-as-truth invariants (Test A + Test B) are precise and high-leverage: any future regression that puts state in DB-only would break them. Excellent test design.
- The reembed migration tests inject a deterministic fake embedder (`makeFakeEmbedder` in `reembed-migration.test.ts:30`), keeping CI offline-safe — this is the right pattern and well-executed.
- `checkEmbedderDimMismatch` exposes the diagnostic so both `plur doctor` and the MCP session-start can render the same message — DRY across surfaces.
- `transformers-base.ts` factoring eliminates copy-paste across the four local adapters and concentrates the lazy-load cache discipline in one place.
- The PGLite mutex pattern, while scoped wrong (F-CTO-005), is implemented correctly for the in-instance case.
- The benchmark harness's per-category JSON + Markdown output gives reproducible, diff-able artifacts.
- Tests pin `PLUR_EMBEDDER=bge-small` via `setup-env.ts` so the test suite stays under control even after the production default flips — defensive and well-commented.
- `embedderStubFallback` flag in the harness keeps it honest about whether a real model was loaded vs a stub — good observability.
- `dim-check.ts` returning `null` on any error so the rest of doctor keeps running — correct degradation discipline.

## Production Readiness Checklist

- [x] Backward-compat preserved (default behavior unchanged for existing users) — default `backend: sqlite` keeps the legacy path live; existing engrams.yaml files load fine; MCP tool surface is unchanged. Caveat: default embedder switched (F-CTO-002) which is technically a behavior change for users on the default path.
- [x] PGLite migration path safe (no data loss) — YAML stays untouched in every code path I reviewed; nuking the PGLite dir is reversible via reindex; tests cover this explicitly.
- [ ] Embedder swap path safe (clear error on missing API key, no silent failure) — OpenAI key check at `openai.ts:31-36` throws clearly. BUT no timeout/retry on the network call (F-CTO-006), and a partial reembed failure leaves silent split-brain state (F-CTO-007).
- [ ] Test coverage of the risky paths — Embedder adapter + dim check + YAML truth: well covered. PGLite vector path: covered in isolation. **NOT** covered: the integration where `recallHybrid` actually consults PGLite (because it doesn't — F-CTO-001), reembed crash-resume, openai adapter network failure modes, dim-check on a corrupt pglite dir.
- [x] No dependency vulnerabilities introduced — `@electric-sql/pglite@0.4.6` is the only new runtime dep; no advisories. js-yaml and zod versions unchanged.
- [x] No secrets / API keys hardcoded — OpenAI adapter reads from env, throws clear error when missing. Test files use `'sk-...'`-shaped placeholder text in error messages only.
- [x] CI build green — `pnpm test` passes 1224/1248 (24 skipped, 3 test-file skips) locally on epic branch. Verified.
- [ ] Error handling at storage/network boundaries — PGLite background sync failures are logged-and-forgotten (F-CTO-004). OpenAI network errors have no retry/timeout (F-CTO-006). Reembed migration is non-transactional (F-CTO-007). These need attention before this hits enterprise installs.

---

Confidence: medium-high. The substrate work is genuinely good; the issues above are concentrated in two areas (PGLite-recall wiring gap and the default-embedder decision), both fixable in a follow-on iteration without re-architecting anything.
