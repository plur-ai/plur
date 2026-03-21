# @plur-ai/mcp

MCP server for PLUR — exposes persistent AI memory as Model Context Protocol tools.

```bash
npm install -g @plur-ai/mcp
```

The `plur-mcp` binary is now in your PATH. Point any MCP client at it and your agent has memory.

## Configuration

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "plur": {
      "command": "plur-mcp"
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "plur": {
      "command": "plur-mcp",
      "args": []
    }
  }
}
```

### Custom storage path

```json
{
  "mcpServers": {
    "plur": {
      "command": "plur-mcp",
      "env": { "PLUR_PATH": "/path/to/storage" }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `plur.learn` | Create an engram — record a reusable learning, preference, or correction |
| `plur.recall` | Query engrams by keyword/phrase — retrieve relevant learned knowledge |
| `plur.inject` | Get scored context for a task — directives and considerations within token budget |
| `plur.feedback` | Rate an engram's usefulness — trains injection relevance over time |
| `plur.forget` | Retire an engram — marks it inactive without deleting history |
| `plur.capture` | Append an episode to the timeline — records what happened in a session |
| `plur.timeline` | Query past episodes — filter by time, agent, channel, or search |
| `plur.ingest` | Extract engram candidates from content using pattern matching |
| `plur.packs.install` | Install an engram pack from a directory path |
| `plur.packs.list` | List all installed engram packs |
| `plur.status` | System health — engram count, episode count, pack count, storage root |

## How to Use (as the AI agent)

At session start: call `plur.inject` with your task description to load relevant memory into context.

When the user corrects you: call `plur.learn` to record it.

At session end: call `plur.capture` to record what happened.

Rate injected engrams with `plur.feedback` to improve future injection quality.

## License

MIT
