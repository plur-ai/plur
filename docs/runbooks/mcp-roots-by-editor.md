# MCP roots by editor

Records which editors send MCP workspace roots to PLUR. A row with a date was
recorded from a real run; a row marked **unverified** still needs the check
below.

## Current status

| Editor | Sends roots | listChanged | Recorded |
|--------|-------------|-------------|----------|
| claude-code | yes | yes | 2026-10-18 |
| codex | no | no | 2026-10-18 |
| cursor | unverified | unverified | — |
| cursor-agent | no | no | 2026-10-18 |
| opencode | yes | no | 2026-10-18 |
| vscode | unverified | unverified | — |

What each run logged (`PLUR_LOG_CLIENT_INFO=1`), with the client version run:

- claude-code (Claude Code CLI 2.1.302): `[plur] client claude-code 2.1.302 roots=yes listChanged=yes`
- codex (codex-cli 0.161.0): `[plur] client codex-mcp-client 0.161.0 roots=no listChanged=no`
- cursor-agent (Cursor CLI agent 2026.10.01): `[plur] client Cursor 1.0.0 roots=no listChanged=no`
- opencode (opencode 1.18.35): `[plur] client opencode 1.18.35 roots=yes listChanged=no`

Notes on the 2026-10-18 runs:

- Each run used a headless session on a two-folder workspace (`project-a` as the
  start folder, `project-b` added with `--add-dir` where the client has it;
  opencode has no such flag and ran on `project-a` alone). The capabilities are
  sent at `initialize`, before any folder is opened, so the second folder does
  not change them.
- The fixtures copy `clientInfo` and `capabilities` from the `initialize`
  request each client sent (captured with `tee` in front of the server), not
  only from the log line. Descriptive `clientInfo` fields (description, website)
  are left out.
- `cursor-agent` is Cursor's command-line agent. It is a separate MCP client from
  the Cursor editor and identifies itself as `Cursor 1.0.0`; it does not show
  what the editor sends, so `cursor` stays unverified.
- opencode declares `roots` without `listChanged`: PLUR asks for its roots but
  gets no notice when they change.
- No session called a PLUR tool, so the server never asked for `roots/list`;
  what each client answers there (which folders it lists) was not recorded.

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

- [x] claude-code — recorded 2026-10-18 (CLI). The editor extensions (VS Code,
      JetBrains) were not run separately.
- [x] codex — recorded 2026-10-18 (CLI).
- [x] opencode — recorded 2026-10-18.
- [ ] cursor (the editor) — **not verified**: it needs the editor's window and
      its MCP approval prompt. To settle it, add the PLUR entry with
      `"env": { "PLUR_LOG_CLIENT_INFO": "1" }` to `~/.cursor/mcp.json`, open a
      two-folder workspace (`cursor /path/to/project-a /path/to/project-b`),
      enable the server under Settings → MCP, and read the `[plur] client …`
      line in the server's output (Output panel → MCP Logs).
- [ ] vscode — **not verified**: VS Code is not installed on the machine that
      ran the other checks. To settle it, add the entry to `.vscode/mcp.json`
      (`"servers": { "plur": { "command": "node", "args": [...],
      "env": { "PLUR_LOG_CLIENT_INFO": "1" } } }`), open a two-folder
      workspace (`code /path/to/project-a /path/to/project-b`), start the server
      from the MCP view, and read the line with "MCP: Show Output".
