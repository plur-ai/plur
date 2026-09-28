# Field report triage — 2026-09-28

An enterprise deployment reported that engrams created in supported editors did not
reliably reach the intended store, most folders had no automatic memory, no editor ever
produced a feedback outcome, and some editors were not set up at all. The evidence was
read from the published 0.19.4 build. This note re-checks every item against `origin/main`
(0.20.1, `856e4e92`) before any code is written. All paths below are `src/` on main.

| # | Item | Still present on main? |
|---|------|------------------------|
| 1 | Shared-scope save silently stays local | **Yes** |
| 2 | CLI cannot register a url store | **Yes** |
| 3 | Unconfigured folders get no memory | **Yes** (design needed) |
| 4 | No editor hook auto-captures or auto-rates | **Yes** |
| 5 | Save nudge may not reach the model | **Yes** (unverified; overlaps #1064) |
| 6 | opencode / Claude Desktop not set up by init | **Partial** — Desktop is done; opencode is opt-in only |
| 7 | Windows hook and MCP entries | **Yes** |
| 8a | Cross-scope recurrence absorbs a shared save | **Yes** |
| 8b | One secret aborts all session_end suggestions | **No — already fixed** |
| 8c | hook-correction-detect unregistered | **Yes** (command exists, init never installs it) |
| 8d | Hooks never flush the outbox | **Yes** |

## 1. Shared-scope save stays local, silently

- `packages/core/src/index.ts:1778` `_resolveRemoteStoreForScope` matches `entry.scope === scope`
  exactly among url, non-readonly stores; otherwise `null`.
- `learn()` (`index.ts:2954`) with a `null` resolver falls through to the local primary write
  (`index.ts:3226-3240`): no outbox entry, no routing marker, no warning. `learnRouted()`
  (`index.ts:3360`) delegates to `learn()` in the same case.
- MCP `plur_learn` (`packages/mcp/src/tools.ts:1331`) always returns `decision: 'ADD'`;
  `scopeHint()` (`tools.ts:1193-1203`) returns `{}` for any shared scope.
- CLI `plur learn` (`packages/cli/src/commands/learn.ts:274, 292-293`) prints no delivery state.

**Done when:** `learn` to `group:x` with no matching url store returns
`delivery: "local"` and a warning naming the scope; with a matching store returns `remote`
(or `outbox` when the push is deferred). `plur learn --json` and `plur_learn` both carry the
field; plain CLI output prints the warning. Tests: core, mcp, cli, each failing on main.

## 2. CLI cannot register a url store

- `packages/cli/src/commands/stores.ts:8-16`: only `plur stores add <path> <scope>`.
- Core `addStore` (`index.ts:9092`) is synchronous and never calls `/me`.
- `plur stores discover` (`stores.ts:51`, core `index.ts:9567`) needs an existing url store,
  and its empty-state advice points at a command that cannot do it. `login.ts:70, 641` say the same.

**Done when:** `plur stores add --url U --token T --scope S` verifies against `/me` (refuses
if S is not authorised), writes the entry once (a second run is a no-op with exit 0), and the
token never appears on stdout/stderr/`--json`. Test with the in-process stub server.

## 3. Unconfigured folders get no memory

- `packages/cli/src/lib/plur-configured.ts:43-70` walks up from `process.cwd()` for a project
  MCP config or `.plur.yaml`, skipping `$HOME` unless started there. Every hook for Claude Code,
  Codex, Cursor and Antigravity gates on it, so a `plur init --global` install is silent in
  every folder without its own file.
- No folder map exists. `.plur.yaml` scope is used without a trust check in CLI hooks
  (`hook-inject.ts:353-354`); only the opencode plugin gates scope on trust
  (`packages/opencode/src/scope.ts:66`).

**Status:** needs a design note and owner approval before implementation.

## 4. Auto-capture and auto-rate

- Hooks installed: `commands/init.ts:258-395` (Claude Code), `codex-hooks.ts:57-110`,
  `cursor-hooks.ts:46-49`, `antigravity-hooks.ts:~84-89`. None calls feedback.
- plur-hermes does both in `post_llm_call` (`packages/hermes/plur_hermes/__init__.py:158-199`):
  `extract_learning_patterns` (`learner.py:131`, min confidence 0.7) and
  `_detect_injection_signal` (`__init__.py:34-65`, threshold 0.6). A second copy lives in
  `memory_provider.py:357, 392` (#1086). The heuristic exists only in Python.

**Status:** default flag values need owner confirmation (proposed: auto-capture off, auto-rate on).

## 5. Save nudge delivery

- `packages/cli/src/commands/hook-learn-check.ts:174-175` emits top-level
  `{ additionalContext }` on every third Stop — no `hookSpecificOutput`, no `decision`.
- Counter/checkpoint key (`hook-learn-check.ts:28-31`) is
  `CLAUDE_SESSION_ID || ppid`, ignoring the payload's `session_id` and the shared
  `lib/session-key.ts`.

**Done when:** a real Claude Code session shows the nudge in the model's context (transcript
evidence), and the key is taken from the payload `session_id`.

## 6. opencode / Claude Desktop

- Claude Desktop: already handled (`init.ts:735` `installDesktopMcp`). **No work.**
- opencode: `opencode-config.ts` writes MCP + plugin entries, but init runs it only with
  `--opencode` (`init.ts:1111-1122`) because `@plur-ai/opencode` is unpublished; the MCP entry
  has no win32 variant.

**Done when:** `plur init` detects an opencode config dir and writes the MCP entry by default;
the plugin entry is added once the package is published (a release decision).

## 7. Windows

- Hook command is the unquoted shim path (`init.ts:1342`).
- `isPlurHook` (`init.ts:691-694`) matches `.plur/bin/plur-hook` with forward slashes only —
  re-running init on Windows duplicates hooks. Cursor/Codex matchers are fine.
- MCP entry (`mcp-config.ts:67-100`) uses `plur-mcp.cmd` or `cmd.exe /c npx`, never
  `node.exe <entry.js>`.

**Done when:** unit tests with a win32 platform stub and a home dir containing a space show
quoted commands, one hook set after two `init` runs, and `command: <node.exe>, args: [<js>]`.

## 8. Smaller fixes

- **8a** `_crossScopeRecurrenceDetect` (`index.ts:2134`, called `3035-3039` and `3413-3418`)
  matches any active engram with the same hash in a *different* scope, so a `group:x` save
  identical to a personal engram updates the personal one and never reaches the team store.
  **Done when:** a shared-scope learn is never absorbed into a non-shared engram.
- **8b** Already fixed: `tools.ts:3580-3602` isolates each suggestion; failures go to
  `engrams_failed`. **Propose: close as done.**
- **8c** `hook-correction-detect.ts` exists and is a CLI command, but no installer registers it.
  **Decision needed:** register or delete.
- **8d** Outbox flush is only in MCP `plur_sync`, `plur_outbox`, `plur_session_start` and CLI
  `plur outbox --flush`. CLI `plur sync` (`sync.ts:30`) does not flush despite `outbox.ts:63`
  saying it does. **Done when:** the session-end hooks flush (bounded time), and `plur sync` flushes.

## Decisions for the owner

1. Item 3: approve the folder-map design note (to be written next).
2. Item 4: confirm defaults — auto-capture off, auto-rate on.
3. Item 6: publish `@plur-ai/opencode`, or keep the plugin opt-in and ship MCP-only by default.
4. Item 8b: close as already fixed.
5. Item 8c: register `hook-correction-detect`, or delete it.

## Status — end of 2026-09-28

| Item | Issue | PR | Verified how |
|------|-------|----|--------------|
| 1 delivery field + warning | #1264 | #1273 | unit tests core/mcp/cli; revert-proof; mcp suite 476/476 re-run by the lead |
| 2 `stores add --url` | #1265 | #1272 | stub-server tests; token grep over all output; revert-proof |
| 5 Stop nudge reaches model | #1266 | #1271 | real Claude Code session (2.1.283): delivered, one continuation, no loop |
| 7 Windows | #1267 | #1270 | win32-stubbed tests incl. `plur doctor`; **not verified on real Windows** |
| 8a shared recurrence | #1268 | #1275 | unit tests; revert-proof. Carve-out for ladder-promoted `global` engrams awaits owner decision |
| 8d outbox flush | #1269 | #1277 | real-HTTP stub: drain, failure stays queued, slow remote cut at budget |
| new: inject never delivered | #1274 | #1276 | real sessions per event (2.1.284); plan mode not verified |
| follow-up: session marker keyed on ppid | #1278 | — | filed |
| follow-up: `plur-mcp init` registers PostCompact | #1279 | — | filed |

### Found on the delivery path (new, 2026-09-28)

- **Claude Code drops top-level `additionalContext`** on Stop and UserPromptSubmit (codeword experiments with positive
  controls). `hook-inject` used that shape, so automatic injection has not reached the model in Claude Code. PostCompact
  cannot carry context at all; rehydrate moves to `SessionStart` matcher `compact`.
- **Async UserPromptSubmit context arrives only at the next safe point** (after a tool result or the next prompt), so a
  first reply with no tool calls gets no memory. Owner decision pending: sync with a deadline, or keep async.
- **Queued writes that are permanently refused stay silent.** A developer store had queued personal-scope writes
  rejected with 403 on every attempt for 12 days (one entry at 103 attempts) with no user-visible signal. #1273 reports
  where a *new* write went; nothing yet surfaces an outbox entry that can never succeed. Candidate follow-up.

### Owner decisions still open

Item 3 design note (and Q1–Q3), item 4 defaults, item 6 opencode, item 8c register/delete, #1275 carve-out,
sync-vs-async injection.
