# PLUR for Claude Code

Give Claude Code persistent memory. Corrections, preferences, and conventions
persist across sessions — stored as plain YAML on your disk, with zero-cost
local search.

## Install

One command sets up storage, MCP config, and Claude Code hooks for automatic
engram injection:

```bash
npx @plur-ai/mcp init
```

This creates `~/.plur/`, adds PLUR to your `.mcp.json`, and installs the hooks.
PLUR is installed **globally** — one MCP server, one store, available in every
project. You only run init once.

## Verify

Ask Claude: *"What's my PLUR status?"* — it should call `plur_status` and return
your engram count and storage path.

Full docs → [plur.ai](https://plur.ai) · [Engram spec](https://plur.ai/spec.html)
