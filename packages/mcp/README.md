# @plur-ai/mcp

Give your AI agent persistent memory. One line in your MCP config — corrections, preferences, and conventions persist across sessions. No workflow changes, no cloud, no API costs for search.

Part of [PLUR](https://plur.ai) — where, in our tool-routing and local-knowledge benchmark, **Haiku with memory outperformed Opus without it** at 10x less cost.

## Setup (30 seconds)

### Claude Code

One command — sets up storage, MCP config, and hooks:

```bash
npx @plur-ai/mcp init
```

Restart Claude Code. Done. Your agent now has persistent memory with automatic injection.

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

Knowledge is stored as **engrams** — small assertions that strengthen with use and decay when irrelevant. Search runs locally (BM25 + embeddings); with a PLUR Enterprise store configured, recall also makes one live, timeout-bounded call per relevant remote host and merges the team's engrams in — and tells you, per host, when that leg is degraded instead of failing silently. Without a remote store it is fully local, costs nothing, and works offline. [Benchmark methodology →](https://plur.ai/benchmark.html)

## Tools

By default (lean profile), your agent gets 12 tools. Everything else is reachable through `plur_admin`:

| Tool | What it does |
|------|-------------|
| `plur_session_start` | Start a session — injects relevant engrams for your task |
| `plur_learn` | Store a memory — correction, preference, convention, or decision |
| `plur_recall` | **Best default** — hybrid (BM25 + embeddings via RRF) by default; pass `mode:"keyword"` for BM25-only. Zero cost. |
| `plur_feedback` | Rate a memory — trains relevance over time |
| `plur_forget` | Retire a memory (history preserved) |
| `plur_session_end` | End a session — captures summary and new learnings |
| `plur_status` | System health |
| `plur_doctor` | Diagnose embedder, hybrid search, and remote-store auth |
| `plur_receipt` | Show why a memory was injected — the evidence behind a recall |
| `plur_packs_uninstall` | Remove an installed pack |
| `plur_tensions_purge` | Clear stale/resolved tensions |
| `plur_admin` | Dispatch to any other tool: `{ action: "plur_packs_install", args: {...} }` |

Less commonly needed tools (`plur_recall_hybrid`, `plur_inject_hybrid`, `plur_learn_batch`, `plur_ingest`, `plur_sync`, `plur_packs_install`, `plur_packs_list`, `plur_capture`, `plur_timeline`, and more) are all reachable via `plur_admin`. Set `PLUR_TOOL_PROFILE=full` to expose all 43 tools directly.

A `plur_*` name missing from `tools/list` means it moved behind the gateway, not that the server is down. `plur_admin { action: "help" }` returns every action with a one-line description and its argument schema; `plur_doctor` reports the same inventory as `tool_surface`.

## Sync across machines

Your agent can sync memory to any git remote:

```
Agent: plur_sync({ remote: "git@github.com:you/plur-memory.git" })
→ "Initialized and pushed."

# On another machine, same remote:
Agent: plur_sync()
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

**Retrieval** (LongMemEval R@5): **76.7%** out-of-the-box · **97.0%** with openai-3-large embeddings

**Agent task impact:** Haiku + PLUR outperforms Opus *without* memory at ~10× less cost. House rules: **12–0** across Haiku, Sonnet, Opus. A/B win rate: **89%**.

[Full methodology →](https://plur.ai/benchmark.html)

## Related packages

| Package | For |
|---------|-----|
| [`@plur-ai/core`](https://www.npmjs.com/package/@plur-ai/core) | Engine — use directly in custom agent frameworks |
| [`@plur-ai/claw`](https://www.npmjs.com/package/@plur-ai/claw) | OpenClaw — automatic memory without MCP |

## License

Apache-2.0 · [GitHub](https://github.com/plur-ai/plur) · [plur.ai](https://plur.ai)
