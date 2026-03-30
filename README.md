# PLUR — Your agents share the same memory

Persistent memory for AI agents. Local-first, zero-cost, works across MCP tools.

[plur.ai](https://plur.ai) · [Benchmark](https://plur.ai/benchmark.html) · [Engram Spec](https://plur.ai/spec.html) · [npm](https://www.npmjs.com/org/plur-ai)

## The idea

You correct your agent's coding style on Monday. On Tuesday, it makes the same mistake. You explain your architecture in Cursor. That night, Claude Code has no idea.

PLUR fixes this. Install it once, and corrections, preferences, and conventions persist — across sessions, tools, and machines. Your memory is stored as plain YAML on your disk. No cloud, no API calls, no black box.

The interesting part: **Haiku with PLUR memory outperforms Opus without it** — 2.6x better on tool routing, at roughly 10x less cost. Turns out the bottleneck isn't model intelligence. It's context.

## Install

### One-click install

Go to [plur.ai](https://plur.ai) and click **Install memory** for your tool — Claude Code, Cursor, Windsurf, or OpenClaw. The site generates the right config for your setup.

### Manual setup (Claude Code)

Add to `.claude/mcp.json` — no install step needed:

```json
{
  "mcpServers": {
    "plur": { "command": "npx", "args": ["-y", "@plur-ai/mcp@latest"] }
  }
}
```

Storage at `~/.plur/` is created automatically on first use. No `plur init` required.

### Global install (faster startup)

```bash
npm install -g @plur-ai/mcp
```

Then in `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "plur": { "command": "plur-mcp", "args": ["serve"] }
  }
}
```

Run `plur init` to verify your setup and check which search mode is active (hybrid or BM25).

### OpenClaw

```bash
openclaw plugins install @plur-ai/claw
openclaw config set plur.enabled true
```

That's it. PLUR works in the background from here. No workflow changes needed — just use your tools as usual. Corrections accumulate automatically.

### Hermes Agent

```bash
pip install plur-hermes
```

The plugin registers automatically via Hermes' plugin system. It injects relevant memories before each LLM call, extracts learnings from agent responses, and exposes all PLUR tools to the agent. Requires the PLUR CLI (`npm install -g @plur-ai/cli`).

### Verify it works

Ask your agent: *"What's my PLUR status?"* — it should call `plur_status` and return your engram count and storage path.

## How it works

Knowledge is stored as **[engrams](https://plur.ai/spec.html)** — small, typed assertions that carry their own activation metadata. Each engram has:

- **Statement** — the actual knowledge: a correction, preference, convention, or architectural decision
- **Activation** — retrieval strength that decays over time (ACT-R exponential decay with 5% floor) and strengthens on access
- **Feedback signals** — positive/negative ratings from the agent or user that train injection quality
- **Scope** — hierarchical namespace (`global`, `project:myapp`, `agent:claude-code`) controlling where the engram applies
- **Associations** — links to other engrams, including co-access edges that form automatically when engrams are recalled together

The lifecycle is simple:

```
You correct your agent  →  engram created  →  YAML on your disk
Next session starts     →  relevant engrams injected  →  agent remembers
You rate the result     →  engram strengthens or decays  →  quality improves
Unused engrams          →  activation decays  →  naturally fade from injection
```

Search is fully local: BM25 (with IDF weighting, TF saturation, length normalization) + BGE embeddings + Reciprocal Rank Fusion. Zero API calls. 86.7% on LongMemEval — on par with cloud-based solutions that charge per query.

See the [full engram spec](https://plur.ai/spec.html) for schema details, activation model, and injection algorithm.

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
| `plur_learn` | Store a correction, preference, or convention |
| `plur_recall_hybrid` | Retrieve relevant memories (BM25 + embeddings) |
| `plur_inject_hybrid` | Select engrams for current task within token budget |
| `plur_feedback` | Rate relevance (trains quality over time) |
| `plur_forget` | Retire a memory |
| `plur_ingest` | Extract engrams from text |
| `plur_sync` | Sync across devices via git |
| `plur_status` | Check system health and engram counts |

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

## What PLUR is — and isn't

PLUR is **agent memory** — it stores corrections, preferences, conventions, and architectural decisions that an AI agent learns during work sessions, and injects them back when they're relevant.

PLUR is **not** a general-purpose search engine, a codebase indexer, or a replacement for code intelligence tools. It doesn't parse ASTs, navigate class hierarchies, or search your source files. If you need code-aware search (tree-sitter, language server features, symbol lookup), tools like [claude-mem](https://github.com/skydeckai/claude-mem) or your IDE's built-in search are the right choice.

The two are complementary:

| | PLUR | Code intelligence tools |
|---|------|------------------------|
| **Stores** | Learned corrections, preferences, conventions | Code structure, symbols, definitions |
| **Search** | Engram recall (BM25 + embeddings over memory) | AST traversal, symbol lookup, semantic code search |
| **Learns** | From agent corrections, feedback, usage patterns | From static analysis of source code |
| **Decays** | Yes — unused memories fade (ACT-R model) | No — code index reflects current state |
| **Cross-tool** | Any MCP client (Claude Code, Cursor, Windsurf, OpenClaw) | Typically tied to one tool |

While search is a core part of PLUR (finding the right engram to inject), the search targets are always engrams — not files, not code, not documents. PLUR's hybrid search (BM25 + embeddings + RRF) is optimized for short natural-language assertions, not source code.

## Packages

| Package | Description |
|---------|-------------|
| [`@plur-ai/core`](packages/core) | Engram engine — learn, recall, inject, search, decay |
| [`@plur-ai/mcp`](packages/mcp) | MCP server for Claude Code, Cursor, Windsurf |
| [`@plur-ai/claw`](packages/claw) | OpenClaw ContextEngine plugin |
| [`plur-hermes`](packages/hermes) | Hermes Agent plugin (Python, via CLI bridge) |

## Architecture

```
@plur-ai/core
├── engrams.ts           CRUD + YAML persistence
├── fts.ts               BM25 with IDF, TF saturation (k1/b), length normalization
├── embeddings.ts        BGE-small-en-v1.5, 384-dim, local ONNX
├── hybrid-search.ts     Reciprocal Rank Fusion
├── inject.ts            Context-aware selection + spreading activation
├── decay.ts             ACT-R activation decay
├── secrets.ts           Secret detection (API keys, passwords, tokens)
├── sync.ts              Git-based sync + file locking (O_EXCL)
├── storage.ts           Path detection + YAML I/O
└── storage-indexed.ts   Optional SQLite read index

@plur-ai/mcp          Wraps core as MCP tools
@plur-ai/claw          OpenClaw ContextEngine hooks (assemble/compact/afterTurn)
plur-hermes            Python plugin for Hermes Agent (CLI subprocess bridge)
```

### Storage

Everything is plain YAML. Open it, read it, edit it.

```
~/.plur/
├── engrams.yaml     # learned knowledge (source of truth)
├── episodes.yaml    # session timeline
├── config.yaml      # settings
└── engrams.db       # optional SQLite read index (auto-generated)
```

`PLUR_PATH` overrides the default location.

For large stores (>1k engrams), enable the SQLite read index for faster filtered queries. Add `index: true` to `config.yaml`. The YAML file stays the source of truth — the `.db` is a cache that rebuilds automatically. Delete it anytime.

## Requirements

- **Node.js 18+**
- **2GB RAM minimum** — the embedding model (ONNX runtime) needs ~1GB for installation. On servers with less RAM, embeddings are skipped and search falls back to BM25 keyword matching.

## Development

```bash
git clone https://github.com/plur-ai/plur.git
cd plur
pnpm install && pnpm build && pnpm test
```

~340 tests across 27 files. `pnpm test:watch` for development.

## Contributing

- **Bug reports** — issue with reproduction steps
- **Feature requests** — issue describing the use case
- **Code** — fork, branch, PR. Tests required.
- **Integrations** — build PLUR support for other tools

Before submitting: `pnpm test` passes, `pnpm build` succeeds, no new external deps in core without discussion.

Conventions: TypeScript, Zod validation, Vitest, no external APIs in core, YAML storage, zero-cost search by default.

## License

Apache-2.0
