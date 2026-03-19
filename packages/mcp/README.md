# @plur-ai/mcp

MCP server for PLUR — exposes shared memory as Model Context Protocol tools.

## Install

```bash
npm install -g @plur-ai/mcp
```

## Configure

Add to your MCP client config:

```json
{
  "mcpServers": {
    "plur": { "command": "plur-mcp" }
  }
}
```

Works with Claude Code, Cursor, OpenClaw, and any MCP-compatible client.

## Tools

| Tool | Description |
|------|-------------|
| plur.learn | Create an engram |
| plur.recall | Query relevant engrams |
| plur.inject | Get scored injection for a task |
| plur.feedback | Rate engram usefulness |
| plur.forget | Retire an engram |
| plur.capture | Append to episodic timeline |
| plur.timeline | Query episodes |
| plur.ingest | Extract engrams from content |
| plur.packs.install | Install an engram pack |
| plur.packs.list | List installed packs |
| plur.status | System health |

## License

MIT
