# Installing PLUR (for Cline and other agents)

PLUR is a local-first shared-memory MCP server. Engrams (memories) are stored as
plain YAML under `~/.plur/`. No account, no API key, nothing phones home.

## One-command setup (recommended)

```
npx -y @plur-ai/mcp init
```

`init` writes the MCP server entry into the caller's config and creates `~/.plur/`.

## Manual MCP config

Add this server to the MCP settings (for Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "plur": {
      "command": "npx",
      "args": ["-y", "@plur-ai/mcp"]
    }
  }
}
```

- **Command:** `npx -y @plur-ai/mcp` (stdio transport)
- **Env vars:** none required. Optional: `PLUR_HOME` to relocate the store (default `~/.plur`).
- **Requirements:** Node.js 18+.

## Verify

After the server connects, call the `plur_status` tool. A healthy install returns
an engram count and store path. Then try `plur_learn` (store a memory) and
`plur_recall_hybrid` (retrieve it).

## What you get

- `plur_learn` / `plur_recall_hybrid` — write and search memories (local BM25 + embeddings)
- `plur_session_start` / `plur_session_end` — session bookends that inject/capture context
- `plur_feedback` — rate which memories helped
- Full tool list and the open engram format: https://plur.ai/spec.html

Docs: https://plur.ai · Source: https://github.com/plur-ai/plur
