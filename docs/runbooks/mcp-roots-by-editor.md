# MCP roots by editor

Records which editors send MCP workspace roots to PLUR.
All entries are **unverified** until a human runs the check below.

## Current status

| Editor | Sends roots | listChanged | Recorded |
|--------|-------------|-------------|----------|
| claude-code | unverified | unverified | — |
| codex | unverified | unverified | — |
| cursor | unverified | unverified | — |
| opencode | unverified | unverified | — |
| vscode | unverified | unverified | — |

## How to verify

For each editor, start it on a two-folder workspace with `PLUR_LOG_CLIENT_INFO=1`
in the PLUR MCP entry's `env` block.

Example (Claude Code, `~/.claude.json`):
```json
{
  "mcpServers": {
    "plur": {
      "command": "node",
      "args": ["/path/to/plur-mcp/dist/index.js"],
      "env": { "PLUR_LOG_CLIENT_INFO": "1" }
    }
  }
}
```

Open a workspace with two folders (e.g. `/home/alice/project-a` and
`/home/alice/project-b`). Start a session. Read the MCP server stderr:

```
[plur] client <name> <version> roots=yes|no listChanged=yes|no
```

Update the matching fixture file under `packages/mcp/test/fixtures/client-capabilities/`
from the logged line: `clientInfo.name` and `clientInfo.version` from `<name> <version>`
(spaces in either are logged as `-`); `capabilities.roots` present when `roots=yes`
(absent when `roots=no`), with `listChanged: true` when `listChanged=yes`. Set
`"recorded"` to today's date and change `"source"` to `"manual check"`.

## Open items

- [ ] Verify claude-code: open a two-folder workspace, check stderr for `[plur] client …` line
- [ ] Verify cursor: open a two-folder workspace, check stderr for `[plur] client …` line
- [ ] Verify codex: open a two-folder workspace, check stderr for `[plur] client …` line
- [ ] Verify opencode: open a two-folder workspace, check stderr for `[plur] client …` line
- [ ] Verify vscode: open a two-folder workspace, check stderr for `[plur] client …` line
