# Fresh install on Windows — field-report done-when (2026-09-30)

> "A fresh install, in a never-registered folder, asks once; on 'yes' it
> writes an engram that reaches the url store, and produces a feedback
> outcome."

**Result: not met on Windows.** Asking once works, the "yes" works (except
one case in Git Bash), and the engram reaches the url store. The feedback
outcome does not happen in any editor: the end-of-turn auto-rate hook
ignores a folder that the folder map switched on.

**This is not a live editor session.** No editor ran. A GitHub Actions
`windows-latest` runner installed the packed tarballs and ran `plur init`.
Then it ran each hook command and MCP entry that init wrote, exactly as
written, with the JSON payload each editor sends, through Git Bash, pwsh and
`cmd /C`. Exec-form entries (command + args) were spawned with no shell. The
"yes" answer was simulated by running the command that the question prints,
nonce included, in the same shell.

## Run

- Run: https://github.com/plur-ai/plur/actions/runs/36687294623 (both matrix
  jobs report "failure" because of the findings below, not because the
  harness broke).
- Branch `e2e/windows-fresh-install` @ `454e50fc`. This branch is for the e2e
  only: it is not for merging, and no PR is open for it.
- Workflow: `.github/workflows/e2e-windows-fresh-install.yml`. It runs on push
  to that branch or on `workflow_dispatch`, with a matrix over home paths:
  `plain` (`C:\Users\runneradmin\AppData\Local\Temp\e2euser…`) and `spaced`
  (`…\Temp\E2E User …`).
- Harness: `scripts/e2e/windows-fresh-install.mjs` (the driver) and
  `scripts/e2e/stub-store.ts`. The second wraps
  `packages/core/test/helpers/stub-server.ts` without editing it. Its `/me`
  advertises `feedback.source` and the scope `group:e2e/test`, recall is
  answered from the rows actually stored, and `/__e2e/state` feeds the
  assertions. It uses a localhost test token and no repository secrets.
- Install: `pnpm pack` of core, mcp and cli, then `npm install` of the three
  tarballs into a temp prefix. `npm pack` could not be used: it keeps the
  `workspace:*` specifiers, which npm cannot install. HOME, USERPROFILE,
  TEMP/TMP, APPDATA/LOCALAPPDATA, XDG_CONFIG_HOME and PLUR_PATH all pointed at
  fresh temp dirs. Embeddings were left at the default.
- Setup order: `plur init --global --no-desktop --cursor --codex --antigravity
  --opencode --no-prompt` (from HOME), then `plur stores add --url <stub>
  --scope group:e2e/test --token-env …`. Each shell × editor pair then got
  its own never-registered folder, `HOME\work\never registered <shell>
  <editor>`.

### Merged PR heads (the branch was built on `formal/field-report-2026-09-29` @ `e12df3a6`, which already carried the integration resolutions)

| Branch | PR | Head |
|---|---|---|
| verify/formal-lean | #1228 | e006b9db |
| fix/h1-session-key-1228 | #1401 | 1fa87f2c |
| feat/1265-stores-add-url | #1272 | 99b98088 |
| fix/1264-learn-delivery | #1273 | 04eff335 |
| fix/1268-shared-recurrence | #1275 | 26441314 |
| fix/1267-windows-init | #1270 | ed993537 |
| feat/1310-auto-rate | #1318 | d2073268 |
| fix/1319-duplicate-primary-store | #1334 | 8f83367c |
| fix/1317-secret-token-prefixes | #1340 | d1c072b5 |
| fix/1354-empty-lock-takeover | #1398 | 89307064 |
| fix/1354-lock-ladder | #1424 | d69b24c5 |
| feat/1347-folder-map-core | #1403 | 046db04e |
| feat/plur-remote | #1415 | 70b0ee30 |
| fix/1274-inject-delivery | #1276 | 5aa81a5f |
| fix/inject-task-file-perms | #1395 | 4ee5aaa4 |
| fix/h1-session-key-1276 | #1396 | b30997ba |
| fix/1301-watchdog-lock | #1353 | 6e91d675 |
| fix/1343-codex-hook-lock | #1349 | 7a0c9c11 |
| fix/1269-hook-outbox-flush | #1277 | 3dfde334 |
| fix/h1-session-end-reader-1277 | #1400 | 34b890a3 |
| fix/inject-embedding-warmup | #1414 | bf5f6866 |
| feat/1347-folder-map-hooks | #1418 | 04dd7700 |
| fix/hook-stdout-silent | #1422 | 2b73041e |

How the merge conflicts were resolved (build only, nothing carried into any
PR):

- **CHANGELOG.md:** both sides kept everywhere. Some entries may now appear
  twice.
