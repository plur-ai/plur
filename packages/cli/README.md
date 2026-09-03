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

## Quick Start

```bash
# Install Claude Code hooks + local hook binary (automatic memory injection)
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
| `plur ui` | Open the memory viewer in a browser |
| `plur sync` | Cross-device sync via git (engram data only — secrets and derived files are never committed) |
| `plur packs list` | List installed engram packs |
| `plur packs install <source>` | Install an engram pack |
| `plur import --from <source> --path <file>` | Import memories from another system (see below) |
| `plur init` | Install Claude Code hooks + local hook binary for automatic injection |
| `plur doctor` | Diagnose installation health (hooks, MCP, shim, embedder) |

## The memory viewer

```bash
plur ui                    # opens http://127.0.0.1:7777/ in your browser
plur ui --port 8080        # somewhere else
plur ui --no-open          # print the URL, don't launch a browser
```

A local page listing every engram: what was learned, what actually gets
recalled, and how often, plus a written-per-day chart and the most-recalled
list. Selecting a row expands the whole engram.

Read-only — browsing memory never mutates it, including through a lazy write
path such as decay. Available in English and 中文; it follows your browser's
`Accept-Language`, or force it with `?lang=zh`.

Binds `127.0.0.1` by default and deliberately: the viewer serves your entire
memory store with **no authentication**.

`--host` widens the bind and carries two risks you should understand before
using it:

- **Direct access** — anyone on your network can reach the port and read every
  engram. No credentials. No rate limit.
- **DNS rebinding** — any website you visit while the viewer runs can rebind its
  own domain to your machine's address and read the store cross-origin. The
  rebinding check (Host-header validation) blocks the known attack vector by
  only accepting the server's own addresses, but it does not make the exposure
  safe. A compromised network or a browser vulnerability can still bypass it.

Only run widened (`--host 0.0.0.0` or a LAN address) on a network you fully
control, and stop the viewer when you are done.

## Importing from other memory systems

Bring existing memory with you — `plur import` migrates competitor exports
into engrams, routed through the same dedup gates as `plur learn` (duplicates
are skipped, never re-added), and prints a migration report: N imported,
M skipped (dedup), K conflicts.

```bash
# Gentleman-Programming/engram (Go + SQLite memory tool)
plur import --from gp-engram --path ~/.engram/engram.db

# mem0 JSON export (Memory.get_all() shape)
plur import --from mem0 --path ./memories.json

# Any JSON / JSONL / CSV export, optionally with a field-mapping config
plur import --from generic --path ./export.csv
plur import --from generic --path ./export.json --mapping ./mapping.json

# Preview without writing
plur import --from mem0 --path ./memories.json --dry-run
```

Flags: `--dry-run` (report only), `--scope <scope>` (force a scope for all
imported engrams), `--mapping <file>` (generic only: `{"fields": {"statement":
"text", "domain": "meta.area"}, "defaults": {...}}` with dot-path support).

> Note: for `import`, `--path` is the **input file** (per the issue spec);
> use `--store <dir>` to override the storage directory instead.

Temporal metadata is preserved where the source has it (`created_at` →
`temporal.learned_at`, last access → `activation.last_accessed`, expiry →
`temporal.valid_until`). Zep and Letta adapters are registered but stubbed —
export to JSON and use `--from generic` in the meantime.

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Force JSON output (auto-detected when piped) |
| `--path <dir>` | Override storage path (default: `~/.plur`) |
| `--fast` | BM25-only search (skip embeddings, faster) |
| `--quiet` | Suppress non-essential output (see below) |

### What `--quiet` suppresses

`--quiet` silences chatter, not answers:

- **Suppressed** — progress lines, confirmations of requested mutations
  (`Learned: …`, `Feedback recorded`), banners, hints/next-step suggestions,
  summary footers (`Total: 5`).
- **Preserved** — the primary output (recall results, listings, status
  fields, doctor/audit reports), warnings that the outcome differs from what
  was requested (e.g. a scope demotion, a failed index rebuild), all errors
  (stderr), exit codes, and `--json` output (unaffected by `--quiet`).

```bash
plur learn "prefer tabs" --quiet        # exit 0, no output
plur recall "tabs" --quiet              # results still print
plur sync --quiet                       # silent unless the index broke
```

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
