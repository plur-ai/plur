# PLUR

Persistent memory for AI agents. Local-first, zero-cost, works across every MCP tool.

[plur.ai](https://plur.ai) · [Benchmark](https://plur.ai/benchmark.html) · [Engram Spec](https://plur.ai/spec.html) · [npm](https://www.npmjs.com/org/plur-ai)

## The idea

You correct your agent's coding style on Monday. On Tuesday, it makes the same mistake. You explain your architecture in Cursor. That night, Claude Code has no idea.

PLUR fixes this. Install it once, and every correction, preference, and convention persists — across sessions, tools, and machines. Your memory is stored as plain YAML on your disk. No cloud, no API calls, no black box.

The interesting part: **Haiku with PLUR memory outperforms Opus without it** — 2.6x better on tool routing, at roughly 10x less cost. Turns out the bottleneck isn't model intelligence. It's context.

## Install

```bash
npm install -g @plur-ai/mcp
plur init
```

Add to `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "plur": { "command": "plur-mcp", "args": ["serve"] }
  }
}
```

For OpenClaw:

```bash
openclaw plugins install @plur-ai/claw
openclaw config set plur.enabled true
```

That's it. PLUR works in the background from here. No workflow changes needed — just use your tools as usual. Corrections accumulate automatically.

## How it works

Knowledge is stored as **engrams** — small units that strengthen with use and decay when irrelevant. This is modeled after how human memory actually works (ACT-R activation, Hebbian reinforcement). The result: the system gets better over time, not just bigger.

```
You correct your agent  →  engram created  →  YAML on your disk
Next session starts     →  relevant engrams injected  →  agent remembers
You rate the result     →  engram strengthens or decays  →  quality improves
```

Search is fully local: BM25 over enriched text + BGE embeddings + Reciprocal Rank Fusion. Zero API calls. 86.7% on LongMemEval — on par with cloud-based solutions that charge per query.

## Usage

```typescript
import { Plur } from '@plur-ai/core'

const plur = new Plur()

// Learn from a correction
plur.learn('toEqual() in Vitest is strict — use toMatchObject() for partial matching', {
  type: 'correction',
  scope: 'project:my-app',
  domain: 'dev/testing'
})

// Recall (hybrid: BM25 + embeddings, zero cost)
const results = await plur.recallHybrid('vitest assertion matching')

// Inject relevant engrams into agent context
const { engrams } = plur.inject('Write tests for the user service', {
  scope: 'project:my-app',
  limit: 15
})

// Feedback trains the system
plur.feedback(engram.id, 'positive')

// Sync across machines
plur.sync('git@github.com:you/plur-memory.git')
```

### MCP tools

| Tool | What it does |
|------|-------------|
| `plur.learn` | Store a memory |
| `plur.recall` | Retrieve relevant memories |
| `plur.inject` | Select engrams for current task |
| `plur.feedback` | Rate relevance (trains quality) |
| `plur.forget` | Retire a memory |
| `plur.ingest` | Extract engrams from text |
| `plur.sync` | Sync across devices |
| `plur.session.start` | Begin session, inject context |
| `plur.session.end` | End session, capture learnings |

## Benchmark

We ran 19 decisive contests across three Claude models (Haiku, Sonnet, Opus). Same task, same prompt — one agent with PLUR, one without. Ties removed.

| Knowledge type | Record | Win rate |
|---------------|--------|----------|
| House rules | 12–0 | **100%** |
| Tool routing | 10–2 | **83%** |
| Past experience | 4–0 | **100%** |
| Learned style | 5–2 | 71% |

**89% overall win rate.** House rules — tag formats, file conventions, project structure — were 100% across every model. Not a single loss.

The cost insight was unexpected: Haiku + PLUR scored 0.80 on discoverability. Opus alone scored 0.31. A $0.25/MTok model with memory beat a $15/MTok model without it. Memory isn't a nice-to-have — it changes which model you need.

[Full methodology →](https://plur.ai/benchmark.html)

## Packages

| Package | Description |
|---------|-------------|
| [`@plur-ai/core`](packages/core) | Engram engine — learn, recall, inject, search, decay |
| [`@plur-ai/mcp`](packages/mcp) | MCP server for Claude Code, Cursor, Windsurf |
| [`@plur-ai/claw`](packages/claw) | OpenClaw ContextEngine plugin |

## Architecture

```
@plur-ai/core
├── engrams.ts        CRUD + YAML persistence
├── fts.ts            BM25 over enriched schema (entities + temporal + rationale)
├── embeddings.ts     BGE-small-en-v1.5, 384-dim, local ONNX
├── hybrid-search.ts  Reciprocal Rank Fusion
├── inject.ts         Context-aware selection + spreading activation
├── decay.ts          ACT-R activation decay
├── sync.ts           Git-based sync across machines
└── storage.ts        Path detection + YAML I/O

@plur-ai/mcp          Wraps core as MCP tools
@plur-ai/claw          OpenClaw ContextEngine hooks (assemble/compact/afterTurn)
```

### Storage

Everything is plain YAML. Open it, read it, edit it.

```
~/.plur/
├── engrams.yaml     # learned knowledge
├── episodes.yaml    # session timeline
├── config.yaml      # settings
└── search.db        # FTS + embedding index (SQLite)
```

`PLUR_PATH` overrides the default location.

## Development

```bash
git clone https://github.com/plur-ai/plur.git
cd plur
pnpm install && pnpm build && pnpm test
```

~120 tests across 15 files. `pnpm test:watch` for development.

## Contributing

- **Bug reports** — issue with reproduction steps
- **Feature requests** — issue describing the use case
- **Code** — fork, branch, PR. Tests required.
- **Integrations** — build PLUR support for other tools

Before submitting: `pnpm test` passes, `pnpm build` succeeds, no new external deps in core without discussion.

Conventions: TypeScript, Zod validation, Vitest, no external APIs in core, YAML storage, zero-cost search by default.

## License

Apache-2.0
