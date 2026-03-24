# @plur-ai/claw

Persistent memory for [OpenClaw](https://openclaw.com) agents — fully automatic. Your agents remember corrections, learn preferences, and build knowledge across sessions. No workflow changes needed.

Part of [PLUR](https://plur.ai) — where **Haiku with memory outperforms Opus without it** at 10x less cost.

## Setup (30 seconds)

```bash
npm install @plur-ai/claw
```

```json
{
  "plugins": ["@plur-ai/claw"]
}
```

That's it. Every agent session now has persistent memory.

## What happens automatically

Once installed, PLUR works invisibly in the background:

**Session start** — Relevant memories from past sessions are injected into the agent's context, ranked by relevance and activation strength, within the token budget. Your agent starts every conversation already knowing what it learned before.

**During conversation** — User messages are scanned for corrections ("actually, use X not Y") and preferences ("I always want..."). High-confidence learnings are saved automatically.

**After each turn** — The agent's response is scanned for self-reported learnings (the `🧠 I learned:` format). Each turn is summarized and appended to the episodic timeline.

**During compaction** — Before context is compacted, learnings are extracted first. Nothing is lost.

**Subagent spawn** — Child agents inherit the parent session's memory scope.

The result: your agents get smarter with every conversation, without you doing anything.

## How it works

Knowledge is stored as **engrams** — small assertions that strengthen with use and decay when irrelevant, modeled on how human memory works. Search is fully local (BM25 + embeddings), so memory recall costs nothing and works offline.

```
User corrects the agent  →  engram created       →  YAML on disk
Next session starts      →  relevant ones injected →  agent remembers
Agent rates the result   →  engram strengthens    →  quality improves
```

**86.7% on LongMemEval** — on par with cloud memory services that charge per query.

## Adding explicit memory tools

The plugin handles the automatic lifecycle (inject, capture, learn). For explicit tools the agent can call on demand — `plur.learn`, `plur.recall`, `plur.sync` — add the MCP server alongside:

```json
{
  "mcpServers": {
    "plur": { "command": "npx", "args": ["-y", "@plur-ai/mcp"] }
  },
  "plugins": ["@plur-ai/claw"]
}
```

This gives agents both automatic memory (plugin) and on-demand memory tools (MCP).

## SYSTEM.md

On first run, the plugin appends memory instructions to your workspace `SYSTEM.md`. This teaches agents the `🧠 I learned:` format and how to use PLUR tools. Appended once, never overwrites existing content.

## Configuration

```typescript
import { PlurContextEngine } from '@plur-ai/claw'

new PlurContextEngine({
  path: '/custom/storage/path',  // default: ~/.plur/
  auto_learn: true,              // extract learnings automatically (default: true)
  auto_capture: true,            // record episodic summaries (default: true)
  injection_budget: 2000,        // token budget for engram injection (default: 2000)
})
```

Everything is stored as plain YAML in `~/.plur/`. Open it, read it, edit it. Override with `PLUR_PATH` env var.

## Benchmark

| Metric | Score |
|--------|-------|
| LongMemEval overall | **86.7%** |
| A/B win rate vs no memory | 89% |
| House rules accuracy | 100% |

[Full methodology →](https://plur.ai/benchmark.html)

## Related packages

| Package | For |
|---------|-----|
| [`@plur-ai/mcp`](https://www.npmjs.com/package/@plur-ai/mcp) | Claude Code, Cursor, Windsurf (MCP server) |
| [`@plur-ai/core`](https://www.npmjs.com/package/@plur-ai/core) | Engine — use directly in custom agent frameworks |

## License

Apache-2.0 · [GitHub](https://github.com/plur-ai/plur) · [plur.ai](https://plur.ai)