- **The migrate package's method-list test (#1415):** both lists kept.
- **cli `hook-inject.ts` (#1349):** only the placement of a declaration
  conflicted. The branch side was kept.
- **cli `init.ts` (#1418):** the `buildEnforcementHooks(HookLaunch | string)`
  signature was kept.
- **cli `hook-learn-check.ts` and its checkpoint test (formal-lean, #1401):**
  the field-report side was kept, which puts the stop counter in the vetted
  hook state dir.
- **The formal findings note on adapters (`adapters.md`):** formal-lean's text
  was taken.
- **The plur-yaml fixtures:** they stay deleted, as #1418 moved them.

After the merges, `pnpm build` of core, ui, mcp and cli passed, and so did
`tsc --noEmit` for cli and core.

## Results per check, shell and home

Editors: **CC** = Claude Code, **Cx** = Codex, **Cu** = Cursor,
**Ag** = Antigravity. Claude Code string hooks ran through bash and pwsh only,
the two shells Claude Code uses on Windows. It has no `cmd` row.

| Check | bash · plain | bash · spaced | pwsh · plain | pwsh · spaced | cmd · plain | cmd · spaced |
|---|---|---|---|---|---|---|
| (a) first prompt asks, second does not | PASS all 4 | PASS all 4 | PASS all 4 | PASS all 4 | PASS Cx Cu Ag | PASS Cx Cu Ag |
| (b) "yes" command sets the folder on | **FAIL all 4** | PASS all 4 | PASS all 4 | PASS all 4 | PASS Cx Cu Ag | PASS Cx Cu Ag |
| (c) `plur learn --scope group:e2e/test` reaches the stub (`delivery: remote`) | PASS | PASS | PASS | PASS | PASS | PASS |
| (d) Stop leaves a local rated record and a stub feedback event with `source: auto` | **FAIL all 4** | **FAIL all 4** | **FAIL all 4** | **FAIL all 4** | **FAIL Cx Cu Ag** | **FAIL Cx Cu Ag** |
| (e) re-running `plur init` duplicates no hooks | PASS | PASS | PASS | PASS | PASS | PASS |
| (f) every MCP entry answers tools/list | PASS (4 entries) | PASS | PASS | PASS | PASS | PASS |

The SessionEnd / stop hooks exited 0 in every cell. `plur init` and
`plur stores add` exited 0 in both homes. In (e), the hook counts stayed at
Claude Code 14, Cursor 5, Codex 6 and Antigravity 3, and the MCP entries stayed
at 4. The MCP entries (f) were in `.claude/settings.json`, `.cursor/mcp.json`,
`.gemini/config/mcp_config.json` and `.config/opencode/opencode.json`. On
Windows every one of them is `node.exe <prefix>\node_modules\@plur-ai\mcp\dist\index.js`,
and each answered with 14 tools. Codex's MCP entry is skipped by design: init
says "the `codex` binary is not on PATH".

## Findings

### F1 — (d) no feedback outcome in a folder turned on through the folder map (owner: #1318, with #1418)

After the "yes", the next prompt injects the team engram in Claude Code,
Codex and Antigravity. The end-of-turn hook then rates nothing: no `.rated`
file and no feedback reaches the stub. `hook-auto-rate` still gates on
`isPlurConfigured(cwd)`, the project-marker check (`packages/cli/src/commands/hook-auto-rate.ts`,
both the agy branch and the others). The folder map (#1418) is not consulted,
so a folder that is on only through `folders.yaml`, which is exactly what the
ask flow produces, is skipped. The control run confirms it: the same hook with
nothing changed except a `.plur.yaml` in the folder rates at once. This is the
same behaviour as on macOS.

```
FAIL  [spaced] pwsh claude (d) prompt#3 showed the engram=true; injected ids=["ENG-GE2-SRV-001","ENG-GE2-SRV-002"]; end-of-turn hooks=2 exits=0,0; worker idle=true; local rated=[]; stub feedback new=[]; files in plur-auto-rate: claude-e2e-spaced-pwsh-claude-….injected
N/A   [spaced] pwsh claude (d-control) with .plur.yaml in the folder: exits=0,0; local rated=["ENG-GE2-SRV-001","ENG-GE2-SRV-002"]; stub feedback new=[{"signal":"positive","source":"auto"},{"signal":"positive","source":"auto"}]
```

The fix belongs in #1318, or in #1418 if that lands second: auto-rate should
gate on `hookFolderOn(dir)` (lib/folder-gate.ts) like the other hooks.

### F2 — (b) in Git Bash the "yes" command fails when the folder path has no space (owner: #1418)

`folderAskOnce` (`packages/cli/src/lib/folder-gate.ts`, `quoted()`) quotes the
folder only when it contains characters outside `[A-Za-z0-9_./:\\~-]`, and
backslash counts as safe. A Windows path without a space is therefore printed
unquoted. Bash strips the backslashes, the CLI receives a relative path, and
the nonce check correctly refuses it. The failure is safe, since nothing is
written, but the user's "yes" does nothing in Claude Code's default Windows
shell. With a spaced home the path is quoted and bash passes. pwsh and cmd pass
in both homes.

```
FAIL  [plain] bash claude (b) ran: plur folders set C:\Users\runneradmin\AppData\Local\Temp\e2euserPLra2m\work\never-registered-bash-claude --scope group:e2e/test --nonce 5006… -> exit 1; stdout={"success":false,"error":"That nonce was issued for C:\\Users\\runneradmin\\…\\never-registered-bash-claude, not C:\\Users\\runneradmin\\…\\never-registered-bash-claude\\UsersrunneradminAppDataLocalTempe2euserPLra2mworkn…"}; policy={"mode":"ask",…}
```

Fix: always quote a path that contains a backslash, or print it with forward
slashes. Any failure of (d) in the bash · plain column follows from this
failure.

### F3 — (d) Cursor gets no team memory at all (owner: #1200, known; not a field-report PR)

Cursor's sessionStart hook injects with BM25 only and never dials the url
store (`hook-cursor-session-start.ts`, the #1198 / #1200 note), so it injects
`0 engrams` and there is nothing to rate. This is documented behaviour. It
means the done-when cannot be met in Cursor until #1200 lands.

```
FAIL  [spaced] pwsh cursor (d) prompt#3 showed the engram=false; injected ids=[]; … prompt#3 output: [PLUR Memory — session started, 0 engrams injected]
```

## What was not covered

- **Not tested:** a live editor session, how each editor itself quotes or
  spawns a hook string, and whether the model actually runs the "yes" command.
- **Not simulated:** Codex's `/hooks` trust step. Init prints it as a manual
  step.
- **opencode:** it has no hook commands. Only its MCP entry was checked (f).

Evidence artifacts (full logs, hook files, MCP entries, results.json) are
attached to the run as `e2e-fresh-install-plain` and `e2e-fresh-install-spaced`.
The logs are redacted: the test token is replaced with `***`.

## Re-run 2026-09-30 (after #1418 fdb40374)

**Result: met on Windows, with one known exclusion: feedback in Cursor
(#1200).** This is still not a live editor session. As in the first run, the
editors' exact hook strings and MCP entries were run, not the editors.

- Run: https://github.com/plur-ai/plur/actions/runs/36690132077. Both jobs
  report "failure", and the only failing check in each is the Cursor
  exclusion below.
- Branch `e2e/windows-fresh-install` @ `f0e1e20e`. This is the first run's
  branch plus a merge commit of `feat/1347-folder-map-hooks` @ `fdb40374`
  (#1418, which now includes #1318). The harness and assertions are unchanged.
- The merge had conflicts in the cli `hook-inject.ts` imports and the
  `recordInjected` call site, in `docs/runbooks/hook-timeouts.md` and in the
  CHANGELOG. In each I kept the side already on the branch, which carries both
  PRs' content (`recordInjected` is still called once on the injection path),
  and kept both sides of the CHANGELOG. After the merge, `pnpm build` and cli
  `tsc --noEmit` both exit 0.
- Both of the first run's findings are fixed in this build:
  - F1 is gone: `hook-auto-rate` now checks the folder map (`hookFolderOn`).
  - F2 is gone: `quoted()` now quotes any path that contains a backslash.

Each cell gives the checks that passed out of the checks that count. **CC** = Claude Code, **Cx** = Codex,
**Cu** = Cursor, **Ag** = Antigravity. Claude Code does not use cmd.

| Check | bash · plain | bash · spaced | pwsh · plain | pwsh · spaced | cmd · plain | cmd · spaced |
|---|---|---|---|---|---|---|
| (a) asks once | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 3/3 | PASS 3/3 |
| (b) "yes" sets the folder on | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 3/3 | PASS 3/3 |
| (c) learn reaches the url store | PASS | PASS | PASS | PASS | PASS | PASS |
| (d) local rated record + stub feedback with `source: auto` | PASS CC Cx Ag | PASS CC Cx Ag | PASS CC Cx Ag | PASS CC Cx Ag | PASS Cx Ag | PASS Cx Ag |
| (d) Cursor | excluded (#1200) | excluded | excluded | excluded | excluded | excluded |
| (e) re-init, no duplicate hooks | PASS | PASS | PASS | PASS | PASS | PASS |
| (f) MCP entries answer tools/list | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 | PASS 4/4 |

In each home, 59 of the 62 checks passed and 3 failed. The 3 failures are the
Cursor (d) cells, one per shell. They are listed as a known exclusion and are
**not** counted as passes. Cursor's sessionStart hook injects with BM25 only and never dials the
url store, so there is nothing to rate:

```
FAIL  [plain] bash cursor (d) prompt#3 showed the engram=false; injected ids=[]; … prompt#3 output: [PLUR Memory — session started, 0 engrams injected]
```

Excerpts from the log (plain home, Git Bash; this was the failing case in the first run):

```
PASS  [plain] bash claude (b) ran: plur folders set "C:\Users\runneradmin\AppData\Local\Temp\e2euserUNkxpo\work\never-registered-bash-claude" --scope group:e2e/test --nonce 2c3d… -> exit 0; … policy={"mode":"on","scope":"group:e2e/test",…}
PASS  [plain] bash claude (d) prompt#3 showed the engram=true; injected ids=["ENG-GE2-SRV-001"]; end-of-turn hooks=2 exits=0,0; worker idle=true; local rated=["ENG-GE2-SRV-001"]; stub feedback new=[{"signal":"positive","source":"auto"}]
```

In this run the fallback control step (which adds a `.plur.yaml` to the folder
after a (d) failure) never fired, because every (d) failure was a Cursor cell,
where nothing had been injected.
