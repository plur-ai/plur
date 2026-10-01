# The folder map

`~/.plur/folders.yaml` (in your PLUR home) holds your decisions about folders:
what PLUR does in each one. Every integration reads it: the Claude Code, Codex,
Cursor and Antigravity hooks, the MCP server, and (once its folder-map support
lands) the opencode plugin. A repository cannot write it; `.plur.yaml` stays the
repository's request.

## Settings

| Setting | What it does |
|---|---|
| `plur: on` | Memory works here as usual: recall, inject and learn. |
| `plur: off` | PLUR does nothing at all here. |
| `plur: ask` | Ask once per session what to do here. |
| `scope: <s>` | The default scope for memories saved here. Implies `on`. |
| `trusted: true` | This folder's `.plur.yaml` may set its scope and team server. |
| `plur: remote-only` + `scope: <s>` | Memory lives only on the team server, in scope `<s>`. Nothing is saved to or read from your personal store. |

An entry names a folder or a glob (`~/work/**`). A plain folder also covers
everything below it. The most specific entry for a folder wins, and `off` on a
folder or on any folder above it always wins. A folder with no entry and no
project setup is asked about once per session.

## Writing it

```
plur folders list
plur folders set <folder> --on | --off | --ask | --scope <s> | --remote-only --scope <s>
                          [--trusted | --no-trusted]
plur folders rm <folder>
plur trust <folder>        # same as: plur folders set <folder> --trusted
plur untrust <folder>
```

Outside an interactive terminal, `set`, `rm` and `trust` need the `--nonce` the
folder question printed. This stops an agent from recording a decision you did
not make. A person at a terminal needs no nonce.

The first write creates `folders.yaml` with a commented example of every
setting, each with one line saying what it does. To use one, remove the `# ` in
front of its lines, and the `[]` after `folders:` if it is still there. You can
edit the file by hand: every CLI write keeps your comments and the order of
entries, and changes only the entry it is about. A `folders.yaml` PLUR cannot
read is never overwritten; fix or remove it first.

## Remote-only folders

Use this for work whose memory must stay on a team server, for example client
work under a contract that does not allow copies on a laptop.

```
plur folders set ~/client-work --remote-only --scope group:acme/client
```

The scope must be served by a team store (a `url` store in `config.yaml`; add
one with `plur remote` or `plur stores add` first). In a remote-only folder:

- **Saving without a scope** sends the memory to the folder's scope. That scope
  is the folder's "global".
- **Saving to a personal or local scope is refused**: `user:…`, `agent:…`,
  `global`, `local`, a `project:` scope no team store serves, or a memory marked
  private. The message names the folder and how to change it. Content the
  sensitivity guard would normally keep local is refused too.
- **Saving to another team scope you can write** still works.
- **Recall and injection** read the folder's scope from the team server and
  your installed packs. They never read your personal store.
- **If the save cannot reach the server**, it waits in the outbox (a row in
  `engrams.yaml` marked for delivery, see `plur outbox`) and is removed once it
  is delivered. No other memory is kept on this machine.
- **If the server cannot be reached at session start**, the session starts
  without memory and says so once. It never falls back to your personal store.
- A repository's `.plur.yaml` or project MCP config cannot turn a remote-only
  folder back on. Only `off`, or a more specific entry of your own, overrides it.

- **No session timeline is kept.** `plur capture`, `plur_capture` and the
  timeline entry the session-end hooks and `plur_session_end` would write are
  refused or skipped there, because a timeline entry can hold session content.
  A session's end-of-session suggestions still go to the team scope. `plur
  status` statistics and the local embedding cache are unchanged.
- **Changing the scope keeps the folder remote-only.** `plur folders set
  <folder> --scope <other>` only changes the scope (it must also be served by a
  team store). It never switches the folder back to local memory.
- **An entry with no scope** (written by hand) refuses every save, and sessions
  there say no team server serves the folder. Add a scope with `plur folders set
  <folder> --remote-only --scope <s>`.

To leave remote-only you say so explicitly: `plur folders set <folder> --on`
(or `--off`, `--ask`), or `plur folders rm <folder>`.

**Update every PLUR integration together.** A PLUR version older than 0.21.1
cannot read a `folders.yaml` that holds a `remote-only` entry: it treats the
whole file as unreadable, so in that integration every folder asks again and
your `off` entries are not applied. Upgrade the CLI, the MCP server and the
editor plugins (opencode, OpenClaw, Hermes) to the same version, and re-run
`plur init` so pinned configs follow, before you add a remote-only entry.
