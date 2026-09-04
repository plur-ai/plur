# Whole-codebase architecture and refactoring audit — 2026-09-03

Branch `refactor/architecture-audit`, cut from `origin/main` @ 33af9de. Eight
commits, each verified with `tsc --noEmit` (core), `pnpm typecheck:tests` and
the affected test files; the full `pnpm test` was run before and after.
Scope: the whole monorepo as a system, not recent changes. Every number below
was measured with the scripts described; nothing is estimated.

## 1. Architecture summary

PLUR is a pnpm monorepo of one engine and six thin hosts.

- `@plur-ai/core` — the engine. One class, `Plur` (`packages/core/src/index.ts`),
  owns everything: store lifecycle, scope routing, the learn/recall/inject/
  feedback/forget write paths, tensions, packs, outbox, sync, session scopes,
  remote-store discovery and health. Persistence goes through one seam,
  `PrimaryStore` (ADR-0003): `YamlPrimaryStore` by default (`engrams.yaml` is the
  source of truth), `MemoryPrimaryStore` for tests, `PostgresAdapter` for the
  server tier. Query indexes are a second seam, `StorageAdapter`: the sqlite
  `IndexedStorage` (default past 5,000 engrams), `PGLiteAdapter` (opt-in), or the
  Postgres adapter answering its own queries. Secondary stores are file paths
  (YAML) or `RemoteStore` drivers over the Enterprise REST API; remote writes
  are queued in an outbox marker on the local engram and flushed later.
- Search: BM25 (`fts.ts`) + local BGE embeddings (`embeddings.ts`) fused by RRF
  (`hybrid-search.ts`), optional cross-encoder rerank, optional intent routing,
  and a server-authoritative remote recall leg merged at the call sites.
- Hosts: `mcp` (44 tools, one 2.8k-line definition function), `cli` (60 commands,
  of which 22 are hook handlers for four harnesses), `claw` (OpenClaw context
  engine), `dsh` (DeepSeek harness), `ui` (memory viewer bundled into cli/dsh),
  `migrate`, plus Python `hermes`, `python` SDK and `langchain`, all of which
  shell out to the CLI.

Data enters through the hosts, is validated once in `Plur` (input gate, leak
guard, scope routing), written under `_withStoreLock` (the store's own
exclusive-access primitive or a file lock), then the derived index is synced
and a history event appended. Invariants that matter: YAML is truth and every
index is rebuildable; no external calls in core search; every mutator asserts
writability; a whole-corpus write may not shrink the store unexpectedly.

## 2. Top complexity hotspots (ranked)

1. **`Plur` god object** — 8,507 lines, 186 methods, 25 fields, fan-out 82
   modules, 15 hand-rolled loops over `config.stores`, 21 `_getRemoteDriver`
   sites, 28 `appendHistory` sites, 77 `as any`, 14 empty catches. Every
   feature touches it; six of the twelve open PRs edit it.
2. **`getAllToolDefinitions` in `mcp/src/tools.ts`** — a single 2,811-line
   function holding all 44 tool definitions and handlers; six open PRs edit it.
3. **Untyped side-channel state on engrams** — `structured_data._outbox`,
   `_demoted`, `_routed`, `_expiry_extracted`, plus `_pack`, `_originalId`,
   `_storeScope` stamped on loaded rows: 35 `structured_data as any` sites. An
   implicit state machine with no type, so an invalid combination (an outbox
   marker on a retired engram, a demoted engram still at a shared scope) is
   representable and only caught by ad-hoc checks.
4. **Duplicated write-path mechanisms** (fixed in this pass): two copies of the
   learn input gate, two copies of the engram literal, four bodies for two
   update/pin operations, two persistence interfaces, two whole-corpus YAML
   writers, three telemetry modules copied into claw.
5. **Leak guard applied by convention** — the *rule* is one predicate
   (`_offendingHitsForScope`) but the *response* (demote + warn + stamp) is
   re-implemented at five sites (`_guardSensitiveScope`, `_guardExplicitUpdate`,
   `learn-async.demoteIfSensitive`, `flushOutbox`, `saveMetaEngrams`), and one of
   them (`_guardExplicitUpdate`) demotes without stamping `_demoted`.
6. **Recall API surface** — nine public ways to search (`recall`, `recallAsync`,
   `recallSemantic`, `recallHybrid`, `recallHybridWithMeta`, `recallExpanded`,
   `recallAutoSearch`, `similaritySearch`, `inject`/`injectHybrid`), with
   `recallAsync`, `recallExpanded` and `recallAutoSearch` having no production
   caller in this repo.
7. **Configuration** — 50 distinct `PLUR_*` env vars, a `config.yaml` schema, a
   `.plur.yaml` project config, MCP tool profiles and CLI flags; largely
   centralised in core (few `process.env` reads) but sprawling in the CLI hooks.
