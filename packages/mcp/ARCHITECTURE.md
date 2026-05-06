# Architecture

`@plur-ai/mcp` exposes `@plur-ai/core` as a Model Context Protocol server.
It's a thin adapter — almost all logic lives in core. This package owns:
the MCP transport, the tool-definition surface, the `init` and setup CLI,
and the auto-update / config bootstrap.

For the user-facing intro see [README.md](README.md). For the engine see
[`packages/core/ARCHITECTURE.md`](../core/ARCHITECTURE.md).

## The shape, in one paragraph

`server.ts` constructs an `@modelcontextprotocol/sdk` `Server`, registers
the tool list from `tools.ts`, dispatches each call into a `Plur`
instance from `@plur-ai/core`. `index.ts` is the CLI entry point — it
runs the stdio MCP transport for normal use, and exposes `init`,
`mcp-config`, `doctor`, and `update` commands for setup / diagnostics.
There is no HTTP, no auth, no scopes — this is single-user local memory
exposed to a single client per process.

## Top-level layout

```
src/
├── index.ts        # CLI entry point — stdio transport + setup commands
├── server.ts       # createServer() — wires Plur instance into MCP Server
└── tools.ts        # All tool definitions — JSON schemas + handlers
```

That's the whole package. Three files, ~2200 lines total — most of which
is tool definitions in `tools.ts`.

## CLI surface (`index.ts`)

`bin: plur` in `package.json`. Invocations:

| Invocation | What it does |
|---|---|
| `npx @plur-ai/mcp` (no args) | Run as MCP server over stdio (the default for MCP clients) |
| `npx @plur-ai/mcp init` | One-shot setup: create `~/.plur/`, register MCP config, install hooks |
| `npx @plur-ai/mcp mcp-config` | Print the JSON snippet to paste into a custom MCP client |
| `npx @plur-ai/mcp doctor` | Diagnose: storage exists? Embeddings model present? Hooks installed? |
| `npx @plur-ai/mcp update` | Self-update via `npm install -g @plur-ai/mcp@latest` |

`init` is idempotent — re-running it is safe and will just confirm
existing setup.

## MCP server (`server.ts`)

`createServer({ plurPath })` returns an MCP `Server` ready to be
attached to a transport. Steps:

1. Instantiate `Plur` from `@plur-ai/core` with the resolved storage path
2. Register the tool list (`ListToolsRequestSchema`)
3. Register the dispatch handler (`CallToolRequestSchema`) — looks up
   the tool by name, validates args against its Zod schema, calls the
   handler, returns the result
4. Surface a `Resources` listing for inspection (engram counts, recent
   episodes) — read-only

The same `createServer()` is used in two contexts:
- stdio transport (default — MCP clients spawn the binary)
- in-process tests in `test/server.test.ts`

## Tool surface (`tools.ts`)

Each tool is an object with:

```ts
{
  name: 'plur_recall',
  description: '...',
  inputSchema: z.object({ ... }),
  handler: async (plur, args) => { ... }
}
```

Tool families (~20 tools total):

| Family | Tools |
|---|---|
| Lifecycle | `plur_session_start`, `plur_session_end` |
| Learning | `plur_learn`, `plur_capture`, `plur_ingest`, `plur_extract_meta` |
| Recall | `plur_recall`, `plur_recall_hybrid`, `plur_inject`, `plur_inject_hybrid`, `plur_similarity_search` |
| Lifecycle (engram) | `plur_forget`, `plur_pin`, `plur_promote`, `plur_feedback`, `plur_history` |
| Multi-store | `plur_stores_add`, `plur_stores_list` |
| Packs | `plur_packs_install`, `plur_packs_list`, `plur_packs_export`, `plur_packs_discover`, `plur_packs_preview`, `plur_packs_uninstall` |
| Diagnostics | `plur_status`, `plur_doctor`, `plur_profile`, `plur_timeline`, `plur_tensions`, `plur_meta_engrams` |
| Sync / maintenance | `plur_sync`, `plur_sync_status`, `plur_batch_decay`, `plur_validate_meta`, `plur_episode_to_engram`, `plur_report_failure` |

When adding a new tool: define it in `tools.ts`, write the Zod schema
(MCP clients use the schema to format args), add the test in
`test/server.test.ts`. The handler should be a thin call into a `Plur`
method — heavy logic belongs in core.

### Tool design rules

- **Names are stable contracts** — agents call them by name, renaming
  breaks every existing PLUR install
- **Args are validated by Zod** — the handler can trust them; reject at
  the schema, not in the handler body
- **Errors return as MCP error responses**, never throw — the SDK
  translates throws into protocol errors with bad UX
- **Results are JSON-serializable** — no Date objects, no Buffers; the
  protocol round-trips strings + numbers + arrays + objects

## Setup flow (`init` command)

`npx @plur-ai/mcp init` is the customer-facing onboarding magic. Steps:

1. **Detect host**: Claude Code? Cursor? Windsurf? Generic MCP? Each has
   a different config file location and format
2. **Create storage**: `~/.plur/` with empty `engrams.yaml`,
   `episodes.yaml`, `config.yaml`
3. **Register MCP server**: write the appropriate JSON into the host's
   MCP config (`~/.claude/settings.json`, `.cursor/mcp.json`, etc.)
4. **Install hooks** (Claude Code only): `SessionStart` hook auto-calls
   `plur_session_start`, `PreToolUse` guard ensures the call happens
   before any other tool
5. **Print next steps** — restart instructions, doctor command

`init` reads existing configs and merges — it never blindly overwrites.

## Versioning

The version constant lives in **four places** in this package:

1. `package.json` — `version`
2. `src/server.ts` — `const VERSION` (returned in `plur_status`)
3. `src/index.ts` — `const VERSION` (CLI `--version`)
4. `test/server.test.ts` — assertion in version test

Plus the monorepo CLAUDE.md tracks 5 more places across core/claw/json
for a total of 9. Miss one and either the CLI lies or the test fails.

`npx @plur-ai/mcp update` triggers a global re-install at the latest
version; the host MCP client picks it up on next session start.

## What's NOT here

- **No engine code** — that's `@plur-ai/core`. This package's `Plur` is
  just an instance of core's class.
- **No HTTP transport** — only stdio. Multi-user / network use is PLUR
  Enterprise.
- **No auth or scopes-as-permissions** — single-user local. Scope is
  just a string for organisation.
- **No LLM client** — `recallAsync` / `recallExpanded` need an LLM, but
  the model lives in the host (the agent calling the tool already has
  one); core's `model-routing.ts` resolves which one.
- **No plugin host integration** — that's `@plur-ai/claw` for OpenClaw.

## See also

- [README.md](README.md) — public-facing intro
- [`packages/core/ARCHITECTURE.md`](../core/ARCHITECTURE.md) — engine
- [`packages/claw/ARCHITECTURE.md`](../claw/ARCHITECTURE.md) — sibling adapter
- [Model Context Protocol spec](https://modelcontextprotocol.io)
