# plur-hermes

Persistent memory plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent). Your agent corrected on Monday remembers on Tuesday.

## Install

```bash
pip install plur-hermes
```

That's it. The plugin is auto-discovered by Hermes on startup. No other install needed.

## What happens

Once installed, PLUR runs invisibly in the background:

- **Every turn**: relevant memories are injected into the agent's context (via `pre_llm_call` hook)
- **Every response**: corrections and insights are captured automatically (via `post_llm_call` hook)
- **Every session**: episodes are recorded to a timeline (via `on_session_end` hook)

The agent also gets 16 tools it can call explicitly:

| Tool | What it does |
|------|-------------|
| `plur_learn` | Store a correction, preference, or pattern |
| `plur_recall` | Search memories by topic |
| `plur_inject` | Get relevant context for a task |
| `plur_list` | List all stored engrams |
| `plur_forget` | Retire outdated knowledge |
| `plur_feedback` | Rate a memory (trains what surfaces next time) |
| `plur_capture` | Record an episode |
| `plur_timeline` | Query past episodes |
| `plur_status` | Health check |
| `plur_sync` | Cross-device sync via git |
| `plur_packs_list` | List installed knowledge packs |
| `plur_packs_install` | Install a community knowledge pack |
| `plur_extract_meta` | Distill cross-domain principles from your memories |
| `plur_meta_engrams` | List extracted meta-engrams |
| `plur_meta_submit_analysis` | Continue multi-turn extraction |
| `plur_validate_meta` | Test a principle against a new domain |

## How it works

Knowledge is stored as **engrams** — small assertions that strengthen with use and decay when irrelevant. Storage is plain YAML on disk at `~/.plur/`. Search is fully local (BM25 + embeddings). Zero API calls, zero cloud, works offline.

The plugin calls the [PLUR CLI](https://www.npmjs.com/package/@plur-ai/cli) under the hood via subprocess. If the CLI isn't installed globally, it auto-resolves via `npx` on first use (cached after that).

## What makes PLUR different from Hermes built-in memory

Hermes has MEMORY.md (2,200 chars) and session search (FTS5). PLUR adds:

- **Feedback-trained retrieval** — rate memories, good ones surface more, bad ones fade
- **Forgetting** — retire outdated knowledge instead of growing forever
- **Hybrid search** — BM25 + local embeddings + Reciprocal Rank Fusion
- **Cross-device sync** — git-based, works across machines
- **Meta-engram extraction** — distill transferable principles across domains
- **Knowledge packs** — share curated engrams between agents

PLUR sits alongside Hermes memory, not replacing it. Your MEMORY.md and USER.md continue to work as before.

## Configuration

The plugin works with zero configuration. Optional env vars:

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUR_PATH` | `~/.plur` | Storage directory |
| `PLUR_INJECT_MODE` | `fast` | Set to `hybrid` for embedding-based injection (slower, more accurate) |

## Requirements

- Hermes Agent v0.5.0+
- Python 3.10+
- Node.js 18+ (for CLI, auto-resolved via npx if not installed globally)

## Links

- [PLUR.ai](https://plur.ai)
- [GitHub](https://github.com/plur-ai/plur)
- [@plur-ai/cli](https://www.npmjs.com/package/@plur-ai/cli) — standalone CLI
- [@plur-ai/mcp](https://www.npmjs.com/package/@plur-ai/mcp) — MCP server for Claude Code, Cursor, Windsurf
- [@plur-ai/claw](https://www.npmjs.com/package/@plur-ai/claw) — OpenClaw plugin

## License

Apache-2.0
