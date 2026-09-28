# Folder map with "ask" — design note

Status: **Draft — awaiting owner approval. No implementation until approved.**
Date: 2026-09-28. Triage: `docs/audits/2026-09-28-field-report-triage.md` item 3.

## Problem

Every editor hook (Claude Code, Codex, Cursor, Antigravity) gates on
`isPlurConfigured()` (`packages/cli/src/lib/plur-configured.ts:43-70`). It walks up from
`process.cwd()` for a project MCP config or `.plur.yaml` and skips `$HOME`. A user who ran
`plur init --global` therefore gets no injection and no save nudge in any folder that lacks
its own file. That is most folders. An enterprise deployment reported exactly this.

## Decision already taken (by the owner)

The per-folder opt-in is replaced as the default by a user-level folder map. An unmapped folder
gets **ask**.

## The map

`~/.plur/folders.yaml` (under the PLUR home, next to `trust.yaml`):

```yaml
version: 1
folders:
  - path: ~/work/**
    scope: group:example/eng      # on, writes default to this scope
  - path: ~/work/secret-client/**
    plur: off                     # nothing: no inject, no nudge, no capture
  - path: ~/scratch/*
    plur: ask
  - path: ~/notes
    plur: on                      # on, default scope (no shared default)
```

- `path` is a glob, `~` expanded, canonicalised with the same `canonicalize()` that
  `trust.ts` and `project-config.ts` use (symlink-safe, #778). A bare directory matches itself
  and everything below it.
- Each entry has exactly one of `scope: <s>` (meaning on, with that default scope) or
  `plur: off | ask | on`.
- A malformed file is logged and treated as empty (the resolver falls back to `ask`). It never
  crashes a hook. This follows the `loadTrustFile` pattern.

## Resolution

`resolveFolderPolicy(dir) → { mode: 'on' | 'off' | 'ask', scope?, source }`, in core next to
`trust.ts`.

1. Collect every map entry whose glob matches `dir`.
2. If any matching entry is `off`, the result is **off**. Off always wins, even over a more
   specific entry and even over a `.plur.yaml`.
3. Otherwise, if a `.plur.yaml` is found by `findProjectConfigPath` (unchanged walk, `.git`
   ceiling), it is used **exactly as today**, including today's trust rules. This keeps
   behaviour unchanged for existing `.plur.yaml` users. A project MCP config found by the
   current `isPlurConfigured` walk also means **on**, as today.
4. Otherwise the most specific matching entry wins. Specificity is the length of the literal
   (non-wildcard) prefix, then the number of path segments. A tie goes to the later entry.
5. No match gives **ask**.

Every hook replaces `isPlurConfigured()` with this resolver and uses the payload's `cwd` when
the editor sends one, falling back to `process.cwd()`. Antigravity already passes a workspace
path.

## The ask

- On the **first prompt of a session** in an `ask` folder, the inject hook
  (`hook-inject`, `hook-codex-inject`, `hook-cursor-session-start`,
  `hook-agy-pre-invocation`) injects no engrams. It adds one short instruction instead: ask
  the user once whether to use PLUR in `<folder>`, offer a suggested scope, and name the
  command that records the answer.
- The suggested scope comes from the existing `suggestScope()` ranker
  (`core/src/index.ts:2506`) over the folder's signals (path, git remote), limited to scopes
  this install can already write to. It is only a suggestion: nothing is ever routed into a
  shared scope without the user choosing it. This keeps the must-not on auto-routing.
- Asked-once state is kept per session: `~/.plur/sessions/<safeSessionKey(session_id)>.ask.json`
  holds `{folder, nonce, suggested}`. Later prompts in that session stay silent, and so does
  the nudge.
- **Yes** means the agent runs `plur folders set <folder> --scope <s> --nonce <n>` (or
  `--on`). This writes the map and the same turn proceeds with injection.
- **No** means nothing happens for this session: no engrams, no nudge, no capture, and no map
  write. See open question Q1.

## A repo can never change the map

- Only `~/.plur/folders.yaml` is read. No repo-level folder file exists or is ever consulted.
  `.plur.yaml` cannot express map entries.
- Writes go through `plur folders set|off|rm` only (and an MCP twin, if Q3 says so). A write
  that comes out of the ask flow must present the session's nonce, may name only the folder
  that was asked about, and is accepted once.
- A shared `scope` is written only if it is one of the stores already configured for this
  install. A typo cannot create a silent local-only shared scope (see item 1).
- `plur folders set` run by hand, without `--nonce`, is the user's own action and is accepted,
  like `plur trust`.

## Upgrade: zero manual steps

- If `folders.yaml` is missing, it is treated as an empty map. Nothing is written until a
  user answers an ask.
- Folders that are configured today (`.plur.yaml` or a project MCP config) resolve to **on**
  as they do now. Only folders that got nothing before change: they now get one question per
  session.
- `config.yaml`, `trust.yaml` and `.plur.yaml` formats are unchanged.

## Out of scope

- Moving `.plur.yaml` scope under the trust gate for CLI hooks. Today only the opencode plugin
  does that (`packages/opencode/src/scope.ts:66`). Changing it would alter behaviour for
  existing users, so it goes in a separate issue.
- A UI for the map.

## Done when

- Unit tests cover the resolver: off wins, specificity, `.plur.yaml` precedence, missing or
  malformed file, win32 paths, and a symlinked path.
- Hook tests for each of the four editors cover four cases:
  - an unmapped folder asks once, then stays silent for the rest of the session;
  - a mapped `on` folder injects;
  - an `off` folder is silent;
  - an existing `.plur.yaml` fixture produces byte-identical output to main.
- `plur folders set` refuses in three cases: a missing or stale nonce from the ask flow, a
  different folder, and an unconfigured shared scope.
- The manual check runs in a fresh install on macOS and Windows, in a never-registered
  folder: the session asks once, and after "yes" the engram reaches a configured url store.

## Open questions for the owner

- **Q1. What does "No" record?**
  - Proposed: nothing, so the session asks again next time.
  - Alternative: the agent offers "never here", which writes `plur: off`.
- **Q2. Should the ask stay silent for folders under the home directory itself** (for example
  a shell opened in `~`)? Proposed: ask like any other folder.
- **Q3. Should there be an MCP tool (`plur_folders_set`) as well as the CLI?**
  - Proposed: CLI only. Every supported editor's agent can run a shell command, and one write
    path is easier to guard.
