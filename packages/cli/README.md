# @plur-ai/cli

Persistent memory for AI agents — from the command line.

PLUR stores corrections, preferences, and patterns as **engrams** that strengthen with use and decay when irrelevant. The CLI gives you direct access to the engram engine from your terminal, scripts, and automation.

## Install

```bash
npm install -g @plur-ai/cli
```

Or use without installing:

```bash
npx @plur-ai/cli status
```

> ### Known issue: avoid `0.9.2` on npm
>
> The currently published `@plur-ai/cli@0.9.2` (latest tag on npm) is bricked — every command throws `{"error":"Dynamic require of \"os\" is not supported"}` due to an esbuild bundling regression. The fix is on `main` as `0.9.3` (see commit `7af15a8`) and a CI regression guard is now in place ([#68](https://github.com/plur-ai/plur/pull/68)), but the `0.9.3` artifact has not yet shipped to npm — tracking in [#59](https://github.com/plur-ai/plur/issues/59).
>
> **Workaround until `0.9.3` is published:** install the prior working version `npm install -g @plur-ai/cli@0.9.1`, or run from source by cloning the repo and `pnpm install && pnpm --filter @plur-ai/cli build`.

## Quick Start

```bash
# Install Claude Code hooks (automatic memory injection)
plur init

# Store a learning
plur learn "Always validate user input at API boundaries"

# Search memories
plur recall "validation"

# Get relevant context for a task
plur inject "fix the auth bug"

# List all engrams
plur list

# Give feedback (trains what surfaces next time)
plur feedback ENG-2026-0329-001 positive

# Retire outdated knowledge
plur forget ENG-2026-0329-001
```

## Commands

| Command | Description |
|---------|-------------|
| `plur learn <statement>` | Create a new engram |
| `plur recall <query>` | Search engrams (hybrid: BM25 + embeddings) |
| `plur inject <task>` | Get relevant engrams for a task (three-tier output) |
| `plur list` | List all engrams with optional filtering |
| `plur forget <id>` | Retire an engram |
| `plur feedback <id> <signal>` | Rate an engram (positive/negative/neutral) |
| `plur capture <summary>` | Record an episode to the timeline |
| `plur timeline [query]` | Query the episodic timeline |
| `plur status` | System health check |
| `plur sync` | Cross-device sync via git |
| `plur packs list` | List installed engram packs |
| `plur packs install <source>` | Install an engram pack |
| `plur init` | Install Claude Code hooks for automatic injection |

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Force JSON output (auto-detected when piped) |
| `--path <dir>` | Override storage path (default: `~/.plur`) |
| `--fast` | BM25-only search (skip embeddings, faster) |
| `--quiet` | Suppress non-essential output |

## JSON Output

Output is automatically JSON when piped, human-readable in a terminal:

```bash
# Human-readable
plur recall "testing"

# JSON (piped)
plur recall "testing" | jq '.results[0].statement'

# Force JSON
plur recall "testing" --json
```

## Use with AI Agents

The CLI is the universal bridge for AI agent integrations. It's used by:

- **[plur-hermes](https://pypi.org/project/plur-hermes/)** — Hermes Agent plugin (auto-installs via npx if not found)
- **[@plur-ai/mcp](https://www.npmjs.com/package/@plur-ai/mcp)** — MCP server for Claude Code, Cursor, Windsurf
- **[@plur-ai/claw](https://www.npmjs.com/package/@plur-ai/claw)** — OpenClaw plugin

## How It Works

Engrams are stored as plain YAML at `~/.plur/`. Search is fully local — BM25 keyword matching plus BGE-small embeddings with Reciprocal Rank Fusion. Zero API calls, zero cloud, works offline.

The `--fast` flag skips embedding model loading (~2s) and uses BM25 only — useful for scripts and automation where speed matters more than semantic similarity.

## License

Apache-2.0
