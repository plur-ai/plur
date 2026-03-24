# @plur-ai/core

The engine behind [PLUR](https://plur.ai) — persistent memory for AI agents.

You correct your agent on Monday. On Tuesday, it makes the same mistake. PLUR fixes this. Corrections, preferences, and conventions persist across sessions. Your data stays on your disk as plain YAML. Search runs locally with zero API calls.

The result: **Haiku with PLUR memory outperforms Opus without it** — 2.6x better on tool routing, at 10x less cost. The bottleneck isn't model intelligence. It's context.

## Why @plur-ai/core

This is the engine that powers everything. Use it directly when you're building your own agent framework or want programmatic control over memory. If you just want to add memory to Claude Code or Cursor, use [`@plur-ai/mcp`](https://www.npmjs.com/package/@plur-ai/mcp) instead — it wraps this package as MCP tools.

## Install

```bash
npm install @plur-ai/core
```

## Quick start

```typescript
import { Plur } from '@plur-ai/core'

const plur = new Plur()

// Your agent gets corrected — save it
plur.learn('toEqual() in Vitest is strict — use toMatchObject() for partial matching', {
  type: 'behavioral',
  scope: 'project:my-app',
  domain: 'dev/testing'
})

// Next session: recall what was learned (hybrid search, zero cost)
const results = await plur.recallHybrid('vitest assertion matching')

// Or inject the best engrams into a system prompt, within a token budget
const { directives, consider, tokens_used } = plur.inject('Write tests for the user service', {
  scope: 'project:my-app',
  budget: 2000
})

// Rate what was useful — the system improves over time
plur.feedback(results[0].id, 'positive')

// Sync across machines via git
plur.sync('git@github.com:you/plur-memory.git')
```

## How it works

Knowledge is stored as **engrams** — small assertions that strengthen with use and decay when irrelevant, modeled on how human memory works (ACT-R activation). The system gets better over time, not just bigger.

```
You correct your agent  →  engram created       →  YAML on your disk
Next session starts     →  relevant ones injected →  agent remembers
You rate the result     →  engram strengthens    →  quality improves
```

Search is fully local: BM25 over enriched text + BGE-small-en-v1.5 embeddings + Reciprocal Rank Fusion. **86.7% on LongMemEval** — on par with cloud solutions that charge per query.

## Search modes

Five modes, from fastest to most accurate:

| Method | Speed | API calls | Best for |
|--------|-------|-----------|----------|
| `recall(query)` | Instant | None | Quick keyword lookup |
| `recallSemantic(query)` | ~200ms | None | Meaning-based search (local embeddings) |
| `recallHybrid(query)` | ~200ms | None | **Best default** — BM25 + embeddings via RRF |
| `recallAsync(query, { llm })` | ~1s | 1 LLM call | LLM-assisted semantic filtering |
| `recallExpanded(query, { llm })` | ~3s | 3-5 LLM calls | Query expansion for exhaustive retrieval |

## Full API

| Method | What it does |
|--------|-------------|
| `learn(statement, context?)` | Store an engram (correction, preference, convention, decision) |
| `recall(query, options?)` | BM25 keyword search — instant, zero cost |
| `recallHybrid(query, options?)` | BM25 + embeddings merged via RRF — best default |
| `recallSemantic(query, options?)` | Embedding-only search — meaning over keywords |
| `recallAsync(query, { llm })` | LLM-assisted semantic filtering |
| `recallExpanded(query, { llm })` | Query expansion + hybrid + RRF merge |
| `inject(task, options?)` | Select engrams for a task within a token budget |
| `feedback(id, signal)` | Rate an engram — trains injection relevance over time |
| `forget(id, reason?)` | Retire an engram (history preserved) |
| `sync(remote?)` | Git-based sync across machines |
| `syncStatus()` | Check sync state without making changes |
| `capture(summary, context?)` | Record a session event to the episodic timeline |
| `timeline(query?)` | Query past episodes by time, agent, or search |
| `ingest(content, options?)` | Extract engram candidates from text via pattern matching |
| `installPack(source)` | Install a shareable engram pack |
| `exportPack(engrams, dir, manifest)` | Export engrams as a shareable pack |
| `listPacks()` | List installed packs |
| `status()` | System health — counts, storage root, config |

## Storage

Everything is plain YAML. Open it, read it, edit it, version it.

```
~/.plur/
├── engrams.yaml     # learned knowledge
├── episodes.yaml    # session timeline
├── candidates.yaml  # pending engrams
├── config.yaml      # settings
└── packs/           # installed engram packs
```

Override the location with `PLUR_PATH` env var or `new Plur({ path: '...' })`.

## Benchmark

| Metric | Score |
|--------|-------|
| LongMemEval overall | **86.7%** |
| Hit@10 (retrieval) | 93.3% |
| A/B win rate vs no memory | 89% |
| House rules accuracy | 100% |

[Full methodology →](https://plur.ai/benchmark.html)

## Related packages

| Package | For |
|---------|-----|
| [`@plur-ai/mcp`](https://www.npmjs.com/package/@plur-ai/mcp) | Claude Code, Cursor, Windsurf (MCP server) |
| [`@plur-ai/claw`](https://www.npmjs.com/package/@plur-ai/claw) | OpenClaw (automatic memory plugin) |

## License

Apache-2.0 · [GitHub](https://github.com/plur-ai/plur) · [plur.ai](https://plur.ai)
