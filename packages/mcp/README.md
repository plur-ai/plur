# @plur-ai/mcp

Give your AI agent persistent memory. One line in your MCP config — corrections, preferences, and conventions persist across sessions. No workflow changes, no cloud, no API costs for search.

Part of [PLUR](https://plur.ai) — where **Haiku with memory outperforms Opus without it** at 10x less cost.

## Setup (30 seconds)

### Claude Code

Add to `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "plur": { "command": "npx", "args": ["-y", "@plur-ai/mcp"] }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "plur": { "command": "npx", "args": ["-y", "@plur-ai/mcp"] }
  }
}
```

### Windsurf / any MCP client

Same pattern — point it at `npx -y @plur-ai/mcp`.

That's it. Your agent now has memory. Use your tools as usual — corrections accumulate automatically.

## What happens

```
You correct your agent  →  engram created       →  YAML on your disk
Next session starts     →  relevant ones injected →  agent remembers
You rate the result     →  engram strengthens    →  quality improves
```

Knowledge is stored as **engrams** — small assertions that strengthen with use and decay when irrelevant. Search is fully local (BM25 + embeddings), so memory recall costs nothing and works offline. **86.7% on LongMemEval** — on par with cloud memory services.

## Tools

Your agent gets these tools automatically:

| Tool | What it does |
|------|-------------|
| `plur.learn` | Store a memory — correction, preference, convention, or decision |
| `plur.recall` | Keyword search (BM25, instant) |
| `plur.recall.hybrid` | **Best default** — BM25 + embeddings merged via RRF. Zero cost. |
| `plur.inject` | Load relevant memories for the current task |
| `plur.feedback` | Rate a memory — trains relevance over time |
| `plur.forget` | Retire a memory (history preserved) |
| `plur.sync` | Sync memory across machines via git |
| `plur.sync.status` | Check sync state |
| `plur.capture` | Record a session event |
| `plur.timeline` | Query session history |
| `plur.ingest` | Extract learnings from text |
| `plur.packs.install` | Install a shareable memory pack |
| `plur.packs.list` | List installed packs |
| `plur.status` | System health |

## Sync across machines

Your agent can sync memory to any git remote:

```
Agent: plur.sync({ remote: "git@github.com:you/plur-memory.git" })
→ "Initialized and pushed."

# On another machine, same remote:
Agent: plur.sync()
→ "Synced. Pulled 12 remote commits."
```

Works with GitHub, GitLab, Gitea, any git host. Your data, your repo.

## Configuration

Custom storage path:

```json
{
  "mcpServers": {
    "plur": {
      "command": "npx",
      "args": ["-y", "@plur-ai/mcp"],
      "env": { "PLUR_PATH": "/path/to/storage" }
    }
  }
}
```

Default: `~/.plur/`. Everything is plain YAML — open it, read it, edit it.

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
| [`@plur-ai/core`](https://www.npmjs.com/package/@plur-ai/core) | Engine — use directly in custom agent frameworks |
| [`@plur-ai/claw`](https://www.npmjs.com/package/@plur-ai/claw) | OpenClaw — automatic memory without MCP |

## License

Apache-2.0 · [GitHub](https://github.com/plur-ai/plur) · [plur.ai](https://plur.ai)
