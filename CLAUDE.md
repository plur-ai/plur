# CLAUDE.md

## What is PLUR

Persistent memory for AI agents. An agent corrected on Monday remembers on Tuesday — across sessions, tools, and machines.

Knowledge is stored as **engrams** — small assertions that strengthen with use and decay when irrelevant, modeled on human memory (ACT-R activation). Storage is plain YAML on disk. Search is fully local: BM25 + BGE embeddings + Reciprocal Rank Fusion. Zero API calls, zero cloud.

Three packages:

```
@plur-ai/core   — engram engine (learn, recall, inject, search, decay, sync)
@plur-ai/mcp    — MCP server (Claude Code, Cursor, Windsurf)
@plur-ai/claw   — OpenClaw ContextEngine plugin
```

Core is the engine. MCP and Claw are thin wrappers — MCP exposes tools via Model Context Protocol, Claw hooks into OpenClaw's lifecycle (auto-inject on session start, auto-learn on corrections).

## Development

pnpm monorepo. From repo root:

```
pnpm install
pnpm build
pnpm test
```

~1045 tests across ~120 files (117 Vitest + Python suites). All must pass before committing.

## Package dependency

```
@plur-ai/core  ←  @plur-ai/mcp
               ←  @plur-ai/claw
```

MCP and Claw depend on core via `workspace:*`. **Claw imports from core's built dist, not source** — after changing core, rebuild before running claw tests:

```
pnpm --filter @plur-ai/core build
```

## Version bumps

`scripts/release.sh` is the authoritative source. Two independent version tracks:

**Standard release** (core / mcp / cli — always bumped together):

1. `packages/core/package.json`
2. `packages/mcp/package.json`
3. `packages/cli/package.json`
4. `packages/mcp/src/version.ts` — `export const VERSION`
5. `packages/mcp/src/index.ts` — `const VERSION`
6. `packages/cli/src/index.ts` — `const VERSION`
7. `packages/mcp/test/server.test.ts` — version assertions
8. `packages/hermes/pyproject.toml`
9. `packages/hermes/plur_hermes/skills/plur-memory.SKILL.md` — frontmatter `version:`
10. `packages/hermes/plur_hermes/bridge.py` — `_NPX_CLI_VERSION`
11. `packages/python/pyproject.toml`
12. `packages/python/plur_ai/bridge.py` — `_NPX_CLI_VERSION`

**Claw track** (independent — only bumped when `--claw <ver>` is passed to release.sh):

- `packages/claw/package.json`
- `packages/claw/src/index.ts` — `version:` in plugin object
- `packages/claw/src/context-engine.ts` — `version:` in info object
- `packages/claw/openclaw.plugin.json` — `version` field
- `packages/claw/test/hello.test.ts` — version assertion

## Publishing

