# PLUR

Persistent, local-first memory for AI agents. Engrams strengthen with use, decay when irrelevant, and sync across tools.

[plur.ai](https://plur.ai) · [Benchmark](https://plur.ai/benchmark.html) · [Engram Spec](https://plur.ai/spec.html) · [npm](https://www.npmjs.com/org/plur-ai)

## Install

```bash
# MCP server (Claude Code, Cursor, Windsurf)
npm install -g @plur-ai/mcp
plur init

# OpenClaw plugin
openclaw plugins install @plur-ai/claw
openclaw config set plur.enabled true
```

MCP config (`.claude/mcp.json`):

```json
{
  "mcpServers": {
    "plur": { "command": "plur-mcp", "args": ["serve"] }
  }
}
```

## Usage

### As a library

```typescript
import { Plur } from '@plur-ai/core'

const plur = new Plur()

// Learn
const engram = plur.learn('toEqual() in Vitest is strict — use toMatchObject() for partial matching', {
  type: 'correction',
  scope: 'project:my-app',
  domain: 'dev/testing'
})

// Recall (BM25 keyword search)
const results = plur.recall('vitest assertion matching')

// Recall (hybrid: BM25 + embeddings + RRF fusion, zero API cost)
const hybrid = await plur.recallHybrid('vitest assertion matching')

// Recall (agentic: BM25 + LLM reranker)
const agentic = await plur.recallAsync('vitest assertion matching', { llm: myLlmFn })

// Inject — select relevant engrams for a task
const { engrams, metadata } = plur.inject('Write tests for the user service', {
  scope: 'project:my-app',
  limit: 15
})

// Feedback — train relevance
plur.feedback(engram.id, 'positive')

// Forget
plur.forget(engram.id, 'outdated')

// Sync across machines
plur.sync('git@github.com:you/plur-memory.git')

// Status
const { engram_count, episode_count, pack_count } = plur.status()
```

### MCP tools

When running as an MCP server, these tools are exposed:

| Tool | Description |
|------|-------------|
| `plur.learn` | Store a memory |
| `plur.recall` | Retrieve relevant memories |
| `plur.forget` | Retire a memory |
| `plur.feedback` | Rate memory relevance |
| `plur.inject` | Select engrams for a task context |
| `plur.ingest` | Extract engrams from text/conversation |
| `plur.sync` | Sync memory across devices |
| `plur.status` | Memory stats and health |
| `plur.session.start` | Begin session, inject relevant engrams |
| `plur.session.end` | End session, capture learnings, run decay |

## Packages

| Package | Description |
|---------|-------------|
| [`@plur-ai/core`](packages/core) | Engram engine — learn, recall, inject, search, decay, feedback |
| [`@plur-ai/mcp`](packages/mcp) | MCP server wrapping core for Claude Code, Cursor, etc. |
| [`@plur-ai/claw`](packages/claw) | OpenClaw ContextEngine plugin |

## Architecture

```
@plur-ai/core
├── engrams.ts        Engram CRUD + YAML persistence
├── fts.ts            BM25 full-text search over enriched schema
├── embeddings.ts     BGE-small-en-v1.5 (384-dim, local ONNX)
├── hybrid-search.ts  Reciprocal Rank Fusion (BM25 + embeddings)
├── query-expansion.ts  LLM query rewriting (opt-in)
├── agentic-search.ts   LLM reranking (opt-in)
├── inject.ts         Context-aware engram selection + spreading activation
├── decay.ts          ACT-R-inspired activation decay
├── episodes.ts       Episodic timeline
├── conflict.ts       Contradiction detection
├── sync.ts           Git-based sync across machines
├── packs.ts          Pack install/export
└── storage.ts        Path detection + YAML I/O

@plur-ai/mcp          Wraps core as MCP tools
@plur-ai/claw          OpenClaw ContextEngine (assemble/compact/afterTurn hooks)
```

### Search pipeline

Zero-cost hybrid search — no API calls, fully local:

1. **BM25** over enriched text (statement + entities + temporal + rationale + tags)
2. **BGE embeddings** (local ONNX, ~130MB)
3. **RRF** merges both result sets

Optional LLM-enhanced modes: agentic (reranker) and expanded (query rewriting).

### Storage

```
~/.plur/
├── engrams.yaml     # learned knowledge (plain YAML, human-readable)
├── episodes.yaml    # session timeline
├── config.yaml      # settings
└── search.db        # FTS + embedding index (SQLite)
```

`PLUR_PATH` env var overrides the default location.

## Development

```bash
git clone https://github.com/plur-ai/plur.git
cd plur
pnpm install
pnpm build
pnpm test          # all packages
pnpm test:watch    # watch mode
```

### Tests

```bash
cd packages/core
pnpm test          # ~120 tests across 15 files
```

### Project structure

```
plur/
├── packages/
│   ├── core/      # Engine (TypeScript, Vitest, Zod)
│   ├── mcp/       # MCP server (@modelcontextprotocol/sdk)
│   └── claw/      # OpenClaw plugin
├── pnpm-workspace.yaml
└── vitest.workspace.ts
```

## Contributing

- **Bug reports** — issue with reproduction steps
- **Feature requests** — issue describing the use case
- **Code** — fork, branch, PR. Tests required for new features.
- **Integrations** — build PLUR support for other AI tools

### Before submitting a PR

1. `pnpm test` passes
2. `pnpm build` succeeds
3. New features include tests
4. No new external dependencies in `@plur-ai/core` without discussion

### Conventions

- TypeScript, Zod for validation, Vitest for tests
- No external API dependencies in core (local-first)
- Plain YAML for storage (human-readable, diffable)
- All search is zero-cost by default (LLM features are opt-in)

## Benchmark

89% win rate on local knowledge across 3 Claude models. [Full report →](https://plur.ai/benchmark.html)

| Knowledge type | Record | Win rate |
|---------------|--------|----------|
| House rules | 12–0 | **100%** |
| Tool routing | 10–2 | **83%** |
| Past experience | 4–0 | **100%** |
| Learned style | 5–2 | 71% |

86.7% on LongMemEval. Zero search cost. Fully local.

## License

Apache-2.0
