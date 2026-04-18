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

~150 tests across 22 files. All must pass before committing.

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

Nine places. Miss one and something breaks:

1. `packages/core/package.json`
2. `packages/mcp/package.json`
3. `packages/mcp/src/server.ts` — `const VERSION`
4. `packages/mcp/src/index.ts` — `const VERSION` (CLI)
5. `packages/claw/package.json`
6. `packages/claw/src/index.ts` — `version:` in plugin object
7. `packages/claw/src/context-engine.ts` — `version:` in info object
8. `packages/claw/openclaw.plugin.json` — `version` field
9. `packages/claw/test/hello.test.ts` + `packages/mcp/test/server.test.ts` — version assertions

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

### Benchmarking a PR

Two benchmark suites measure whether a change actually improves memory quality:

**LongMemEval** (retrieval accuracy): Tests whether PLUR retrieves the correct engram for 30 questions across 6 categories (single-session, preferences, multi-session, temporal, updates, assistant facts).

```
# From a memorybench checkout (not in this repo)
PLUR_SEARCH_MODE=hybrid python run.py --provider plur
```

Search modes: `fast` (BM25), `agentic` (LLM rerank), `hybrid` (BM25 + embeddings RRF), `expanded` (query expansion + hybrid). Compare your change against `hybrid` as baseline.

**A/B bench** (end-to-end): Same task given to an agent with and without PLUR memory, scored by LLM judge. Scenarios in `datacore-bench/scenarios/`.

### Current numbers (v0.2.1)

| Metric | Score |
|--------|-------|
| LongMemEval overall (Opus hybrid, n=30) | 86.7% |
| Hit@10 | 93.3% |
| A/B win rate (31W/4L) | 89% |
| House rules | 12–0 |

If your PR improves any of these, mention it in the PR description.

## Conventions

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
