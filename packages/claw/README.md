# @plur-ai/claw

**Engram exchange layer for OpenClaw agents. Local-first data control. No cloud routing, no API key, data never leaves your machine.**

Your agents remember corrections, learn preferences, and build knowledge across sessions — stored as open YAML files in `~/.plur/`, not in a cloud.

Part of [PLUR](https://plur.ai) — the engram exchange layer connecting agents across tools. Compatible with the MCP server ([`@plur-ai/mcp`](https://npmjs.com/package/@plur-ai/mcp)) for Claude Code, Cursor, and Windsurf. In our benchmark, **Haiku with PLUR memory outperformed Opus without it** at 10x less cost.

## Why PLUR vs cloud memory plugins

| | PLUR | Cloud alternatives |
|---|---|---|
| **Data location** | `~/.plur/` on your disk | Third-party cloud servers |
| **API key required** | No | Yes |
| **Latency** | Local, sub-ms recall | Network round-trip per turn |
| **Privacy** | Your conversations never leave your machine | Routed through provider |
| **Format** | Open YAML — readable by any tool | Proprietary |
| **Pack ecosystem** | Installable knowledge packs | Not available |

Memory is shared with every PLUR-compatible tool: Claude Code, Cursor, Windsurf. One store, all agents.

## Setup (30 seconds)

```bash
openclaw plugins install @plur-ai/claw
npx @plur-ai/claw setup
```

`setup` enables the plugin in `~/.openclaw/openclaw.json`, assigns it to the memory slot, and (if you've opted into a community allowlist) adds `plur-claw` to it. Restart the OpenClaw gateway and every agent session now has persistent memory.

If you'd rather configure by hand, the equivalent edit to `~/.openclaw/openclaw.json` is:

```json
{
  "plugins": {
    "entries": {
      "plur-claw": { "enabled": true }
    },
    "slots": {
      "memory": "plur-claw"
    }
  }
}
```

### Troubleshooting activation

If `setup` ran but PLUR still isn't active, two read/fix tools ship with the package:

```bash
npx @plur-ai/claw doctor          # read-only: reports which step is failing
npx @plur-ai/claw setup --repair  # re-runs only the failing steps, preserves the rest
```

`doctor` walks the full activation chain — `package_present` → `plugin_discovered` → `plugin_enabled` → `slot_selected` → `reload_required` → `runtime_registered` — and names the specific step that's off, along with whether the fix is on `setup`, on upstream `openclaw`, or a human judgment call (slot owned by another plugin). `setup --repair` then fixes only the steps `doctor` flagged, leaving healthy config fields byte-identical.

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

Search is independently benchmarked. [Methodology →](https://plur.ai/benchmark.html)

## Adding explicit memory tools

The plugin handles the automatic lifecycle (inject, capture, learn). For explicit tools the agent can call on demand — `plur.learn`, `plur.recall`, `plur.sync` — add the MCP server alongside:

```json
{
  "mcpServers": {
    "plur": { "command": "npx", "args": ["-y", "@plur-ai/mcp"] }
  },
  "plugins": {
    "entries": {
      "plur-claw": { "enabled": true }
    }
  }
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

**Retrieval** (LongMemEval R@5): **76.7%** out-of-the-box · **97.0%** with openai-3-large embeddings

**Agent task impact:** Haiku + PLUR outperforms Opus *without* memory at ~10× less cost. House rules: **12–0** across Haiku, Sonnet, Opus. A/B win rate: **89%**.

[Full methodology →](https://plur.ai/benchmark.html)

## Related packages

| Package | For |
|---------|-----|
| [`@plur-ai/mcp`](https://www.npmjs.com/package/@plur-ai/mcp) | Claude Code, Cursor, Windsurf (MCP server) |
| [`@plur-ai/core`](https://www.npmjs.com/package/@plur-ai/core) | Engine — use directly in custom agent frameworks |

## License

Apache-2.0 · [GitHub](https://github.com/plur-ai/plur) · [plur.ai](https://plur.ai)
