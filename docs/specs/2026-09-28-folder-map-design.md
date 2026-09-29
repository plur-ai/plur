# Folder map with "ask" — design note (revision 2, compacted)

Status: **Draft r2, awaiting owner approval of the compaction. No implementation until approved.**
Dates: r1 2026-09-28; r2 2026-09-29, which folds `trust.yaml` into the folder map.
Triage: `docs/audits/2026-09-28-field-report-triage.md` item 3.

## Problem

Every editor hook (Claude Code, Codex, Cursor, Antigravity) gates on `isPlurConfigured()`
(`packages/cli/src/lib/plur-configured.ts:43-70`). That function walks up from the working
folder looking for a project MCP config or a `.plur.yaml`, and it skips `$HOME`. So after
`plur init --global`, PLUR does nothing in any folder without its own file, which is most
folders. An enterprise deployment reported exactly this.

## Today: three per-folder mechanisms

| File | Lives | Written by | Controls |
|---|---|---|---|
| `.plur.yaml` | in the repo, found by walking up to `.git` | whoever commits to the repo | `scope` and `domain` hints; optional `remote_url` / `remote_token` / `remote_scopes`. Its presence switches the hooks on |
| `~/.plur/trust.yaml` | PLUR home | the user, via `plur trust` / `plur init-remote` | only whether this tree's `.plur.yaml` may send memories to the remote it names (`core/src/project-remote.ts:78-109`, fails closed). The CLI hooks use `.plur.yaml`'s `scope` without checking trust; only the opencode plugin checks |
| `~/.plur/folders.yaml` | PLUR home | r1 proposal | on / off / ask per folder, plus a default scope |

`trust.yaml` and `folders.yaml` are the same kind of record. Both are user-owned, stored
under the PLUR home, apply to a folder and everything below it, and hold a decision the user
made about that folder. Keeping them separate means two files, two command families and two
resolution walks for what is one question: *what have I decided about this folder?*

`.plur.yaml` is a different kind of record. It says what **the repo asks for**, and it
reaches teammates through git. It stays.

## r2: two files, two roles

- **`~/.plur/folders.yaml`: your decisions.** It replaces `trust.yaml`. Only you write it,
  through a command.
- **`.plur.yaml`: the repo's request.** Unchanged format. It suggests a scope, a domain and
  optionally a remote. Your decision in the map can confirm it, override it or refuse it.

```yaml
version: 1
folders:
  - path: ~/work/**
    scope: group:example/eng      # on; default write scope
  - path: ~/work/secret/**
    plur: off                     # nothing at all here
  - path: ~/src/team-repo
    trusted: true                 # this tree's .plur.yaml may use the remote it names
  - path: ~/notes
    plur: on                      # on, default scope
```

Each entry has a `path` and any of the following fields:
- `plur`: `on`, `off` or `ask`. An entry with a `scope` or `trusted: true` and no `plur`
  field defaults to `on`.
- `scope`: the default write scope.
- `trusted`: `true` lets this tree's `.plur.yaml` use the remote it names. It is the former
  `trust.yaml` grant.