Authenticate as `plur9`. Core first (it's the dependency):

```
pnpm --filter @plur-ai/core publish --access public --no-git-checks
pnpm --filter @plur-ai/mcp publish --access public --no-git-checks
pnpm --filter @plur-ai/claw publish --access public --no-git-checks
```

## Testing a change

### Unit tests

```
pnpm test                                    # all packages
pnpm test -- packages/core/test/sync.test.ts # specific file
```

### Manual testing

Install the MCP server locally and test with Claude Code:

```json
{
  "mcpServers": {
    "plur": {
      "command": "node",
      "args": ["packages/mcp/dist/index.js"],
      "env": { "PLUR_PATH": "/tmp/plur-test" }
    }
  }
}
```

Then ask Claude to learn something, recall it, and check if injection works.

### Integration tests (remote store)

```
pnpm test:integration
```

Tests RemoteStore against an in-process HTTP stub server (real TCP, no fetch mocking). The stub implements the `/api/v1/engrams` REST surface and lives at `packages/core/test/helpers/stub-server.ts`. When RemoteStore adds new endpoints, add the corresponding handler to the stub.

### Production smoke tests

```
PLUR_REMOTE_TEST_URL=https://plur.datafund.io \
PLUR_REMOTE_TEST_TOKEN=<token> \
PLUR_REMOTE_TEST_SCOPE=group:plur/test/smoke \
pnpm test:smoke
```

Runs a full roundtrip (append → getById → load → remove) against the live enterprise server. Skipped automatically when env vars are not set. Run after publishing to verify the deployment. All test engrams are tagged with a unique run ID and cleaned up in `afterAll`.

### Benchmarking a PR

All memory-quality benchmarks live in the consolidated repo **[plur-ai/plur-bench](https://github.com/plur-ai/plur-bench)**, which measures three axes and never conflates them: retrieval recall (LongMemEval-S R@K, MRR, nDCG), the editability dividend (does correcting or deleting a memory change outcomes), and agent-task A/B (does memory change what the agent does, with vs without PLUR, including token and cost economics). Its retrieval harness vendors this repo's production `searchEngrams` / `hybridSearchWithMeta` / `applyReranker`, so it exercises the code path users actually run. Offline smoke paths: `pnpm stats:test`, `pnpm editability:smoke`, `pnpm agent-bench:demo`. Add new retrieval or A/B benchmarks there, not here.

The one benchmark that stays in this repo is the core-operation latency micro-benchmark at `benchmark/micro.ts`, run via `pnpm bench:micro`. It measures `learn()` / `recall()` / `inject()` latency against the live core package across branches, which plur-bench's retrieval-only vendored core cannot do:

```bash
pnpm bench:micro                                 # full suite
npx tsx benchmark/micro.ts --label main          # tag a run
npx tsx benchmark/micro.ts --compare main pr     # compare two labelled runs
```

Run it on any core change that could affect learn/recall/inject latency, and cite deltas in your PR description.

### Current numbers (v0.9.13, ed98d52, 2026-06-27)

Historical in-repo numbers below are superseded by plur-bench; run the plur-bench
suites for current figures. The last in-repo hybrid run is archived in
plur-ai/plur-bench at `results/monorepo/2026-04-07-hybrid.json` (LongMemEval n=30
sanity subset); result JSONs are no longer committed here (#336).

| Metric | Score | Config |
|--------|-------|--------|
| LongMemEval Hit@5 (hybrid, n=30) | 76.7% | reranker off — **shipping default** |
| LongMemEval Hit@5 (hybrid + ms-marco, n=30) | 83.3% | ms-marco-minilm-l6 — recommended opt-in |
| LongMemEval Hit@5 (hybrid + bge-reranker, n=30) | **90.0%** | bge-reranker-v2-m3 — max quality |
| temporal_reasoning R@5 | 60% / 80% / **100%** | off / ms-marco / bge |
| multi_session_reasoning R@5 | 40% / 60% / 60% | off / ms-marco / bge |
| A/B win rate (31W/4L) | 89% | |
| House rules | 12–0 | |

**Reranker latency (fixture, loaded machine — idle machine will be lower):** ms-marco p50≈245ms; bge-reranker p50≈5s, p95≈10s, peak RSS≈2GB. ms-marco is production-viable; bge is suitable for offline/batch only. Set via `PLUR_RERANKER=ms-marco-minilm-l6` or `PLUR_RERANKER=bge-reranker-v2-m3`.

The earlier v0.2.1 baseline (86.7% overall / 93.3% Hit@10) is still cited in
`docs/benchmarks/phase2-methodology.md` as the self-calibration target; plur-bench
is the reproducible harness that realises it. That doc tracks methodology, not
current scores. If your PR improves any of these, mention it in the PR description.

## Conventions

- **Claim before you code**: before starting a GitHub issue, self-assign it
  (`gh issue edit <n> --add-assignee @me`); if it is already assigned to someone
  else, coordinate on the issue rather than opening a duplicate parallel fix.
  This binds automated runs too — self-assign or skip if already claimed. See
  `CONTRIBUTING.md`.
- TypeScript, Vitest, tsup, Zod for validation
- No external API calls in core — search must work offline at zero cost
- YAML for all persistent storage (not JSON, not SQLite for primary data)
- Tests in `packages/*/test/`, named `*.test.ts`
- Apache-2.0 license

## Key files

| File | What it does |
|------|-------------|
| `packages/core/src/index.ts` | Plur class — the full public API |
| `packages/core/src/fts.ts` | BM25 search over enriched engram text |
| `packages/core/src/embeddings.ts` | BGE-small-en-v1.5 local embeddings |
| `packages/core/src/hybrid-search.ts` | RRF fusion of BM25 + embeddings |
| `packages/core/src/inject.ts` | Context-aware engram selection + spreading activation |
| `packages/core/src/sync.ts` | Git-based sync across machines |
| `packages/core/src/schemas/engram.ts` | Engram schema (Zod) — the core data model |
| `packages/core/src/tensions.ts` | Contradiction scan — three-stage pre-filter + LLM judge |
| `packages/core/src/dedup.ts` | LLM dedup prompt (ADD/UPDATE/MERGE/NOOP) |
| `packages/mcp/src/tools.ts` | All MCP tool definitions |
| `packages/claw/src/assembler.ts` | Context assembly for OpenClaw |
| `packages/claw/src/learner.ts` | Auto-extraction of learnings from conversation |

## Datacore Space Context

This project lives inside a Datacore space. Session lifecycle commands are available:

- `/wrap-up` — write session entry to team journal, commit and push
- `/continue` — resume from yesterday's continuation notes; `--save` persists current work
- `/standup` — generate/post standup from recent team journals
- `/today` — daily briefing (incremental if already generated)

| Key | Value |
|-----|-------|
| Space | `5-plur` |
| Journal | `~/Data/5-plur/journal/YYYY-MM-DD.md` |
| Org | `~/Data/5-plur/org/next_actions.org` |

When `/wrap-up` runs, use the team journal schema: `## @contributor` narrative sections + `## Session Metadata` YAML block.

## PLUR Memory

You have persistent memory via PLUR. Corrections, preferences, and conventions persist across sessions as engrams.

### Architecture

PLUR is installed **globally** — one MCP server, one engram store (`~/.plur/`), available in every project. You do NOT need per-project installation. The `plur` MCP server provides tools named `plur_session_start`, `plur_learn`, `plur_recall_hybrid`, `plur_feedback`, `plur_session_end`, etc. If you cannot find these tools, run `plur doctor` to diagnose. Do **not** substitute tools from other MCP servers (e.g. `datacore_*`) — those belong to a different system.

A PreToolUse guard enforces that `plur_session_start` is called at the beginning of every session. All other tools are blocked until this is done. The flow is: ToolSearch to load `plur_session_start` → call it with a task description → proceed.

### Session Workflow

1. **Start**: Call `plur_session_start` with task description — enforced by guard hook
2. **Learn**: When corrected or discovering something new, call `plur_learn` immediately
3. **Recall**: Before answering factual questions, call `plur_recall_hybrid` — check memory first
4. **Feedback**: Rate injected engrams with `plur_feedback` (positive/negative) — trains relevance
5. **End**: Call `plur_session_end` with summary + engram_suggestions

Do not ask permission to use these tools — they are your memory system.

### Scope selection (per engram, by content)

PLUR uses `domain` and `scope` fields to separate knowledge. **Set `scope` on every `plur_learn` call, chosen by the engram's content** — one session spans multiple scopes. Scoped recall automatically includes global engrams.

- Team/shared knowledge → the matching team scope (e.g. `group:<org>/<team>`); `plur_session_start` lists the writable ones.
- This project's details → `project:my-app` (a `.plur.yaml` with `scope:` makes it the default).
- Personal preferences / your workflow → leave at the default/local scope.
- Don't omit `scope` for team-relevant knowledge — it falls back to `global`, which leaks into every project and never reaches the team store. Reserve `global` for genuinely cross-project facts.

### When to check memory

Before reaching for web search, file reads, or guessing — apply this priority:
1. Is the answer already in engrams? → `plur_recall_hybrid`
2. Is the answer in the local filesystem? → Read/Grep/Glob
3. Is the answer derivable from context already loaded? → Just answer
4. Only if 1-3 fail → Use external tools

### When corrected

When the user corrects you ("no, use X not Y", "that's wrong"):
1. Call `plur_learn` immediately — before continuing the task
2. Call `plur_feedback` with negative signal on the wrong engram if one was injected
3. Then continue with the corrected approach
