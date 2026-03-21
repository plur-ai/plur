# PLUR — Shared Memory for AI Agents

Give any AI agent persistent memory that learns, recalls, and grows.

## Packages

| Package | Description | Install |
|---------|-------------|---------|
| [@plur-ai/core](packages/core) | Engram engine — learn, recall, forget, feedback | `npm install @plur-ai/core` |
| [@plur-ai/mcp](packages/mcp) | MCP server — memory tools for Claude Code, Cursor, any MCP client | `npm install -g @plur-ai/mcp` |
| [@plur-ai/claw](packages/claw) | OpenClaw plugin — persistent memory as a ContextEngine | `npm install @plur-ai/claw` |

## Quick Start

### Any MCP-compatible tool (Claude Code, Cursor, etc.)

```bash
npm install -g @plur-ai/mcp
```

Add to your MCP config:

```json
{ "mcpServers": { "plur": { "command": "plur-mcp" } } }
```

### OpenClaw

```bash
npm install @plur-ai/claw
```

Register the plugin in your OpenClaw config and PLUR memory runs automatically on every session.

Done. Your agent now has persistent memory.

## What It Does

- **Learns** from corrections, decisions, and preferences
- **Recalls** relevant knowledge at the start of each session
- **Forgets** outdated information (retire, not delete)
- **Shares** knowledge via installable packs

## How It Works

PLUR stores knowledge as **engrams** — atomic units of learned information. Each engram has a statement, type, scope, and activation strength. Engrams are injected into the AI's context based on relevance to the current task.

```
User corrects AI → engram created → persisted to disk
Next session starts → relevant engrams injected → AI remembers
```

## Storage

By default, PLUR stores data in `~/Plur/`. Set `PLUR_PATH` to override.

```
~/Plur/
├── engrams.yaml     # all learned knowledge
├── episodes.yaml    # episodic timeline
├── config.yaml      # configuration
└── packs/           # installed engram packs
```

## License

MIT
