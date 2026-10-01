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
| `plur: remote-only` + `scope: <s>` | Memories go only to the team server, in scope `<s>`. Your personal memories are neither read nor written there. |

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

Use this for work whose memories belong on a team server rather than in your
personal store.

```
plur folders set ~/client-work --remote-only --scope group:acme/client
```

The scope must be served by a team store (a `url` store in `config.yaml`; add
one with `plur remote` or `plur stores add` first).

### Which integrations follow it

- **Followed:** the Claude Code, Codex, Cursor and Antigravity hooks; every
  `plur` command run in the folder; the MCP server (for the folders the editor
  lists as workspace roots, and the folder it was started in). If the MCP
  server cannot read the editor's workspace folders, that call reads and writes
  nothing and says so; the next call asks again.
- **Not yet:** the opencode plugin follows the folder map once its folder-map
  support (#1517) is in. The OpenClaw plugin and the Hermes plugin do not read
  the folder map: in a remote-only folder they use your personal store as
  usual. (Hermes calls the `plur` CLI, which binds to the folder that process
  runs in — not necessarily your workspace.) Do not use those integrations for
  work that must stay off your personal store.

### What happens there

- **Saving without a scope** sends the memory to the folder's scope. That scope
  is the folder's "global".
- **Saving to a personal or local scope is refused**: `user:…`, `agent:…`,
  `global`, `local`, a `project:` scope no team store serves, or a memory marked
  private. The message names the folder and how to change it. Content the
  sensitivity guard would normally keep local is refused too.
- **Saving to another team scope you can write** still works.
- **Recall and injection** read the folder's scope from the team server and
  your installed packs. They never read your personal store.
- **Your personal memories are out of reach there.** Looking one up by id finds
  nothing; forgetting, pinning, rating, updating or rescoping one is refused.
  So are operations on the personal store as a whole: saving meta-engrams,
  exporting a pack, recording, confirming or resolving tensions, and turning a
  timeline episode into a memory. The timeline, tension list and history
  queries answer empty.
- **A save that repeats one already waiting to be sent from this folder** is
  counted on that queued save instead of being queued twice.
- **A save that cannot reach the server** waits in the outbox (a row in
  `engrams.yaml` marked for delivery, see `plur outbox`) and is removed once it
  is delivered. Such a queued save can only be delivered or forgotten, from any
  folder: forgetting deletes it outright, and it cannot be rescoped or updated
  to a local scope. If the team scope's sensitivity policy is tightened before
  it is sent, it stays queued (with the reason) rather than being kept as a
  local memory.
- **If the server cannot be reached at session start**, the session starts
  without memory and says so once. It never falls back to your personal store.
- **No session timeline is kept.** `plur capture`, `plur_capture` and the
  timeline entry the session-end hooks and `plur_session_end` would write are
  refused or skipped, because a timeline entry can hold session content. A
  session's end-of-session suggestions still go to the team scope.
- **Changing the scope keeps the folder remote-only.** `plur folders set
  <folder> --scope <other>` only changes the scope (it must also be served by a
  team store). It never switches the folder back to local memory.
- **An entry with no scope** (written by hand) refuses every save, and sessions
  there say no team server serves the folder.
- **Only an explicit decision of your own overrides it.** A repository's
  `.plur.yaml` or project MCP config cannot turn the folder back on, and neither
  can an entry below it that only sets `trusted` or a `scope` (`plur trust` on a
  repository inside the folder). `off`, or a more specific entry with an
  explicit mode (`--on`, `--ask`, `--off`), does. The entry also matches the
  folder under another letter case or through a symlinked parent, the way `off`
  does.

To leave remote-only you say so explicitly: `plur folders set <folder> --on`
(or `--off`, `--ask`), or `plur folders rm <folder>`.

The guarantee is enforced twice. The commands and tools refuse with a
message, and underneath them every local store PLUR opens in such a folder is
wrapped so that it shows and accepts only the folder's own queued saves — a
path nobody listed still cannot reach a personal memory. Store maintenance
(`plur compact`, reindexing, `plur sync`) is refused in the folder; run it
elsewhere.

### What is still written on this machine

Remote-only keeps your memories, and the client's, out of your personal store.
It is not a guarantee that nothing about the session touches the disk:

- the queued saves above, until they are delivered or forgotten;
- the embedding cache (`.embeddings-cache.json`): vectors for team memories
  that were ranked locally, keyed by id;
- the remote store's in-process cache of team rows (memory only, not disk);
- the history log (`history.jsonl`): events about saves and injections, with
  ids and counts — in a remote-only folder the statement previews are left out;
- `plur status` statistics and the outbox's own bookkeeping (attempts, errors,
  idempotency keys).
- provenance records, when provenance recording is turned on
  (`docs/provenance.md`): one per team memory written;
- `plur sync` (run from any folder) pushes `engrams.yaml` to your git remote,
  including queued saves that have not been delivered yet.

Session checkpoints that the editor hooks write while a session runs are
dropped at session end in a remote-only folder, not captured.

### If folders.yaml cannot be read, or a folder cannot be looked up

A `folders.yaml` with a syntax error, or a value PLUR does not know, is never
read as empty: every folder behaves like `ask`, PLUR reads and writes nothing
(not even a save to an explicit team scope), and the first prompt of a session
says so, naming the file and the line. A folder whose decision cannot be looked
up for another reason is treated the same way. A session that ends in such a
folder captures nothing. Fix
or remove the file to continue. (`plur folders set` refuses to overwrite it.)

### Update every PLUR integration together

A PLUR version older than 0.21.1 cannot read a `folders.yaml` that holds a
`remote-only` entry. It treats the whole file as unreadable and, being older,
falls back to its old behaviour: every folder asks again, your `off` entries are
not applied, and a folder with a project setup gets full local memory. Upgrade
the CLI, the MCP server and the editor plugins (opencode, OpenClaw, Hermes) to
the same version, and re-run `plur init` so pinned configs follow, before you
add a remote-only entry.