8. **Release change surface** — 17 hand-bumped version sites (15 after this
   pass), each guarded by its own parity test.

## 3. Refactors completed

| # | Commit | What changed | Deleted / consolidated | Bug surface reduced | Verification |
|---|---|---|---|---|---|
| R1 | b1fdea5 | Dead modules and symbols removed | `quality.ts`, `embedders/dim-check.ts`, `trust.ts`, `claw/audit-adapter.ts`, `rebuildJsonCache`, `COMMITMENT_MULTIPLIER`, `BoundedRecallResult`, `OpenClawPluginDefinition`, 6 `*ConfigYaml` aliases (−330 prod lines) | Nothing to maintain, nothing to misread (`dim-check` was a second, unwired dimension check next to the doctor's real one) | tsc, typecheck:tests, affected tests |
| R2 | 8d30ad4 | Legacy `EngramStore` family removed | `store/{types,factory,yaml-store,sqlite-store}.ts`, `assertShrinkAllowedAsync`, `storage:` config key, `store-contract.test.ts` (−~520 lines) | Storage interfaces 3 → 2; whole-corpus YAML writers 2 → 1, so the shrink guard cannot be missed at a parallel writer again (#824 was exactly that); SQLite can no longer be a primary store, matching the documented invariant | tsc, typecheck:tests, store/corruption/remote tests (95) |
| R7+R8 | 92c17fe | One cross-encoder module; rerankers import cycle broken | Two ~120-line adapter files → one factory; `rerankers/index` no longer re-exports `fit-check` (−~110 lines) | A tokenization/logit fix cannot land in one model and miss the other; runtime ESM cycle (a TDZ crash class) gone — cycles 2 → 1, remainder type-only | tsc, typecheck:tests, reranker tests (65) |
| R6 | 505220b | One version constant per package | `const VERSION` duplicates in `mcp/index.ts`, `cli/index.ts`; claw's two `version:` literals → `claw/src/version.ts`; parity tests now pin the import, not the literal | Bump sites 17 → 15; a second literal can no longer drift silently | parity tests mcp/cli/claw, `bash -n release.sh` |
| R3 | 923929c | claw uses core's telemetry | `claw/src/telemetry{,-counters,-flush}.ts` and four byte-identical tests (−~530 prod, −~520 test lines) | **Fixes a live bug**: #562 changed the endpoint only in claw's copy, to a host that does not resolve; claw heartbeats have been lost since. One module, one endpoint; wiring test pins it | claw build, all 10 claw test files (109), typecheck:tests |
| R4 | 8107f2e | One learn input gate, one engram constructor | Inline gate copies in `learn`/`learnRouted` → `_validateLearnInput`; 60-line engram literal in `learn` → `_buildEngramShape`; inline `TYPE_TO_MEMORY_CLASS` hoisted | `learnRouted` now refuses an empty statement (it POSTed one before); a new engram field cannot be added to one route only — the in-flight provenance PR (#1002) is currently editing both copies | tsc, 35 write-path test files (515) |
| R5 | 8107f2e | One body per update/pin twin | `updateEngramAsync` and `setPinnedAsync` delegate | Documented-equivalent twins had drifted on remote-refusal handling; now structurally identical | as above + new characterization test |
| T | e8bf313 | Characterization test `write-path-consolidation.test.ts` | — | Pins all three consolidations with a stubbed remote driver, no network | 7 tests |

Docs kept honest in the same commits: `packages/core/ARCHITECTURE.md` (store diagram now describes `PrimaryStore`, dead files delisted), `CLAUDE.md` bump list, `CHANGELOG.md` Unreleased entry.

## 4. Refactors deliberately NOT performed

- **Splitting `Plur`** into RemoteStoreRegistry / Outbox / TensionManager / ScopeRegistry. Highest cognitive-load win in the repo, but six open PRs (#1002, #1017, #1082, #1108, #1113, #1114) edit `index.ts`; a large reshuffle now would conflict with all of them and hide their review diffs. Do it as its own sequence once those land (see §8).
- **Splitting `getAllToolDefinitions`** into per-tool modules — same reason (six open PRs on `tools.ts`); it is file motion, not a mechanism removal.
- **Removing the deprecated `plur_recall_hybrid` MCP alias** (scheduled "earliest 0.18", now 0.19.4). It is a scheduled removal, but this installation's own `CLAUDE.md`, hooks and 12 test files still name it; removing it is a user-visible change to agent prompts, not a refactor. Listed with the exact touch points in §8.
- **Pruning core's export surface** (422 named exports; in-repo hosts use 65). The private server deployment and plur-bench import from core; which of the ~360 unused-here symbols they use is not knowable from this repo. Pruning blind would break consumers to save nothing that runs.
- **Typing the `structured_data._*` markers** — the right fix for hotspot 3, but it touches 35 sites across every write path plus the outbox, rescope and forget; too wide to land safely beside the open PRs.
- **Moving the leak-guard response into the write seam** (`_appendEngram`/`_updateEngrams`) so no write path can skip it. Valuable (it would make the guard unavoidable) but the five sites differ in *semantics* (throw vs demote vs warn) and those differences are tested; consolidating requires deciding the policy, which is a product call.
- **Collapsing `recall`/`recallSemantic`/`recallHybridWithMeta`** — they share helpers but differ in real ways (pushdown, PGLite, intent, rerank); DRYing them would be a generic function with mode flags — worse.
- **Deduplicating `hermes/learner.py` and `langchain/learner.py`** (byte-identical, 157 lines). The only shared dependency candidate is `plur-ai`, but `plur-hermes` is deliberately zero-dependency so Hermes can load it without an install step. Cost of a dependency > cost of a copy here; flagged, not fixed.
- **`reindex`/`reindexAsync` and `listStores`/`listStoresAsync`** — not twins: background-vs-awaited, cached-vs-live. The names are wrong, the bodies are not duplicates. Rename is churn; left alone.
- **`.worktrees/` and `.claude/worktrees/` checkouts inside the main clone** — stale full copies of the repo (vitest already excludes them). Repo hygiene for the owner, not code.

## 5. LOC analysis

| | Before | After | Change |
|---|---:|---:|---:|
| Production lines (all TS/Python outside tests) | 64,580 | 63,122 | −1,458 |
| Production code lines (non-blank, non-comment) | 38,677 | 37,616 | −1,061 |
| Production files | 286 | 276 | −10 |
| Test lines | 77,724 | 77,288 | −436 |
| `packages/core/src/index.ts` | 9,344 | 9,225 | −119 |
| `Plur.learn()` | 391 | 279 | −112 |
| Diff vs main | | | 47 files, +581 / −2,842 |

Where it came from, all of it deletion or de-duplication, none compression:
~530 lines of telemetry copied into claw; ~520 lines of the dead store family;
~330 lines of unreferenced modules; ~110 lines of a duplicated reranker adapter;
~110 lines of duplicated engram literal and input gate; ~100 lines of duplicated
twin bodies. Test LOC fell only because five files were byte-for-byte copies or
tested deleted code; three new test files were added.

## 6. Bug classes eliminated or materially harder

- **Guard drift between parallel writers** — there is one whole-corpus YAML
  writer now; #824's exact shape cannot recur.
- **Endpoint/constant drift between copied modules** — the claw telemetry copy
  is gone (it had *already* drifted to a dead host); a wiring test forbids a
  copy from returning.
- **Route divergence on the write path** — the remote route and the local route
  now build the engram through one constructor and pass one gate; the empty
  statement that only the local route refused is refused on both.
- **Twin drift** — deprecated names are delegations, so "equivalent" is
  structural, not a doc claim.
- **Version-literal drift** — one constant per package; parity tests fail on a
  second literal.
- **Module-instantiation crash from an ESM cycle** — the runtime cycle is gone.
- **Store-invariant violation by construction** — no `SqliteStore` primary,
  no `migrateStore(yaml → sqlite)` exists to call.

## 7. Missing tests

Added: `write-path-consolidation.test.ts` (7), `claw/test/telemetry-wiring.test.ts`
(3), `claw/test/version-parity.test.ts` (2); parity tests for mcp/cli rewritten
to pin the import.

Important invariants still without a direct test:
- **Every write path demotes sensitive content for a shared scope** — covered
  piecemeal in ten files, but no single test enumerates the write paths and
  asserts the same outcome; a new write path can skip the guard unnoticed.
- **`_guardExplicitUpdate` demotes without stamping `_demoted`** — no test
  observes the marker on that path, which is how the inconsistency survived.
- **Outbox marker states** — nothing asserts that a retired engram never carries
  `_outbox`, or that `_demoted` and a shared `scope` cannot coexist.
- **`plur.ai/v1/heartbeat` liveness** — the smoke workflow probes the remote
  store, not the telemetry ingress; the claw drift stayed invisible for that
  reason.
- **The 15 hand-rolled `config.stores` loops** agree on readonly/url filtering
  only by inspection.

## 8. Remaining architectural debt

**HIGH VALUE**
- Split `Plur` along its existing seams (remote stores, outbox, tensions,
  scope/session registries) once #1002/#1017/#1082/#1108/#1113/#1114 land. Each
  extraction is a delegation-preserving move; do them one per PR.
- Give `structured_data._*` markers a type and one accessor (`markers(e)`), and
  make invalid combinations unrepresentable (an outbox marker implies a
  writable remote scope; a demotion implies scope `local`).
- Move the leak-guard *response* into the write seam so a write path cannot
  skip it; keep the per-site policy (throw for remote-resident, demote
  otherwise) as an explicit argument.
- Split `getAllToolDefinitions` into one module per tool with a registry.

**MEDIUM VALUE**
- Remove `plur_recall_hybrid` (deprecated since 0.16). Touch points: `mcp/src/tools.ts`
  and `server.ts`, 6 mcp tests, `cli/test/hook-correction-detect.test.ts`,
  `README.md`, `llms-install.md`, `packages/mcp/{README,ARCHITECTURE}.md`,
  `core/src/history.ts` and `telemetry-counters.ts` event names, and this
  installation's root `CLAUDE.md` which instructs agents to call it.
- Retire `recallAsync`, `recallExpanded`, `recallAutoSearch` (no production
  caller; LLM-in-the-loop search paths that `agentic-search.ts`,
  `query-expansion.ts` and `search-orchestrator.ts` exist for) or wire them.
- Replace the 15 `config.stores` loops with two iterators (`_writableRemotes()`,
  `_remotes()`); collapse `listStores`/`listStoresAsync` row-building.
- Add the invariant tests listed in §7.
- `packages/cli/src/commands/doctor.ts` sends `clientInfo.version: '0.8.1'` in
  the MCP handshake — a stale literal the version consolidation did not reach.

**LOW VALUE / LEAVE ALONE**
- The 50 `PLUR_*` env vars — product surface, mostly host-specific; reduce only
  with a deprecation plan.
- `hermes`/`langchain` `learner.py` duplication — a dependency would cost more.
- `IndexedStorage` vs `PGLiteAdapter` vs `PostgresAdapter` — three index
  engines for three tiers is essential complexity here.
- The type-only `importers ↔ index` cycle — harmless.
- Renaming `reindexAsync`/`listStoresAsync` — churn.

## 9. Before vs after

| Metric | Before | After | Change |
|---|---:|---:|---:|
| Production LOC (lines / code) | 64,580 / 38,677 | 63,122 / 37,616 | −1,458 / −1,061 |
| Test LOC | 77,724 | 77,288 | −436 |
| Production files | 286 | 276 | −10 |
| External dependencies | unchanged | unchanged | 0 |
| Duplicate implementations (verbatim modules) | 4 (claw telemetry ×3, python learner) | 1 (python learner) | −3 |
| Parallel mechanisms | 2 YAML writers, 2 engram constructors, 2 input gates, 2 reranker adapters, 2 update bodies, 2 pin bodies | 1 each | −6 |
| Storage-shaped interfaces | 3 | 2 | −1 |
| Import cycles (runtime) | 1 (+1 type-only) | 0 (+1 type-only) | −1 |
| Core public named exports | 430 | 422 | −8 |
| Configuration options | 50 env vars + config keys | 50 env vars, 1 dead config key removed | −1 |
| Persisted representations | 1 (YAML) + derived indexes | same; SQLite-as-primary path deleted | −1 path |
| Version bump sites | 17 (+2 claw) | 15 (+1 claw) | −3 |
| Known invalid states | `structured_data` markers untyped | unchanged | 0 (documented) |
| Bug classes eliminated | — | 7 (see §6) | +7 |
| Missing tests identified | — | 5 invariants (§7) | — |
| Tests added | — | 12 in 3 new files (+2 parity tests rewritten) | +12 |
| Dead exports (repo-wide reference scan) | 18 | 7 (all type aliases of Zod sub-schemas, kept as documentation) | −11 |
| Full suite (`pnpm test`) | 348 files / 4,693 tests / 0 failed / 0 worker errors | 346 files / 4,648 tests / 0 failed / 0 worker errors | −2 files (5 duplicate/dead files removed, 3 added), −45 tests (12 added) |

## 10. Final assessment

- **Is the codebase meaningfully simpler?** Modestly, and in the right places:
  six parallel mechanisms became one each and two unreachable subsystems are
  gone. The dominant complexity — the `Plur` god object and the monolithic tool
  table — is unchanged, by choice, because of the open PRs against those files.
- **Easier to reason about?** The write path is: one gate → one constructor →
  one lock → one persist. The store layer has two interfaces with distinct
  jobs instead of three with overlapping ones.
- **Less code that must remain correct?** Yes: −1,061 production code lines,
  none by compression.
- **Fewer ways for bugs to occur?** The seven classes in §6, one of which was a
  live defect (claw heartbeats to a dead host) found by the audit.
- **Invariants easier to enforce?** Shrink guard, version parity and telemetry
  wiring are now structural (one writer, one constant, one module, each with a
  test). The leak guard is not yet — that is the next step.
- **LOC reduced without sacrificing readability?** Yes; comments explaining
  history were rewritten rather than dropped.
- **Next highest-value simplification:** type the engram markers and put the
  leak-guard response in the write seam; then the `Plur` split.