Paths are globs. `~` is expanded, and paths are canonicalised with the existing
`canonicalize()` (symlink-safe, #778). A bare directory also covers everything below it. A
malformed file is logged and treated as empty, falling back to `ask`, and never crashes a
hook.

## Resolution

`resolveFolderPolicy(dir)` returns `{ mode: on|off|ask, scope?, remoteAllowed, source }`.
It lives in core and replaces `isPlurConfigured()` in every hook. Hooks pass the payload's
`cwd` when the editor sends one.

1. **Off wins.** If any matching map entry is `off`, the result is off. That holds even when a
   more specific entry or a `.plur.yaml` says otherwise.
2. **A `.plur.yaml` in the tree means on, as today.**
   - Its `scope`/`domain` hints apply unless a matching map entry sets `scope`: your decision
     beats the repo's request. No map entries exist today, so existing users see no change.
   - Its remote is used only if a covering entry has `trusted: true`. This is today's trust
     rule, read from a different file.
3. **A project MCP config means on, as today.**
4. **Otherwise, the most specific matching map entry.** Specificity is the literal prefix
   length, then the segment count; a later entry wins a tie.
5. **No match means ask.** That includes `$HOME` itself (owner decision Q2).

## The ask

- **When it fires.** On the first prompt of a session in an `ask` folder, the inject hook
  loads no memories. It adds one instruction instead: ask the user once whether to use PLUR in
  `<folder>`, suggest a scope, and record the answer. Later prompts in that session stay
  silent. There is one asked-once record per session, keyed by `safeSessionKey(session_id)`.
- **The suggested scope** comes from the existing `suggestScope()` ranker, limited to scopes
  this install can already write to. Nothing is ever routed into a shared scope without the
  user choosing it.
- **Three answers** (owner decision Q1):
  - **Yes** → `plur folders set <folder> --scope <s> --nonce <n>` (or `--on`). The same turn
    goes on to load memories.
  - **Not now** → nothing is recorded, and the next session asks again.
  - **Never here** → `plur folders set <folder> --off --nonce <n>`.

### A repo that asks for a remote you haven't trusted

Today, a `.plur.yaml` naming a remote in an untrusted tree is refused silently (`refusedFrom`).
The remote leg just doesn't work, and nothing asks the user. r2 turns that refusal into the
same one-time question: "This repo asks to send memories to `<host>`. Allow?" Yes writes
`trusted: true`. **This is new behaviour for existing `.plur.yaml` users, but only for users
whose remote is already being refused today** (see Q-A).

## A repo can never change the map

- Only `~/.plur/folders.yaml` is read. `.plur.yaml` cannot express map entries, `on`/`off`
  or trust.
- Writes happen only through the CLI (owner decision Q3: no MCP tool): `plur folders
  set | rm | list`.
  - A write from the ask flow must present that session's nonce. It may name only the folder
    that was asked about, and it is accepted once.
  - A shared `scope` is written only if it is one of the stores this install already has
    configured. A typo cannot create a scope that silently stays local.
  - `plur folders set` run by hand without `--nonce` is the user's own action and is
    accepted, as `plur trust` is today.

## Upgrade: zero manual steps

- **No `folders.yaml`:** it is treated as empty. On first read, any `trust.yaml` entries are
  imported as `{ path, trusted: true }` and written to `folders.yaml`.
  - `trust.yaml` is left untouched, so a downgrade still works.
  - After import, `folders.yaml` is the only file read for trust.
- **`plur trust` / `plur untrust` keep working** as aliases: they set or clear `trusted`
  on the entry. `plur trust --list` prints the trusted entries.
- **Behaviour for existing users:**
  - Folders configured today (a `.plur.yaml` or a project MCP config) still resolve to on,
    with the same scope hint and the same remote rule.
  - Folders that got nothing before now get one question per session.
- **Formats:** `config.yaml` and `.plur.yaml` are unchanged.

## Out of scope

- Gating `.plur.yaml`'s `scope` hint on trust in the CLI hooks, as opencode does. Existing
  users would notice the change, so it stays out. With r2, a user who wants that sets a `scope`
  in the map.
- A UI for the map.

## Done when

- **Resolver unit tests:**
  - off wins;
  - specificity ordering;
  - `.plur.yaml` precedence, and a map `scope` overriding its hint;
  - `trusted` gating the remote;
  - a missing or malformed file;
  - importing from `trust.yaml` (idempotent, `trust.yaml` untouched);
  - win32 paths and a symlinked path.
- **Hook tests for each of the four editors:**
  - an unmapped folder asks once, then stays silent for the session;
  - `on` injects;
  - `off` is silent;
  - an existing `.plur.yaml` fixture gives byte-identical output to main;
  - an untrusted remote asks once.
- **`plur folders set` refuses** a missing or stale nonce, a different folder, and an
  unconfigured shared scope.
- **`plur trust` / `untrust`** still work, now through the map.
- **Manual check** in a fresh install on macOS and Windows, in a never-registered folder:
  it asks once, and after "yes" an engram reaches a configured url store.

## Owner decisions

- Q1 → offer "never here", which writes `off`. *(decided 2026-09-29)*
- Q2 → ask in `$HOME` like any other folder. *(decided 2026-09-29)*
- Q3 → CLI only. *(decided 2026-09-29)*
- **Q-A (new in r2): should an untrusted `.plur.yaml` remote trigger the one-time question?**
  **Proposed: yes.** The alternative is a remote leg that stays silently dead, which is the
  field report's symptom.
- **Q-B (new in r2): fold `trust.yaml` into `folders.yaml`?** **Proposed: yes, with import
  and aliases as above.** The alternative keeps `trust.yaml` as a second file and adds
  `folders.yaml` beside it.
