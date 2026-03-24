# @plur-ai/mcp

MCP server for PLUR — gives any AI agent persistent memory via the Model Context Protocol.

```bash
npx @plur-ai/mcp
```

Or install globally:

```bash
npm install -g @plur-ai/mcp
```

## Setup

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

### Custom storage path

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

## Tools

| Tool | Description |
|------|-------------|
| `plur.learn` | Store a memory — correction, preference, convention, or decision |
| `plur.recall` | Keyword search (BM25, instant) |
| `plur.recall.hybrid` | **Best default** — BM25 + embeddings merged via RRF. No API calls. |
| `plur.inject` | Select engrams for current task within token budget |
| `plur.feedback` | Rate an engram — trains injection relevance over time |
| `plur.forget` | Retire a memory (history preserved) |
| `plur.capture` | Record a session event to the episodic timeline |
| `plur.timeline` | Query past episodes by time, agent, or search |
| `plur.ingest` | Extract engram candidates from text |
| `plur.sync` | Git-based sync across machines |
| `plur.sync.status` | Check sync state (initialized, remote, dirty, ahead/behind) |
| `plur.packs.install` | Install an engram pack |
| `plur.packs.list` | List installed packs |
| `plur.status` | System health — engram count, episodes, packs, storage root |

## How agents use it

**Session start:** Call `plur.inject` with the task description to load relevant memory.

**When corrected:** Call `plur.learn` to store the correction.

**Session end:** Call `plur.capture` to record what happened.

**Rate results:** Call `plur.feedback` on injected engrams to improve future quality.

**Cross-device:** Call `plur.sync` with a git remote URL to sync memory across machines.

## Update notifications

The server checks npm on startup and logs a warning if a newer version is available. No overhead during operation — the check runs once, asynchronously.

## License

Apache-2.0
