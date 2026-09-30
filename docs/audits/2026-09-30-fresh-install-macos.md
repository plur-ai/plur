# Fresh install on macOS, end to end — 2026-09-30

The field report's done-when:

> A fresh install, in a never-registered folder, asks once; on "yes" it writes an
> engram that reaches the url store, and produces a feedback outcome.

It was checked with the packed product (tarballs installed into a temp npm prefix),
a real Claude Code session (2.1.285) driving the hooks `plur init` wrote, and the
in-repo stub server as the url store. No production or remote store was used. The
test token was generated for this run, read from a 0600 file, and never printed.
Every evidence file was checked for it (0 matches).

## Result

| Check | Result | Evidence |
|---|---|---|
| (a) First prompt asks once; a second prompt in the same session does not | **Pass** | [Session 1](#session-1-proj-a-ask-yes-learn) |
| (b) After "yes", `folders.yaml` has the folder, on, with a scope | **Pass** | [folders.yaml](#foldersyaml-after-yes) |
| (c) An engram learned with scope `group:e2e/test` reaches the stub | **Pass** | [Stub log](#stub-log) (POST /api/v1/engrams, 201) and GET |
| (d) End-of-turn auto-rate writes a rated record locally and a `source: auto` feedback event at the stub | **Fail** | [Auto-rate](#check-d-auto-rate) — the hook exits before queueing. Owner: #1318 |
| (e) A folder answered "never here" gets no injection | **Pass** | [proj-b](#check-e-never-here-proj-b) |

So the done-when is **not met**. Asking, the yes, and the learn that reaches the
store work. The feedback outcome does not happen in a folder that the folder map
turned on. With the gate bypassed by hand (a diagnosis control, not a pass), the
rest of the auto-rate path does work: a rated record and `{"signal":"positive","source":"auto"}` at the stub.

## Findings

1. **The auto-rate Stop hook still uses the old project-marker gate (fails d).**
   `packages/cli/src/commands/hook-auto-rate.ts` returns early unless
   `isPlurConfigured(cwd)`. That check looks only for `.mcp.json`,
   `.claude/settings*.json` with a `plur` server, `.cursor/mcp.json` or `.plur.yaml`.
   It does not read the folder map, so a folder the user turned on with "yes" is
   treated as unconfigured. The injected id was recorded (`claude-<session>.injected`),
   but no `.queue` and no `.rated` file was written, and the stub got no feedback call.
   #1418 moved every other hook to `hookFolderOn`. `hook-auto-rate` comes from #1318,
   which is not on #1418's branch, so it was never converted. **Owner: #1318**
   (auto-rate). Whichever of #1318 and #1418 lands second has to switch this gate
   to the folder map.
2. **The "yes" fails if it comes in a new process (`--resume` / `--continue`).**
   The first attempt used `claude -p` and then `claude -p --resume` for the answer.
   The answer turn failed with `{"success":false,"error":"Unknown or already-used nonce; nothing was changed.","code":"nonce-unknown"}`.
   `folder-nonces/` was empty. The SessionEnd hook that ends the first process calls
   `endFolderNonceSession`, which deletes the session's nonces, and the resumed
   session keeps the same session id. The question promises the answer can come on
   a later prompt. That is true within one process, but not for a user who quits and
   resumes, or for headless `-p` + `--resume` use. The checks above were then re-run
   in one Claude Code process with several turns (`--input-format stream-json`),
   the way an interactive session behaves. There the nonce file existed after turn 1,
   and it was consumed by the yes. **Owner: #1418** (session-end nonce expiry).
3. **`plur init` run in a non-home folder puts the prompt hooks in that folder only.**
   The first `plur init`, run from the temp root, wrote `UserPromptSubmit` and the
   Stop hooks to `<cwd>/.claude/settings.json`, and only the four enforcement hooks
   to `~/.claude/settings.json`. Every other folder then gets no `hook-inject`, so a
   never-registered folder is never asked. The run below used `plur init` from
   `$HOME`. With the folder map deciding per folder, the default of project-scoped
   injection hooks works against "asks once in any folder". Owner: `init.ts`
   `findSettingsPath` (the folder-map design, #1347/#1418, should decide the default).
4. **`plur init` from `$HOME` drops the enforcement hooks when HOME is not a
   canonical path.** With `HOME=/tmp/…` (a symlink to `/private/tmp` on macOS),
   `homedir()` and `process.cwd()` differ as strings. Init then took the two-file
   branch for one file, and the second write removed the session-guard, session-remind,
   session-end and session-mark hooks. Init still reported "already up to date"
   (saved: `settings-after-init-symlinked-home.json`). With a canonical HOME it is
   correct. This is minor (real homes are rarely symlinks), in `init.ts` on main.
5. **The formal-verification branch could not be built with the field-report PRs.**
   Merging `verify/formal-lean` (#1228) onto the combined tree conflicted in 18 files
   (62 hunks). A mechanical resolution to the field-report side does not compile:
   `core/src/index.ts` has about 40 unresolved names. That tree is kept locally as
   `e2e/with-formal-attempt-2026-09-30`. The build under test **excludes #1228 and
   `fix/h1-session-key-1228`**, which contains it.
6. Harness limitation, not a product finding: the stub's `POST /api/v1/recall`
   serves only rows a test sets by hand. The first recall after the learn returned
   nothing (session 2, 0 injected). The harness was restarted on the same port,
   seeded with the stub's own GET response, and now answers recall from its stored
   rows, as a real server does.
7. Minor: the learn result lists the new engram as its own near-duplicate
   (`"near_duplicates":[{"id":"ENG-GE2-SRV-001","score":0.99999…}]`, `decision: ADD`).
   This is probably the remote echo being scored against the new row. Not investigated.

## Isolation

- Every plur command ran with `HOME`, `PLUR_PATH` and `TMPDIR` under `/private/tmp/pe2e.LXlt`
  (`scripts/e2e/iso.sh`). The path is short because tsx's IPC socket path overflowed
  under the scratchpad dir.
- **Login under the temp HOME failed**: `claude -p` returned
  `Not logged in · Please run /login` (the hooks still ran and the question was
  already correct; see `06a`). As the task allowed, Claude Code was then run with the
  real HOME only to use the existing login. No API key was set or used. It loaded
  **no real user settings** (`--setting-sources project`, and the project folders
  have none) and **no real MCP servers** (`--strict-mcp-config`). The hooks are
  exactly the ones init wrote, taken from the temp `~/.claude/settings.json`, each
  prefixed with `env HOME=<temp> PLUR_PATH=<temp> TMPDIR=<temp>`
  (`scripts/e2e/make-settings.py`). That prefix is needed because several hook paths
  use `homedir()/.plur` directly (for example `hook-inject`'s remote log dir). The
  plur MCP server init registered was passed with `--mcp-config` and the same temp
  env. `Bash(plur:*)` and `mcp__plur__*` were pre-allowed. Claude Code wrote its own
  transcripts under the real `~/.claude/projects/-private-tmp-pe2e-LXlt-work-*`.
- Real `~/.claude/settings.json`: sha256 `ec4647d5737f…` before and after, **identical**.
- Real `~/.plur`: 2138 files hashed before and after. Three files changed:
  `engrams.yaml`, `history/2026-09.jsonl` and `observations/2026-09-30.metadata.jsonl`.
  None of them contains any string from this run (`blue-heron`, `pe2e.LXlt`,
  `e2e/test`, `ENG-GE2`: 0 matches). The last history record belongs to a session
  that is not one of this run's. These changes come from the live Claude Code
  sessions on this machine, including the one driving this test, whose own plur hooks
  observe its tool calls. They are not writes by the run under test. A byte-identical
  check of `~/.plur` cannot be done while other sessions use it.

## Build

Local branch `e2e/fresh-install-2026-09-30` (not pushed), head `10f23b5e`, built from
`origin/main` `05bcb51b` plus these PR heads, merged in this order:

| Branch (PR) | Head merged |
|---|---|
| feat/1265-stores-add-url (#1272) | 99b98088 |
| fix/1264-learn-delivery (#1273) | 04eff335 |
| fix/1268-shared-recurrence (#1275) | 26441314 |
| fix/1274-inject-delivery (#1276) | 5aa81a5f |
| fix/1269-hook-outbox-flush (#1277) | 3dfde334 |
| feat/1310-auto-rate (#1318) | d2073268 |
| fix/1319-duplicate-primary-store (#1334) | 8f83367c |
| fix/1317-secret-token-prefixes (#1340) | d1c072b5 |
| fix/1343-codex-hook-lock (#1349) | 7a0c9c11 |
| fix/1301-watchdog-lock (#1353) | 6e91d675 |
| fix/inject-task-file-perms (#1395) | 4ee5aaa4 |
| fix/h1-session-key-1276 (#1396) | b30997ba |
| fix/1354-empty-lock-takeover (#1398) | 89307064 |
| fix/h1-session-end-reader-1277 (#1400) | 34b890a3 |
| fix/1354-lock-ladder (#1424) | d69b24c5 |
| fix/hook-stdout-silent (#1422) | 2b73041e |
| fix/inject-embedding-warmup (#1414) | bf5f6866 |
| feat/1347-folder-map-core (#1403) | 046db04e |
| feat/1347-folder-map-hooks (#1418) | 04dd7700 |
| feat/plur-remote (#1415) | 70b0ee30 |
| verify/formal-lean (#1228) | e006b9db — **merged, did not build, excluded** |
| fix/h1-session-key-1228 (#1401) | 1fa87f2c — **excluded** (contains #1228) |

`fix/1267-windows-init` (#1270, head ed993537) was not merged: it is a Windows-only
change, and it was missed when the list was built. It does not affect a macOS run.

Conflicts, resolved for the build only:

- CHANGELOG.md: union, in almost every merge.
- #1273, #1277, #1318, #1415: `core/src/index.ts` and `migrate/test/method-list.test.ts`,
  union. Duplicate `remote-store.js` imports were merged into one line.
- #1334: `cli/src/commands/doctor.ts` by hand, keeping both `checkOutbox` and
  `findIgnoredDuplicateStores` and both report fields. `cli/src/index.ts` help: union.
- #1349 into `hook-inject.ts`: kept #1349's `injectForHook` path and re-added #1318's
  `recordInjected` after it. #1318's try/catch copy was dropped.
- #1395: `hook-inject.ts` by hand (session-task helpers, #1353's `heldInjectLock`, the
  auto-rate import).
- #1396: `readableMarkerPath` adapted to #1395's nullable `sessionMarkerPath`.
- #1414: `hook-inject.ts` keeps the warm-up start, then #1349's `exitWhenStoreIdle`
  instead of `process.exit`.
- #1403: `core/src/folders.ts` keeps main's `findEntryIndex` `{applied, nameOnly}`,
  with #1403's F2 trust revocation on remove adapted to it.
- #1418: `hook-cursor-stop.ts` and `hook-session-end.ts` keep #1277's
  run/closeSession split and flush, with the folder gate replacing `isPlurConfigured`
  inside it. **In this build the outbox flush still runs in folders that are off.**
  This did not affect the checks.

After that: `pnpm install && pnpm build` succeeded. `pnpm pack` was used for core,
mcp and cli, not `npm pack`, because `npm pack` leaves `workspace:*` in the
dependencies and the tarballs would not install. The three tarballs (0.20.1) were
installed with `npm install -g --prefix <temp>/prefix`.

## Commands and output

Token shown as `<redacted>`. `S` is the run's scratch dir, and `R=/private/tmp/pe2e.LXlt`.

### Store and init

```
$ tsx scripts/e2e/stub-harness.ts        # E2E_TOKEN_FILE, E2E_STUB_LOG, E2E_URL_FILE, E2E_SCOPE=group:e2e/test
stub listening at http://127.0.0.1:58474 (scope group:e2e/test; token not shown)
$ curl -H "Authorization: Bearer <redacted>" http://127.0.0.1:58474/api/v1/me
{"username":"e2e-user","org_id":"e2e","role":"developer","scopes":["group:e2e/test"],"capabilities":["feedback.source"]}

$ cd $R/home && iso.sh plur init
Enforcement hooks (4, always global): upgraded
Injection hooks (9): upgraded
Enforcement file: /private/tmp/pe2e.LXlt/home/.claude/settings.json
  -> hooks: SessionStart [hook-session-remind, hook-inject --rehydrate], SessionEnd [hook-session-end],
     PreToolUse [hook-session-guard, hook-inject --event plan_mode|skill|agent, hook-observe],
     PostToolUse [hook-session-mark, hook-observe --post], UserPromptSubmit [hook-inject],
     SubagentStart [hook-inject --event subagent], Stop [hook-learn-check, hook-auto-rate claude]

$ plur stores add --url http://127.0.0.1:58474 --token <redacted> --scope group:e2e/test
{"success":true,"status":"added","url":"http://127.0.0.1:58474","scope":"group:e2e/test","username":"e2e-user","message":"Added store: http://127.0.0.1:58474 (scope: group:e2e/test)"}
$ plur stores list
{"stores":[{"path":"/private/tmp/pe2e.LXlt/plur/engrams.yaml","scope":"global",...},{"url":"http://127.0.0.1:58474","scope":"group:e2e/test","shared":true,"readonly":false,"engram_count":0}],"count":2}
```

### Session 1 (proj-a: ask, yes, learn)

```
$ cd $R/work/proj-a && PLUR_PATH=$R/plur TMPDIR=$R/tmp python3 scripts/e2e/drive.py ...
  claude -p --input-format stream-json --output-format stream-json --verbose --include-hook-events
         --setting-sources project --settings fallback-settings.json
         --strict-mcp-config --mcp-config fallback-mcp.json --allowedTools 'Bash(plur:*)' 'mcp__plur__*'
```

Turn 1, "What is the capital of France? Answer in one word.":

```
HOOK UserPromptSubmit: [PLUR Memory — no decision for this folder yet, so no memories were loaded] /private/tmp/pe2e.LXlt/work/proj-a
Before you continue, ask the user once whether to use PLUR memory in this folder, and run the command for their answer:
- Yes: plur folders set /private/tmp/pe2e.LXlt/work/proj-a --scope group:e2e/test --nonce 8a70…2ebc (or … --on --nonce … without a team scope)
- Not now: run nothing. This session will not ask again.
- Never here: plur folders set /private/tmp/pe2e.LXlt/work/proj-a --off --nonce 8a70…2ebc
The nonce works once, only for this folder. Run nothing without the user's answer. After a yes, memory loads from the next prompt.
ASSISTANT: Paris.  Separately, PLUR memory hasn't been set up for this folder yet. Do you want to use it here? …
e2e_note folder_nonces: ["08ba23b5-….yaml"]
```

Turn 2, "And the capital of Italy?": `HOOK UserPromptSubmit` printed nothing, and the reply was `Rome.` It did not ask again.

Turn 3, "Yes, use PLUR memory here with the team scope group:e2e/test.":

```
TOOL_USE Bash: plur folders set /private/tmp/pe2e.LXlt/work/proj-a --scope group:e2e/test --nonce 8a70…2ebc
TOOL_RESULT: {"success":true,"entry":{"path":"/private/tmp/pe2e.LXlt/work/proj-a","scope":"group:e2e/test"}}
e2e_note folder_nonces: []
```

Turn 4, "Please remember this in PLUR memory, scoped group:e2e/test: the e2e harness marker word is blue-heron-42.":

```
HOOK UserPromptSubmit: [PLUR Memory — session started, 0 engrams injected] … Project scope: group:e2e/test — use this scope for plur_learn calls
TOOL_USE mcp__plur__plur_learn {"statement":"The e2e harness marker word is blue-heron-42.","scope":"group:e2e/test",…}
  (the session guard denied the first call once and asked for plur_session_start; the model called it, then learned)
TOOL_RESULT: {"id":"ENG-GE2-SRV-001","scope":"group:e2e/test","decision":"ADD","delivery":"remote",…}
```

#### folders.yaml after yes

```
$ cat $R/plur/folders.yaml
version: 1
folders:
  - path: /private/tmp/pe2e.LXlt/work/proj-a
    scope: group:e2e/test
$ plur folders list
{"folders":[{"path":"/private/tmp/pe2e.LXlt/work/proj-a","scope":"group:e2e/test"}],"count":1}
```

The entry is on by having a scope (there is no explicit `plur: on`). The next prompt
confirmed it: "session started … Project scope: group:e2e/test".

#### Stub GET after the learn

```
$ curl -H "Authorization: Bearer <redacted>" '…/api/v1/engrams?scope=group%3Ae2e%2Ftest'
{"rows":[{"id":"ENG-SRV-001","scope":"group:e2e/test","status":"active",
  "data":{"statement":"The e2e harness marker word is blue-heron-42.","type":"terminological",…,
          "idempotency_key":"55d3d088-f2fc-4b72-ad9a-7da7c56465cd"}}],"total_count":1}
```

### Finding 2 evidence: the yes in a resumed process

```
$ claude -p "What is the capital of France? …"            # session 9449fa5b-…, question asked, nonce aae0…e903
$ claude -p "And the capital of Italy? …" --resume 9449fa5b-…   # no question
$ claude -p "Yes, use PLUR memory here with the team scope group:e2e/test." --resume 9449fa5b-…
TOOL_USE Bash: plur folders set /private/tmp/pe2e.LXlt/work/proj-a --scope group:e2e/test --nonce aae0…e903
TOOL_RESULT: Exit code 1 {"success":false,"error":"Unknown or already-used nonce; nothing was changed.","code":"nonce-unknown"}
$ ls $R/plur/folder-nonces      # empty; folders.yaml absent
```

### Check (d): auto-rate

Session 3 in proj-a, after the harness was restarted with recall serving stored rows:

```
HOOK UserPromptSubmit: [PLUR Memory — session started, 1 engrams injected] …
[ENG-GE2-SRV-001] The e2e harness marker word is blue-heron-42.
ASSISTANT: The e2e harness marker word is **blue-heron-42**.
HOOK Stop exit=0 (hook-learn-check), HOOK Stop exit=0 (hook-auto-rate claude)
$ ls $R/tmp/plur-auto-rate      (20 s later)
claude-5b5856a0-….injected      # only this file: no .queue, no .rated
stub log: no /feedback request
```

The same Stop payload replayed into the installed hook by hand
(`scripts/e2e/step-autorate-manual.sh`) was silent too, with exit 0 and no new files.

Control (`scripts/e2e/step-autorate-control.sh`). This is a diagnosis only, not a
pass. It uses the same payload and the same injected id, but cwd is a folder with a
`.mcp.json` naming plur, which the old gate accepts:

```
claude-e2e-control-0001.injected  ENG-GE2-SRV-001
claude-e2e-control-0001.rated     ENG-GE2-SRV-001
stub: POST /api/v1/engrams/ENG-SRV-001/feedback 200 {"signal":"positive","source":"auto"}
```

### Check (e): never here (proj-b)

The first session asked the same question, and on "Never here…" the model ran:

```
plur folders set /private/tmp/pe2e.LXlt/work/proj-b --off --nonce 3df5…4e12
{"success":true,"entry":{"path":"/private/tmp/pe2e.LXlt/work/proj-b","plur":"off"}}
```

Then a new session in proj-b asked "What is the e2e harness marker word?":

```
HOOK SessionStart:startup exit=0: (empty)       # proj-a's SessionStart prints the session_start reminder; proj-b prints nothing
HOOK UserPromptSubmit exit=0: (empty)            # no question, no memories
ASSISTANT: I don't know the e2e harness marker word: it isn't anywhere in my current context, …
stub log: no /recall request from this session
```

### Stub log

Auth header never logged. `auth: valid` means the header matched the test token.

```
07:50:57 started http://127.0.0.1:58474 scope group:e2e/test capabilities [feedback.source]
07:51:03 GET  /api/v1/me 200                               (manual curl)
07:53:20 GET  /api/v1/me 200                               (plur stores add: /me verify)
07:53:20 GET  /api/v1/engrams?scope=group:e2e/test 200     (plur stores list)
07:57:31 POST /api/v1/recall 200                           (session 1, first injection after yes)
07:57:39 GET  /api/v1/engrams?scope=… 200, GET /api/v1/me 200
07:57:43 POST /api/v1/engrams 201 {"statement":"The e2e harness marker word is blue-heron-42.","scope":"group:e2e/test","type":"terminological"} idempotency_key 55d3d088-…
07:58:30 POST /api/v1/recall 200                           (session 2: stub served no rows, harness limitation)
07:59:18 GET  /api/v1/engrams?scope=… 200                  (manual curl, the GET above)
-- restart: recall serves stored rows; seeded from the GET above; same port --
08:00:06 POST /api/v1/recall 200 served [ENG-SRV-001] scopes [group:e2e/test]   (session 3)
   (no /feedback request after session 3's Stop: finding 1)
08:01:29 GET  /api/v1/me 200; GET /api/v1/engrams/ENG-SRV-001 200 ×3            (control)
08:01:29 POST /api/v1/engrams/ENG-SRV-001/feedback 200 {"signal":"positive","source":"auto"}   (control)
```

## Files

- `scripts/e2e/stub-harness.ts`: wraps the stub without editing it. It sets the /me
  capability, logs requests, and adds optional seed, fixed port and recall-from-stored-rows.
- `scripts/e2e/iso.sh`, `make-settings.py`, `drive.py`, `view.py`,
  `step-autorate-manual.sh`, `step-autorate-control.sh`: the drivers used above.
  They contain this run's absolute temp paths and are a record of the run, not a
  reusable tool.
