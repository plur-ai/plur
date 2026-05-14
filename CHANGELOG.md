# Changelog

## 0.9.9 (2026-05-14)

Concurrent writes — hardened.

- Multi-agent writes serialize cleanly
- Failed saves logged, not silent
- Pipelines auto-resume mid-run
- Jittered retries bound wall time

### What changed (Hermes plugin)

When two agents write engrams at the same time — a Twitter cron and a Telegram bot, say — they can race for the engram-store lock. Before 0.9.9, the second writer's call would fail silently and the engram would be lost. 0.9.9 retries lock-contended writes with jittered exponential backoff, surfaces typed `PlurLockError` exceptions for callers that want to react, and bounds wall-time exposure via a circuit breaker.

The meta-extraction pipeline now preserves recovery state on partial failure — if 3 of 10 saves fail mid-run, the failed three are retained and can be retried via an empty-body resubmit (caller doesn't have to re-run the full 6-stage pipeline).

### Improvements

- **Layered retry**: outer layer handles CLI hangs (TimeoutExpired → graceful safe-fallback after 5/15/30s backoff). Inner layer handles lock contention (PlurLockError → jittered 1/2/4s backoff). Both honor `PLUR_BRIDGE_RETRY=false`.
- **`PlurLockError`** — new typed exception (subclass of `PlurBridgeError`) so callers can distinguish transient lock contention from permanent errors. Backwards compatible: existing `except PlurBridgeError` still catches it.
- **Jitter** (±50% on each retry delay) defeats thundering-herd phase-lock between concurrent bridge instances.
- **Failed engram saves** in the meta-pipeline are now logged at WARNING with `exc_info=True` instead of silently swallowed by `except: pass`. The response surfaces `saved` / `failed` / `skipped` / `failed_engrams` counts.
- **Stage-5 retry path** in `submit_analysis`: after a partial save failure, the pipeline state is preserved with only the failed engrams. Resubmit with `submit_analysis(session_id, [])` to retry exactly those — no need to re-run the full pipeline.
- **Crash-resume guidance**: `start_extraction` on a stage-5 retry-pending session returns `status: "retry_pending"` with explicit instructions instead of confusing `status: "resuming"` with empty prompts.
- **Circuit breaker** in `_save_and_finalize` (3 consecutive failures → defer remaining engrams) bounds wall time on sustained contention. Prevents N × bridge-timeout blocking when the engram store is unreachable.
- **JSON error message extraction** unwraps `{"error": "..."}` from `--json` CLI output authoritatively, suppressing npm/Node stderr noise from leaking into user-facing exception messages.

### Internal

- New `_call_with_lock_retry()` helper extracts the inner retry; `_invoke_cli()` is the single CLI invocation that propagates `TimeoutExpired` / `FileNotFoundError` to the outer layer and raises `PlurLockError` / `PlurBridgeError` for callers.
- `_is_lock_failure()` regex covers 3 phrasings — survives minor wording changes in core's `withLock` / `withAsyncLock` messages.
- 38 net-new tests (42 → 88 total) covering retry boundaries, jitter bounds, JSON-envelope edge cases (null/empty/malformed/array), circuit breaker, multi-round retry, stderr-noise scenarios, `_save_state` failure path, None-responses guard, bytecode-level `-O` safety.
- 4 evaluator audit iterations (critic ×4, dijkstra ×2, data ×3). Final critic verdict: ready to merge.

### Versions

- `@plur-ai/core` 0.9.8 → 0.9.9
- `@plur-ai/mcp` 0.9.8 → 0.9.9
- `@plur-ai/cli` 0.9.4 → 0.9.9
- `plur-hermes` 0.9.4 → 0.9.9

### Deferred to follow-up

- Core-side `withLock` retry-budget bump (needs configurable per-consumer defaults, not a global change).
- `_find_duplicate` swallows `PlurLockError` silently — pre-existing, results in one extra CLI call under contention, not data loss.

## 0.9.8 (2026-05-06)

`plur_learn` with a remote scope now returns the **server-canonical
engram id** so a later `plur_forget(id)` / `plur_feedback(id)` actually
finds the engram.

### Fixes

- **New `Plur.learnRouted(statement, context)` async method** — for remote-scope writes, awaits the POST to `/api/v1/engrams` and returns an Engram with the server-assigned id (e.g. `ENG-2026-05-06-008`). For local-scope writes, defers to sync `learn()` so dedup behavior is unchanged.
- **`RemoteStore.appendAndGetServerId(engram)`** — companion to `append()` that returns `{ id }` parsed from the server's response. The existing `append()` keeps its `Promise<void>` shape to satisfy the `EngramStore` interface contract; the new method is for callers that need the canonical id.
- **MCP `plur_learn` handler routes through `learnRouted` first** — was using `learnAsync` (LLM-driven dedup) which ultimately called sync `learn()` and returned the local placeholder id. Users saw e.g. `ENG-2026-0506-017`, then `plur_forget("ENG-2026-0506-017")` returned "Engram not found" because the engram only existed on the server with id `ENG-2026-05-06-008`.
- **Loud failure on remote-write failure** — `learnRouted` throws when the POST fails (network, 5xx). The MCP handler catches and falls back to sync `learn()`, returning the local placeholder id with a `warning` field naming the trade-off so the caller can react instead of silently believing the write succeeded.

### Verification (against production)

Verified end-to-end before publish:
1. `plur.learnRouted(stmt, { scope: 'group:plur/plur-ai/engineering' })` returned `ENG-2026-05-06-008` (server format `^ENG-\d{4}-\d{2}-\d{2}-\d{3}$`)
2. `GET /api/v1/engrams/ENG-2026-05-06-008` returned 200 with the same statement → roundtrip works

All 806 tests pass.

### Versions

- `@plur-ai/core` 0.9.7 → 0.9.8
- `@plur-ai/mcp` 0.9.7 → 0.9.8
- `@plur-ai/claw` 0.9.13 → 0.9.14

### Why this matters

0.9.7 fixed routing-to-remote and the silent config clobber. But the engram object returned to the caller still had the *local* placeholder id — meaning that any code holding onto that id (to pass to `forget`, `feedback`, or `history`) had a phantom reference. Users would write a team engram, copy the id, try to retire it, and get "Engram not found" — even though the write succeeded on the server. 0.9.8 closes the id-roundtrip loop so the value the caller gets back is the value they can use.

## 0.9.7 (2026-05-06)

`loadConfig` no longer drops the entire `stores` array on a single bad
entry. Closes the silent-clobber pathway that made the 0.9.6 fix hard
to land.

### Fixes

- **Per-entry tolerance in `loadConfig`** — previously `loadConfig` parsed the entire config with `PlurConfigSchema.parse()`. Any single invalid `stores` entry threw, and the catch returned an empty config (`{}`), silently dropping every other valid entry too. In the wild this meant a pre-0.9.5 MCP process running against a 0.9.6+ config (which has `url`-based remote stores its old schema doesn't know about) would: load → throw → fall back to empty → save back over the file → permanently lose the user's remote store registration. Now each store entry is validated independently with `safeParse`; invalid entries are dropped with a `[plur:config] dropping invalid stores[N] (label) ...` warning, valid entries survive.
- **Loud failure on top-level config parse errors** — when `loadConfig` falls back to defaults due to YAML or schema issues at the top level, it now logs the path and the error reason. Silent fall-back was the worst kind of failure mode.

### End-to-end verification (production)

This release was verified against `https://plur.datafund.io` before publish:
1. Config with mixed valid (URL+token) and invalid entries → only the invalid entry dropped, URL store survived
2. `plur.learn(stmt, { scope: 'group:plur/plur-ai/engineering' })` → POSTed to `/api/v1/engrams`, returned server-assigned ID
3. REST GET on the new ID → confirmed engram on server with correct scope
4. Local `engrams.yaml` not created → no leak

All 516 core tests pass.

### Versions

- `@plur-ai/core` 0.9.6 → 0.9.7
- `@plur-ai/mcp` 0.9.6 → 0.9.7
- `@plur-ai/claw` 0.9.12 → 0.9.13

### Why this matters

0.9.6 shipped the `learn()` routing fix for plur-ai/enterprise#25 but in practice teams couldn't observe it: any pre-0.9.5 MCP instance still running on the same machine would clobber the config file on each load/save cycle, dropping the URL store entry. 0.9.7 removes that pathway — even an old client behaving badly can no longer take down the whole stores array.

## 0.9.6 (2026-05-06)

`plur_learn` now actually writes to remote stores. Closes the half-shipped
RemoteStore work from 0.9.5.

### Fixes

- **`learn()` routes writes to matching remote stores** ([plur-ai/enterprise#25](https://github.com/plur-ai/enterprise/issues/25)) — when an engram's scope matches a registered remote store entry (writable, exact-scope match), the engram is POSTed to that store's `/api/v1/engrams` endpoint instead of being written to the local YAML. 0.9.5 shipped registration (`plur_stores_add`) and remote reads (`RemoteStore.load()`) but missed the write routing — engrams with team scopes silently stayed local. The Datafund pilot's entire shared-memory value prop was broken until this fix.
- Routing is **fire-and-forget for the sync path** — `learn()` returns the engram object immediately and the network append completes in the background. Failures log loudly via `[plur:learn] remote append failed for ...`. The proper outbox pattern (queue + retry + reconcile) is tracked in [plur-ai/enterprise#26](https://github.com/plur-ai/enterprise/issues/26).
- Match rule (pilot scope): exact-match `entry.scope === engram.scope`. Prefix-match deferred — narrower scopes need explicit registration. Keeps routing predictable, prevents accidental cross-team writes.
- Read-only remote entries (`readonly: true`) keep writes local — same as filesystem stores.

### Versions

- `@plur-ai/core` 0.9.5 → 0.9.6
- `@plur-ai/mcp` 0.9.5 → 0.9.6
- `@plur-ai/claw` 0.9.11 → 0.9.12

### Migration

If you followed the onboarding for 0.9.5 and `plur_learn` with a team scope wrote locally — those engrams need to be re-published. There's no auto-sync. Either:
- Manual: read each affected engram from local YAML, call `plur_learn` again with the same statement+scope (now-fixed routing sends it to the server)
- Wait for #26 (outbox pattern) which will reconcile pending local writes against the remote on next session start

## 0.9.5 (2026-05-05)

Remote stores — register PLUR Enterprise (or any compatible REST endpoint) as a store via `plur_stores_add`.

### Features

- **`RemoteStore` driver** in `@plur-ai/core` — implements the same `EngramStore` interface as `YamlStore`/`SqliteStore` but reads/writes against an HTTP endpoint (PLUR Enterprise's `/api/v1`). 60s TTL cache, in-flight request dedup, paginated load, never-throws on network failure.
- **`plur_stores_add` accepts `url`+`token`** — was `{path, scope}`-only; now `{path | url+token, scope}`. Schema requires exactly one of path/url. Backwards compatible: existing filesystem-store call sites unchanged.
- **`StoreEntry` config schema** — adds optional `url` and `token` fields, refine() enforces exactly-one-of-path-or-url.
- **`Plur.addStore()`** — accepts `options.url` and `options.token` to register remote stores. `Plur.listStores()` returns `{path?, url?, scope, ...}` shape.
- **MCP `plur_stores_add` tool** — `required: ['scope']` (was `['path', 'scope']`). Returns `kind: 'filesystem' | 'remote'`.

### Why this matters

The PLUR Enterprise pilot needed a clean answer to "what does an existing local-PLUR user do?" The previous answer was "configure two MCP servers in `mcp.json` and prefix every call with `plur-local__` or `plur-enterprise__`." The new answer is `plur_stores_add url=... token=... scope=...`, registered once on the existing single-MCP-server install. Existing multi-store recall machinery handles the merge.

## 0.9.4 (2026-05-04)

Hybrid recall, restored.

- BGE embeddings actually work
- Pinned engrams (always-inject)
- plur_doctor diagnostic
- PLUR_DISABLE_EMBEDDINGS opt-out

### Fixes

- **Hybrid search degraded-mode surfacing** — `plur_recall_hybrid` now reports `mode: 'hybrid-degraded'` (with the underlying error) when the embedding model failed to load. Previously it lied with `mode: 'hybrid'` while silently falling back to BM25-only.
- **Embeddings build config** — `@huggingface/transformers`, `onnxruntime-node`, `onnxruntime-web`, `sharp`, `@huggingface/jinja` now marked external in the core tsup config. Bundling them broke ONNX backend registration in production with "listSupportedBackends is not a function".
- **Embedder retry** — `getEmbedder()` no longer latches the first-load failure forever. Each call re-attempts so first-run download races resolve themselves.
- **Embedding boost uses cosine, not rank** — `injectHybrid` previously gave the top semantic result a hardcoded boost of 1.0 regardless of how unrelated it was. Now uses the actual cosine score so the threshold is meaningful.
- **Embedding threshold raised 0.3 → 0.5** — the lower threshold was tuned for a non-functional embedder. Once BGE actually loaded, 0.3 surfaced spurious matches between unrelated short English sentences.
- **Pinned engrams bypass minRelevance filter** — without this, sessions with strong unpinned matches would silently drop pinned engrams (the entire pinning contract failed). Pinned engrams are also now sub-capped at 50% of the token budget so they can't starve relevance-scored engrams when many pinned packs are installed.
- **`plur init` upgrades stale packs** — was name-only (existing installs missed new pack content); now compares manifest versions and reinstalls when bundled > installed. Versionless packs are upgraded unconditionally.

### Features

- **`plur_doctor` MCP tool + extended `plur doctor` CLI** — probes embedder availability, reports the actual load error, and lists remediation steps including the corrupt-cache recovery path. Use this first when recall feels off.
- **Pinned engrams** (`pinned: true` on the schema) — bypass the keyword-relevance gate in `scoreEngram`, the per-pack/per-domain caps in `fillTokenBudget`, and the minRelevance filter. Use sparingly — meta-rules and safety conventions only.
- **`plur_pin` MCP tool + `pinned` param on `plur_learn`** — toggle and create pinned engrams.
- **API additions**: `Plur.setPinned(id, bool)`, `Plur.listPinned()`, `Plur.embedderStatus()`, `Plur.resetEmbedder()`, `Plur.recallHybridWithMeta()`.
- **Embeddings opt-out** — `PLUR_DISABLE_EMBEDDINGS=1` env var (also accepts `true`, `yes`) or `embeddings.enabled: false` in `~/.plur/config.yaml`. Doctor distinguishes "disabled by design" from "embedder broken." Hybrid recall reports the new `mode: 'bm25-only'` when opted out.
- **Three-way mode reporting on hybrid search** — `mode: 'hybrid' | 'hybrid-degraded' | 'bm25-only'`. `bm25-only` is the new "by design" state; `hybrid-degraded` is reserved for actual embedder load failures.

### Hardware footprint

0.9.4 makes embeddings actually work. First `plur_recall_hybrid` after upgrade triggers a one-time **~130MB BGE model download** (Xenova/bge-small-en-v1.5) plus ONNX runtime load (~few hundred MB RAM while resident, a few seconds first-call latency). Subsequent calls are fast. **Opt out** for low-resource or strict-offline environments via `PLUR_DISABLE_EMBEDDINGS=1` or `embeddings.enabled: false` in `~/.plur/config.yaml`.

### Knowledge pack consolidated

`effective-memory` v1.0.0 (8 engrams) → **v1.1.0 (12 engrams, all pinned)**. Merged the meta-rules from the standalone `plur-required` pack into the canonical `effective-memory` pack so users get one essential pack, pinned, with examples and analogies preserved. Existing 0.9.2/0.9.3 installs auto-upgrade on the next `plur init` (now version-aware).

### Packages

- `@plur-ai/core` 0.9.4 — pinned field, embedder helpers, build config fix, opt-out, mode reporting
- `@plur-ai/mcp` 0.9.4 — `plur_doctor`, `plur_pin`, hybrid-degraded + bm25-only mode reporting, version-aware pack upgrade
- `@plur-ai/cli` 0.9.4 — extended `doctor` with embedder check + opt-out hints
- `@plur-ai/claw` 0.9.10 — version bump (independent track; was 0.9.9 on npm)

## 0.9.3 (2026-04-22)

### Fixes

- **ESM import fix in core** (critical): Replaced `require('os')` and `require('path')` with ESM imports. The CJS `require()` calls crashed consumers running PLUR in pure-ESM environments (Node 20+ with `"type": "module"`, modern bundlers). Affects `autoDiscoverStores` and related code paths in `@plur-ai/core`.

### Packages

- `@plur-ai/core` 0.9.3 — ESM import fix
- `@plur-ai/mcp` 0.9.3 — version parity
- `@plur-ai/claw` 0.9.3 — version parity
- `@plur-ai/cli` 0.9.3 — version parity

## 0.9.2 (2026-04-22)

### Auto-Discover Moved Into the Constructor

Project-store auto-discovery now happens inside the `Plur` constructor instead of on first `init()`. Claw and Hermes get it for free — no extra wiring required.

- **Auto-discover in constructor**: `new Plur({...})` scans for project stores immediately. Previously only the MCP server triggered discovery.
- **MCP bundles effective-memory pack**: The MCP server ships the `effective-memory` pack bundled and auto-installs it on `plur init`. Closes the gap where new installs had zero prior-art knowledge until a manual `plur pack install`.
- **BM25 fallback for tiny corpora** (#30, #31): Robust BM25 behavior for stores with very few engrams or uniform term frequencies — previously returned empty results. Matches expectations on fresh installs.

### Packages

- `@plur-ai/core` 0.9.2 — auto-discover in constructor, BM25 fallback
- `@plur-ai/mcp` 0.9.2 — bundled effective-memory pack, auto-install on init
- `@plur-ai/claw` 0.9.2 — version parity
- `@plur-ai/cli` 0.9.2 — version parity

## 0.9.1 (2026-04-22)

### Auto-Discover Project Stores

A multi-project setup used to need explicit `--domain`/`--scope` flags on every call. 0.9.1 auto-discovers `.plur/` directories in the working tree at session start, so engrams from parent and sibling projects join the recall pool automatically.

- **Auto-discover project stores at session start**: Walks upward from `cwd` collecting `.plur/` stores; registers them alongside the global store. Makes multi-repo workflows work without config.
- **Project engram store**: Adds 67 PLUR-specific learnings (architecture, conventions, gotchas) shipped in the repo itself so contributors inherit team knowledge on first clone.
- **CLI + Hermes feature parity with 0.9.0**: `similarity-search` and `batch-decay` exposed in CLI and Hermes plugin to match the 0.9.0 core additions.
- **skills.sh ecosystem publish**: `plur-memory` skill published to skills.sh — reach across amp, cline, opencode, cursor, kimi-cli, and warp via SKILL.md auto-indexing.

### Packages

- `@plur-ai/core` 0.9.1 — auto-discover project stores, project engram store
- `@plur-ai/mcp` 0.9.1 — version parity
- `@plur-ai/claw` 0.9.1 — version parity
- `@plur-ai/cli` 0.9.1 — similarity-search + batch-decay parity

## 0.9.0 (2026-04-22)

### Memory That Maintains Itself

Engrams now have a lifecycle. They strengthen when used, weaken when forgotten, merge when duplicated, and leave an audit trail of every event. Until now PLUR had learn and recall but no maintenance — an untouched engram from January had the same injection priority as one used yesterday. 0.9.0 closes the loop.

- **Similarity search with cosine scores**: `similaritySearch()` returns `{engram, score}[]` for dedup classification. Thresholds: >0.9 duplicate, 0.7-0.9 related, <0.7 new. Scores clamped to [0, 1].
- **Batch decay**: `batchDecay()` applies ACT-R exponential decay to all primary engrams. Emotional weight slows decay for painful lessons. Scope-matched engrams are immune. Status transitions (active/fading/dormant/retirement) are logged to history.
- **Extended lifecycle events**: 5 new history event types — `recurrence_detected`, `contradiction_detected`, `scope_promoted`, `buffer_pruned`, `weekly_review`. Foundation for weekly reports and team dashboards.
- **MCP tools**: `plur_similarity_search` and `plur_batch_decay` exposed to agents for automated learning loops.
- **Multi-store search verified**: `recallHybrid` and `similaritySearch` confirmed to include engrams from registered project stores.

### Fixes

- **Scope matching precision**: Decay now uses exact + child matching (`project:alpha/sub` matches `project:alpha`, but `project:beta` does not). Previously all same-type scopes matched.
- **Engram cache invalidation**: `batchDecay` uses `_writeEngrams` for proper cache invalidation after writes.
- **Engram cache race fix** (#25, #26): Writes invalidate the read-cache via `_writeEngrams` helper. Fixes intermittent "Engram not found" failures when read and write happen in the same second.

### Multi-Project Setup Improvements (#19, #24)

- **Default to project-level config**: `plur init` creates `.claude/settings.json` in the current directory by default. Users who want global config can use `--global` flag.
- **Improved documentation**: Clarified `--domain` and `--scope` flags as the multi-project scoping solution.

### Packages

- `@plur-ai/core` 0.9.0 — similarity search, batch decay, extended history events
- `@plur-ai/mcp` 0.9.0 — plur_similarity_search + plur_batch_decay tools
- `@plur-ai/claw` 0.9.0 — version parity
- `@plur-ai/cli` 0.9.0 — project-level config, multi-project docs

## 0.8.2 (2026-04-09)

### Architecture Clarity & Multi-Project Scoping

Clarifies PLUR's architecture: **global tool, per-project scoping**. One MCP server, one engram store, available everywhere. Multi-project users scope via domain/scope fields — not per-project installations.

- **Hook-driven session start**: `hook-inject` now auto-generates a session ID on first message — no need for explicit `plur_session_start` call. Session ID is included in injected context for `plur_session_end`.
- **Project config (`.plur.yaml`)**: `plur init --domain X --scope Y` writes a `.plur.yaml` in the project root. Hooks read this file and auto-apply domain/scope to injection and learn reminders.
- **Improved init messaging**: `plur init` output now explains the global architecture and scoping model.
- **CLAUDE.md template rewrite**: Clearer architecture section, documents auto-session and multi-project scoping. Removed verbose sections in favor of concise guidance.
- **MCP server instructions updated**: Clarifies hook-driven lifecycle vs manual session start.
- **README multi-project docs**: Install section documents `--domain`/`--scope` workflow.

### Packages

- `@plur-ai/core` 0.8.2 — version bump
- `@plur-ai/mcp` 0.8.2 — updated instructions, init messaging, CLAUDE.md template
- `@plur-ai/cli` 0.8.2 — `.plur.yaml` support, auto session start, improved init output
- `@plur-ai/claw` 0.8.2 — version bump

## 0.8.0 (2026-04-08)

### Competitive Absorption: 50+ Features from 7 Memory Systems

50+ improvements absorbed in one session from Mem0, Claude-Mem, Mengram, Forge, Lossless Claw, OB1, and II-Agent. Implemented across 5 sub-projects, benchmarked, zero regressions.

- 75% faster learn/recall/inject
- 10% fewer injection tokens
- LLM-driven dedup (opt-in)
- Three-memory taxonomy

### Memory Intelligence (SP1)

- `learnAsync()` method: pre-store dedup pipeline — content hash → semantic recall → LLM decision (ADD/UPDATE/MERGE/NOOP)
- Commitment levels on engrams: exploring / leaning / decided / locked
- Tension detection: surfaces contradictions between engrams at learn time
- Confidence decay with 90-day grace period from deployment
- Content hash fast-path deduplication (SHA256 of normalized statement)

### History & Evolution (SP2)

- Event-sourced history in `~/.plur/history/YYYY-MM.jsonl` (true append-only)
- Version lineage: engrams track `engram_version` and reference previous version in history log
- `plur_history(engram_id?)` tool for auditing engram evolution
- `plur_episode_to_engram()` promotes episodic timeline events to episodic engrams
- `plur_report_failure()` for failure-driven procedure evolution (rewrites procedures after failures, max 3 revisions/24h)

### Retrieval & Injection (SP3)

- Progressive disclosure: top 30% relevance get full detail, next 40% get statements, rest get index lines
- `recallAuto()` search orchestrator: auto-selects BM25 / hybrid / expanded based on query characteristics
- Fresh tail boost: engrams from last 7 days get +0.2 retrieval strength (exploring/leaning only)
- Cognitive profile synthesis via `plur_profile()`: LLM-generated narrative summary from engram corpus, cached 24h
- Bounded sub-agent expansion with token budgets and caller session tracking
- Cost-aware model routing for LLM operations (dedup / profile / meta tiers)

### Infrastructure (SP4a + SP4b)

- Migration system with timestamp-based IDs, opt-in CLI (`plur migrate`), auto-backup
- Schema passthrough: unknown fields preserved through serialize/deserialize cycle
- Storage factory pattern: YamlStore (default) + SqliteStore (opt-in for scale)
- Async-first internals using `async-mutex` and `fs/promises`

### Benchmarks

- New `benchmark/run.ts` — LongMemEval harness (30 scenarios, 6 categories) committed permanently
- New `benchmark/micro.ts` — per-operation latency micro-benchmark with LLM dedup validation
- Both runnable on any branch: `npx tsx benchmark/run.ts` and `--compare a b`

### Deferred to 0.9.x

- Vault export (Obsidian-compatible markdown)
- Pack registry discovery (GitHub-hosted)
- Python SDK

### Packages

- `@plur-ai/core` 0.8.0 — all SP changes
- `@plur-ai/mcp` 0.8.0 — new tools: plur_history, plur_profile, plur_tensions, plur_report_failure, plur_episode_to_engram
- `@plur-ai/cli` 0.8.0 — version bump
- `@plur-ai/claw` 0.8.0 — version bump (features available via core)

## 0.7.3 (2026-04-02)

- Fix OpenClaw compat: remove pluginApi:"1" that blocked install on OpenClaw >=2026.3.31

## 0.7.2 (2026-04-02)

- Learning reflection hook: Stop hook nudges plur_learn every 3rd response — catches reasoning moments that tool-level hooks miss
- Claw system prompt updated to v3: session workflow, pack commands, correction protocol, verification rules
- Claw /packs slash command: list, install, uninstall from OpenClaw
- 9 hooks installed by plur init (was 8)

## 0.7.0 (2026-04-02)

### Knowledge Packs: Share What You Know

Knowledge Packs are thematic engram collections you can share with your team, community, or across machines. Export what you've learned about a domain, share the pack, and anyone can install it.

- Thematic export: `plur packs export react-patterns --domain code.react --tags hooks,state`
- Privacy scan on export: blocks secrets and private engrams, warns on personal paths and emails
- Conflict detection on install: flags duplicates and contradictions with existing engrams
- Uninstall: `plur packs uninstall <name>`
- Integrity hash (SHA256) per pack for tamper detection
- Auto-derived match_terms from engram tags and domains
- Internal references stripped on export (clean, portable packs)
- Output to ~/plur-packs/ (visible, easy to find and share)

### Full Memory Lifecycle Hooks

`plur init` now installs 8 hooks (was 2). Your agent gets contextual memory injection at every stage:

- Plan mode entry: broad context for architecture decisions
- Skill invocation: domain-specific engrams for the skill being used
- Agent spawn: scoped engrams for the agent's task
- Subagent start: memory carried into subagents
- Observation capture: tool calls logged for offline pattern extraction

### Observation Capture

New `hook-observe` command logs tool calls to ~/.plur/observations/ for deterministic pattern extraction. Hooks fire 100% of the time vs LLM-driven learning at ~80%.

### Packages
- `@plur-ai/core` 0.7.0 — thematic export, privacy scan, conflict detection, uninstall, integrity hash, export sanitization
- `@plur-ai/mcp` 0.7.0 — plur_packs_uninstall tool, improved export with thematic filtering, 8 hooks on init
- `@plur-ai/cli` 0.7.0 — hook-observe command, hook-inject --event for contextual injection, packs uninstall
- `@plur-ai/claw` 0.7.0 — version bump (pack features available via core)

## 0.6.0 (2026-04-01)

### Multi-Store: Share Knowledge Across Teams

PLUR now reads engrams from multiple stores. Your team's learned knowledge lives in their git repo — PLUR reads it alongside your personal memory. No copying, no syncing. Just add a store path and your agent knows what the team knows.

```yaml
# ~/.plur/config.yaml
stores:
  - path: ~/projects/my-team/engrams.yaml
    scope: my-team
    readonly: true
```

Or register via CLI: `plur stores add ~/projects/my-team/engrams.yaml --scope my-team`

- Store engrams get namespaced IDs (`ENG-DFD-2026-0401-001`) to prevent collisions
- Scope validation: store engrams auto-narrow to their scope, mismatched scopes skipped
- Feedback and forget route to the correct store (readonly stores reject writes gracefully)
- mtime-based cache: no re-parsing YAML files that haven't changed

### Performance: SQLite Index Default

`index: true` is now the default. At 600+ engrams, every recall was parsing 80KB of YAML. SQLite index makes filtered queries instant. The index syncs across all stores automatically.

### Packages
- `@plur-ai/core` 0.6.0 — multi-store reads, mtime cache, store-aware writes, index default
- `@plur-ai/mcp` 0.6.0 — graceful readonly feedback, one-command init, cold start fixes
- `@plur-ai/cli` 0.6.0 — hook-inject, plur init, stores commands
- `@plur-ai/claw` 0.6.0
- `plur-hermes` 0.6.0

### Update
```
npm update -g @plur-ai/mcp @plur-ai/cli
pip install --upgrade plur-hermes
```

## 0.5.2 (2026-04-01)

### Cold Start Fix (#7)
- `plur_session_start` returns store stats (engram count, episodes, packs) and contextual guides
- Empty store gets actionable messaging: "You have 0 engrams. Call plur_learn..."
- Fresh install triggers `setup_hint` suggesting `npx @plur-ai/mcp init`
- `plur_session_end` returns hint when no engrams captured

### One-Command Setup
- `npx @plur-ai/mcp init` now does everything: storage + MCP config + Claude Code hooks
- `plur init` (CLI) installs hooks only, for users with existing MCP config
- `plur hook-inject` — hook handler for automatic engram injection on first message
- `plur hook-inject --rehydrate` — re-inject engrams after context compaction

### Stronger Instructions
- MCP INSTRUCTIONS split into REQUIRED (session boundaries, corrections) vs OPTIONAL (feedback, recall)
- Concrete triggers ("when user corrects you") instead of vague "use proactively"

### Packages
- `@plur-ai/core` 0.5.2
- `@plur-ai/mcp` 0.5.3 — cold start fix, one-command init, stronger instructions
- `@plur-ai/cli` 0.5.4 — init, hook-inject commands
- `@plur-ai/claw` 0.5.2

### Update
```
npm update -g @plur-ai/mcp @plur-ai/cli
```

## 0.5.0 (2026-03-31)

### Session Management
- `plur_session_start` — inject relevant engrams at session start, returns session ID + context
- `plur_session_end` — capture learnings as engrams + record episode at session end

### Extended Learning
- `plur_learn` now accepts: tags, rationale, visibility, knowledge_anchors, dual_coding, abstract, derived_from
- Pack engram feedback — rate pack engrams, not just personal ones
- `plur_promote` — activate candidate engrams (single + batch)

### Improved UX
- Batch `plur_feedback` — rate multiple engrams in one call
- Search-mode `plur_forget` — find engram by keyword, not just ID
- `injected_ids` returned from inject tools — structured feedback loop
- `plur_packs_export` — export filtered engrams as shareable packs
- `plur_ingest` CLI command — extract engrams from stdin

### Packages
- `@plur-ai/core` 0.5.0 — extended LearnContext, getById, pack feedback, injected_ids
- `@plur-ai/mcp` 0.5.0 — 24 tools (was 18), session management, promote, export
- `@plur-ai/claw` 0.5.0 — enriched LearnContext in auto-learning, injected_ids in assembler
- `@plur-ai/cli` 0.5.3 — promote, stores, ingest commands, batch feedback, search forget
- `plur-hermes` 0.5.0 — extended bridge (all new features), ingest tool, batch feedback

### Update
```
npm update -g @plur-ai/mcp @plur-ai/cli
pip install --upgrade plur-hermes
```

## 0.4.2 (2026-03-28)

Initial public release. Core memory engine, MCP server, OpenClaw plugin, CLI.
