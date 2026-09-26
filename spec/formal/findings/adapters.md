# Findings — Adapters cluster

Model: `PlurSpec/Adapters.lean` (namespace `PlurSpec.Adapters`), checked with
`lake env lean PlurSpec/Adapters.lean` (clean, no sorry/axiom).
Replays ran against the built MCP server (`node packages/mcp/dist/index.js`) over
stdio with PLUR_PATH/HOME in the session scratchpad; driver
`scratchpad/ad-drive.mjs` (mcp-drive.mjs plus `"$N.field"` back-references).

## 1. MCP learn rule drift (mcp-integrations#3) — CONFIRMED+FIXED (4 defects)

Four defects, all confirmed by replay:

(a) `plur_learn_batch` forwarded `pinned` with no `pinnedQuota()` gate, so it could
pin past a full quota that `plur_learn` refuses.
(b) `plur_learn_batch` ignored the session (no `session_id` in its schema, no
`session` in the item context) and the `.plur.yaml` domain default.
(c) `plur_session_end` used `plur.learn(statement, {type, …})`: no `session`, no
domain, not routed. So an ending session's suggestions landed in the *process
slot*, which is the scope of the session that started LAST.
(d) `plur_learn` reported `decision: 'ADD'` for an absorbed duplicate, and its
`learnRouted` fallback always warned "Remote write failed …; engram queued for
retry", even for a local write that was never queued.

Also fixed: the batch tool description said items "take the LOCAL learn path —
remote-scope auto-routing (learnRouted) is not applied". That is false since #930
(core learn-async uses `deps.learnRouted`).

Theorems: `batch_agrees_with_learn`, `end_agrees_with_learn`,
`entry_points_use_named_session` (general), `batch_gate_agrees`,
`gate_admits_good` (non-vacuity), `report_truthful`, `warning_truthful`.
Counterexamples (original code): `orig_end_uses_other_session_scope`,
`orig_batch_uses_other_session_scope`, `orig_batch_bypasses_quota`,
`orig_report_lies`, `orig_warning_lies`.

Replay BEFORE the fix, with config `injection_budget: 10`:
```
plur_learn {pinned:true}                         -> error pinned_quota_exceeded (quota 5, used 41)
plur_learn_batch [{pinned:true}]                 -> decision ADD; engrams.yaml now has 2× "pinned: true"
plur_learn "dup statement here" ×2               -> 2nd returns same id, decision "ADD"
session_start A(project:a), B(project:b)
plur_learn_batch [..] session_id=A               -> scope project:b
plur_session_end session_id=A ["suggestion from session A"] -> recall shows scope project:b
```
Replay AFTER the fix (rebuilt `pnpm --filter @plur-ai/mcp build`):
```
plur_learn_batch session_id=A                    -> scope project:a
plur_session_end session_id=A                    -> recall: "suggestion from session A" scope project:a
plur_learn dup ×2                                -> {"decision":"NOOP","existing_id":"ENG-…-003"}
plur_learn_batch [unpinned, pinned] (quota full) -> ids [id, null], failures[{index:1, error:"pinned_quota_exceeded: …"}]; 1× "pinned: true" on disk
```

Fix (packages/mcp/src/tools.ts):
- batch: `session_id` input; per item `session: _resolveInjectionSession(args)` and
  `domain: e.domain ?? readProjectConfig().domain`; pinned-quota gate (same coarse
  `free <= 0` predicate as plur_learn). A refused item is reported in `failures`
  and the rest of the batch is still written. Indices are remapped so
  `ids`/`input_index`/`failures[].index` stay 1:1 with the input (#281).
- session_end: `learnRouted(sanitizeStatement(s), {type, session: endSession,
  domain: projectDomain, session_episode_id, claim_class})`, where endSession is
  `_resolveInjectionSession(args)`.
- plur_learn: new `learnDecision(engram)` returns `NOOP` + `existing_id` when
  `write_count > 1`, since both hash dedup and cross-scope recurrence bump it.
  The fallback warning now says "queued for retry" only when the engram is in the
  outbox; otherwise it says "Routed write failed (…); stored through the local
  learn() fallback".

Tests: `packages/mcp/test/formal-adapters-learn.test.ts` (6). 5 failed before the
fix; the 6th is the reachable good case. All 6 pass after.
Mutation check (scratch copy of the model): dropping `session` from batchCtx or
endCtx breaks `batch_agrees_with_learn` / `end_agrees_with_learn` and the
fixed_* theorems. `batchAdmits := true` breaks `batch_gate_agrees`, and
`report := .add` breaks `report_truthful`.

Not changed (noted): the batch quota gate is checked once per call. Like plur_learn's
own gate it is coarse, so several pinned items admitted while `free > 0` can still
overshoot together, exactly as several sequential plur_learn calls could before
the last one is refused.

## 2. MCP session lifecycle (mcp-integrations#1) — CONFIRMED+FIXED (2) + NEEDS-OWNER (1)

(a) CONFIRMED+FIXED: id-only TTL sweeps leaked scope registrations. `_implicitSessionId`
and `_resolveScopeSession` call `_cleanExpiredSessions()` with no Plur. That
deletes the telemetry row but not the keyed registration. The comment promised
that "the next plur-bearing sweep" would clear it, but that sweep iterates
`_sessionTelemetry`, where the id no longer is, so the registration leaked for the
life of the process.
Fix: `_pendingScopeEvictions`. An id-only sweep records the ids it expires, and
the next plur-bearing sweep clears them.
Theorems: `sweep_preserves_inv` (every registration is open or pending),
`plur_sweep_no_leak`, `fixed_no_leak`, `live_session_kept` (non-vacuity).
Counterexample: `orig_leaks`.
Replay: vitest with fake Date. Session "old" (project:old) is started, the clock
moves 9h, plur_learn runs, then plur_session_start. On the original code
`trackedSessionScopes()` still contains "old" (test fails); after the fix it
passes. Mutation: dropping `gone` from `pend` breaks `sweep_preserves_inv`
and `fixed_no_leak`.

(b) CONFIRMED+FIXED: an id-less `plur_session_end` was a state no-op. The session
stayed "open" for 8h, so the next session_start made every implicit resolution
ambiguous.
Fix: session_end resolves its session with `_resolveInjectionSession(args)`: the
explicit id, else the lone open session. With several sessions open and no id it
still ends nothing.
Theorems: `orig_idless_end_noop`, `fixed_idless_end_ends_lone`,
`idless_end_ambiguous_ends_nothing`.
Test: `formal-adapters-session.test.ts` › "id-less plur_session_end with one
open session ends it". It fails on the original code: the next plur_learn lands
correctly only by accident of the process slot, and `plur_session_scope show`
warns "sessions are open". It passes after the fix.

(c) NEEDS-OWNER: with two sessions open and no `session_id`, an unscoped
`plur_learn` or `plur_learn_batch` write takes the process slot, which is the
LAST-started session's scope (`ambiguous_learn_takes_last_started`). Replayed:
A(project:a) and B(project:b) are open, and `plur_learn` with no id stores at
project:b. `plur_session_scope set` refuses the same ambiguity. I did not fix it
because the common real cause is a stale session: a client that restarted without
session_end, which survives 8h. Refusing would break every unscoped write for 8h
after a single missed session_end. Question: **when several sessions are open and
a write names neither scope nor session, should it (A) keep using the
last-started session's default (current behaviour; right for the stale-session
case, wrong for true concurrency), (B) refuse with "pass session_id or scope"
(consistent with plur_session_scope; breaks hookless clients after a missed
session_end), or (C) ignore every session default and take the unscoped path
(auto-route / unscoped_default)? (C) needs a core change: a "no session"
sentinel for `SessionScopeRegistry.get`.**
Also noted, not changed: an unknown explicit `session_id` silently falls back to
the process slot (`Registry.get` for an unregistered key). The same question
applies.

Files changed: packages/mcp/src/tools.ts.
Tests: packages/mcp/test/formal-adapters-learn.test.ts (6),
packages/mcp/test/formal-adapters-session.test.ts (2). Neighbouring MCP suites
(tools, session, session-scope-tool, session-provenance,
concurrency-session-attribution, server, content-hash-exposure, measured-under,
outbox-failure-surfaced, e2e, e2e-remote) pass: 206/206.

## 3. Claude settings.json hook merge (cli#1) — CONFIRMED+FIXED (4 defects) + NEEDS-FILE

All four were replayed with the built CLI:
`HOME=<tmp> node packages/cli/dist/index.js init --global --no-desktop`, with a
seeded `~/.claude/settings.json`.
```
BEFORE
prompt   {Stop:[{hooks:[{type:"prompt",prompt:"check"}]}]}      -> exit=1 {"error":"Cannot read properties of undefined (reading 'includes')"}, file untouched
mixed    [{hooks:[npx @plur-ai/cli hook-inject, ./my-lint.sh]}] -> ./my-lint.sh deleted
userplur Stop:[npx @plur-ai/cli learn "session ended"]           -> deleted
win      UserPromptSubmit:[C:\Users\me\.plur\bin\plur-hook.cmd hook-inject] -> kept + new copy appended (2 entries; on Windows every re-run adds one more)
AFTER (init run twice each, both exit 0)
prompt   Stop [["prompt"],[".../plur-hook hook-learn-check"]]
mixed    UserPromptSubmit [["./my-lint.sh"],[".../plur-hook hook-inject"]]
userplur Stop [["npx @plur-ai/cli learn \"session ended\""],[".../plur-hook hook-learn-check"]]
win      UserPromptSubmit [[".../plur-hook hook-inject"]]   (the stale Windows copy is recognised and replaced)
```
Fix (packages/cli/src/commands/init.ts): a new `isPlurHookSpec` is the same
two-part test as codex-hooks.ts. It requires a string command. The binary check
runs after `\` → `/` normalisation (`@plur-ai/cli` or `.plur/bin/plur-hook`), and
the command must also run a `hook-*` subcommand. Every installer version has only
ever written `hook-*` subcommands, so upgrades still strip old installs.
`stripPlurHooks` now works per spec: an entry with no PLUR spec is kept unchanged,
and a mixed entry keeps only its user specs. Test seams: `_mergeClaudeHooks`,
`_isPlurClaudeHookSpec`.

Theorems: `merge_idempotent` (for any settings and any installable hook map),
`merge_preserves_user` (every non-PLUR spec survives), `strip_no_plur`,
`strip_id_of_clean`, `strip_installable`, and `fixed_cases` (the four replay
inputs). Counterexamples on the original code: `orig_prompt_throws`,
`orig_mixed_loses_user`, `orig_user_plur_cli_lost`, `orig_windows_not_idempotent`.
Mutation check: a whole-entry strip breaks `strip_no_plur` and
`merge_preserves_user`. Treating the literal `/` path as the only shim match, or
a binary-only match, breaks `fixed_cases`.
Tests: packages/cli/test/formal-adapters-hooks.test.ts (6). 5 failed on the
original logic; all 6 pass after the fix. init.test.ts, init-codex.test.ts and
init-cursor.test.ts all pass (38 tests in total).

NEEDS-FILE (packages/cli/src/commands/doctor.ts:217, `hasAnyPlurHook`) has the
same literal `.plur/bin/plur-hook` test, so on Windows `plur doctor` reports "no
hooks" for a working install. The exact change: replace the condition with
`typeof h.command === 'string' && (h.command.includes('@plur-ai/cli') || h.command.replace(/\\/g, '/').includes('.plur/bin/plur-hook'))`.
Not changed and noted: `writeSettings` is non-atomic (init.ts ~1171). It was
outside this candidate's property.

## 4. Cursor hooks.json top-level keys (cli#2) and MCP env on repair (cli#3) — CONFIRMED+FIXED (2)

(a) `mergeCursorHooks` returned `{ version, hooks }`, dropping the unknown
top-level keys that `readCursorHooksConfig` had just preserved. Its own comment
said they "survive the round trip".
(b) `upgradePlurMcpEntry(config, { env })` replaced the healed entry's whole env
with the caller's. The Cursor leg passes `{ PLUR_TOOL_PROFILE: 'cursor' }`, so a
user's `PLUR_PATH` was dropped. After that the profile check at init.ts:831 sees
'cursor' and does not re-add anything.

Replay with the built CLI (`scratchpad/c4.sh`): `.cursor/hooks.json` carries
`$schema` and `teamPolicy`, and `.cursor/mcp.json` has a racey
`npx @plur-ai/mcp@latest` entry with env `{PLUR_PATH, PLUR_TOOL_PROFILE: full}`.
Then `plur init --cursor` runs.
```
BEFORE  hooks.json keys: version,hooks                      plur env: {"PLUR_TOOL_PROFILE":"cursor"}
AFTER   hooks.json keys: version,hooks,$schema,teamPolicy   plur env: {"PLUR_PATH":"/data/team-plur","PLUR_TOOL_PROFILE":"cursor"}
```
Fix: cursor-hooks.ts returns `{ ...clean, version, hooks }`; mcp-config.ts uses
env `{ ...existing.env, ...recommended.env }`.
Theorems: `cursor_keeps_extra`, `cursor_idempotent` (via `merge_idempotent`),
`heal_sets_caller_keys`, `heal_keeps_user_keys`, `fixed_heal_keeps_plur_path`.
Counterexamples: `orig_cursor_drops_extra`, `orig_heal_loses_plur_path`.
Mutation check: `extra := []` breaks `cursor_keeps_extra`/`cursor_idempotent`;
env replace breaks `heal_keeps_user_keys`/`fixed_heal_keeps_plur_path`.
Tests: packages/cli/test/formal-adapters-cursor.test.ts (2), both failing before
the fix. cursor-hooks, mcp-config-cursor, init-cursor, mcp-entry-read and init
all pass.
Files: packages/cli/src/cursor-hooks.ts, packages/cli/src/mcp-config.ts.

## 5. CLI exit codes (cli#5): CONFIRMED+FIXED (3) and NEEDS-OWNER (1)

The rule: exit 0 ⇔ the requested mutation succeeded, with the same code in JSON
mode (piped or `--json`) and text mode (a TTY). This is the rule `plur rescope`
already follows (`success = every item not 'error'`, rescope.ts:65).

Replay: `scratchpad/c5.sh` runs the built CLI with PLUR_PATH/HOME in the
scratchpad. Text mode is forced with `node --import fake-tty.mjs`, which sets
`process.stdout.isTTY = true`.
```
                                              BEFORE (json/text)   AFTER (json/text)
feedback --batch [{id:ENG-NOPE-1}] (all fail)      0 / 0              1 / 1
forget "zzqx nonexistent" (no match)               0 / 1              1 / 1
forget "alpha deploy rule" (2 matches, none retired) 0 / 0            1 / 1
scopes register "not a valid scope!!" (refused)    0 / 1              0 / 1   <- NEEDS-OWNER
```
Fix: feedback.ts adds `success` to the batch JSON, lists failed items on stderr
in text mode, and sets `process.exitCode = 1` when any item failed. forget.ts
sets `process.exitCode = 1` on JSON no-match and on multiple matches in both
modes. `exitCode` is used instead of `process.exit()`, so piped JSON is never
truncated: the entry point returns without a forced exit.
Theorems: `fixed_meets_spec_feedback`, `fixed_meets_spec_forget`,
`fixed_mode_independent_changed`, `fixed_success_exit0` (non-vacuity).
Counterexamples: `orig_batch_all_fail_exit0`, `orig_forget_mode_dependent`,
`orig_forget_ambiguous_exit0`. Residue: `residue_scopes_mode_dependent`.
Mutation check: JSON forget back to 0 breaks `fixed_meets_spec_forget` and
`fixed_mode_independent_changed`. An any-success batch breaks
`fixed_meets_spec_feedback`.
Tests: packages/cli/test/formal-adapters-exit.test.ts (8 cases in each mode plus
the good case). 6 failed before the fix, and all 8 pass after it
(`--testTimeout=60000`; machine load was ~300). forget, forget-namespaced,
known-flags, feedback and scopes all pass. Under that load, forget.test.ts timed
out at the default 5s once, and the rerun at 60s passed.

NEEDS-OWNER: `scopes register --json` still exits 0 when registration is refused.
I made the fix and it broke `test/scopes.test.ts` › "register a scope no
configured remote authorizes → reports failure". That test drives the command
through `execSync`, which throws on a non-zero exit, so it pins exit 0
implicitly. I reverted scopes.ts to HEAD. Question: **should a refused
`scopes register --json` exit 1 like text mode, which changes scopes.test.ts:45
to read stdout from the thrown error, or should JSON mode deliberately exit 0
and report failure only in the body?** The one-line change for the first option
is in scopes.ts: after the failure `outputJson(...)`, set `process.exitCode = 1`.
Files: packages/cli/src/commands/feedback.ts, packages/cli/src/commands/forget.ts.

## 6. dsh writes report "Stored." with no engine; timeout vs. queue (mcp-integrations#4): CONFIRMED+FIXED (1) and NEEDS-OWNER (1)

(a) CONFIRMED+FIXED. When core cannot load, the engine facade (engine.ts)
resolves every write to `undefined`. This is deliberate and pinned by
engine.test.ts, "degrades every write to a no-op instead of rejecting". The
tools did `await plur?.learn?.(…); return true`, so plur_learn answered
"Stored.", plur_forget "Retired." and plur_feedback "Recorded." with no engine
at all. The same happened with no client (`plur` undefined). Auto-learn
(learn.ts) bumped `learn_captured`, because its `typeof plur?.learn` guard can
never fire for the facade.
Replay: packages/dsh/test/formal-adapters-dsh.test.ts wires the real
`createEngine(cfg, () => Promise.reject(ERR_MODULE_NOT_FOUND))`,
`registerTools`, `registerLearning` and `createWriteQueue`. Before the fix it
failed 4/5: `expected 'Stored.' not to match /^Stored\./`,
`expected 'Retired.' …`, and `learn_captured` was `expected 1 to be +0`.
After the fix all 5 pass.
Fix: a new `writable(plur, method)` in guard.ts returns true when the method
exists and `ready()`, if the client offers it, resolves true. An injected client
without `ready()` is trusted. The tools return `false` from inside the queue
when it is not writable, which yields "Could not store/retire/record". learn.ts
uses the same check before counting. The facade itself is unchanged
(engine.test.ts intent).
Theorems: `dsh_report_truthful` (reported ⇔ performed, for every client),
`dsh_good_case_reachable`. Counterexample: `orig_dsh_stored_without_engine`.
Mutation check: a typeof-only check breaks `dsh_report_truthful`.
Tests: the whole dsh package passes (23 files, 279 tests).

(b) NEEDS-OWNER: a guard timeout releases the write-queue slot while the write
continues. learn.ts and capture.ts enqueue `queue(() => guard(write, {timeoutMs}))`.
When the guard times out, the queued fn settles and the next write starts while
the first is still running.
Replay (`node --experimental-strip-types scratchpad/q.mts`, real guard.ts):
A (100ms, timeout 10ms) is queued, then B. Result: `A start, B start, B end,
A end`. Serialization is broken. The tools do the opposite,
`guard(() => queue(write))`, so the caller times out but the queue waits for the
write, and a write that never settles wedges every later write. Core's
`_withStoreLock` still serialises the YAML read-modify-write for learn(), so this
is a broken guarantee of the queue rather than observed corruption.
Question: **when a write exceeds `timeoutMs`, should the queue (A) keep
serialising and wait for it (the tools' order, applied to learn/capture too:
risk that one hung write wedges all later writes), (B) release the slot on
timeout (the current learn/capture order: risk of overlapping writes, bounded by
core's store lock), or (C) wait up to a second, larger hard cap and then release
it?**
Files: packages/dsh/src/guard.ts, tools.ts, learn.ts.

## 7. Hermes/Python argv: statement parsed as flags; timeout reads as success (mcp-integrations#7): CONFIRMED+FIXED (hermes) and NEEDS-FILE (CLI, python)

First check: does the CLI honour `--`? **No, not for `learn`.**
`parseGlobalFlags` keeps parsing global flags after `--`: only
`expandEqualsFlags` stops splitting there. `plur learn` has no `--` case, so
`--` itself becomes the statement.
Replay (`scratchpad/c7.sh`, built CLI):
```
plur learn "--dry-run=true is required for deploys" --json --path P  -> exit 1 "Unrecognised flag: --dry-run"
plur learn -- "--dry-run=true is required for deploys" --json        -> exit 0, stored statement "--"   (!)
plur learn "--json" --path P                                         -> exit 1 usage (statement consumed as --json)
plur learn "--path=P/other" --json   (no --path, as hermes sends when plur_path is unset)
                                                                     -> exit 1 usage; the store at P/other was CREATED (packs/)
```
So a bridge could not simply add `--`: that would store "--" for every
statement. The hermes bridge (bridge.py:429) and the python client
(client.py:51) both put the statement straight into argv.

Fix (hermes, packages/hermes/plur_hermes/bridge.py): a statement that begins
with `-` is sent on **stdin**. `plur learn` already reads stdin when it gets no
positional statement. Every other statement stays in argv, so the argv-shape
tests are unchanged. `_run_in_process_group(cmd, timeout, input=None)`, `call()`,
`_call_with_lock_retry()` and `_invoke_cli()` all thread `stdin` through.
Also fixed: `call()` collapses an exhausted timeout into the read-path
`_SAFE_RESPONSE`. test_bridge.py:700 pins this on purpose for `call()`. `learn()`
now turns that response into `{…, timed_out: true, warning: "…unknown whether
the engram was stored…"}`, so a timed-out write no longer looks like an empty
success.
Theorems: `bridge_statement_verbatim`: for every CLI flag reader whose flags all
start with `-`, the stored statement is exactly the one sent.
`ordinary_statement_in_argv` is the non-vacuity check. Counterexample:
`orig_flag_statement_refused`. Mutation check: always sending the statement in
argv breaks `bridge_statement_verbatim`.
Tests: packages/hermes/test/test_formal_adapters_argv.py (4). One of them is end
to end through the real bridge and the built CLI: the statement "--dry-run=true
is required for every deploy" is stored verbatim. 3 of the 4 failed before the
fix and all 4 pass after it. test_bridge.py and test_bridge_process_group.py
pass: 74 in total with the new file. Full hermes suite: 208 passed and 3 failed.
The 3 failures are the test_memory_provider_entrypoint.py entry-point checks.
They also fail on the unmodified bridge.py (checked by restoring HEAD), so they
come from the environment and pre-date this change.

NEEDS-FILE:
- packages/cli/src/commands/learn.ts: honour `--`. In the parse loop, add
  `else if (arg === '--') { if (!statement && i + 1 < args.length) statement = args[i + 1]; break }`,
  or treat everything after `--` as positional.
- packages/cli/src/plur.ts `parseGlobalFlags`: after `--`, push the remaining
  tokens to `args` verbatim, with no global-flag parsing. Without this,
  `learn -- "--json"` still has its `--json` eaten.
- packages/python/plur_ai/bridge.py `run_json`: accept `input: str | None` and
  pass it to `_run_in_process_group`. client.py `learn()` can then use the same
  stdin rule. client.py is mine, but the change needs the bridge first; the
  alternative is the CLI `--` fix above plus `["learn", "--", statement]`.
  The python client already raises on timeout (`PlurError`), so it has no
  timeout-as-success problem.

## 8a. MCP array comma-split coercion (mcp-integrations#9): CONFIRMED and NEEDS-OWNER

`jsonSchemaPropToZod` splits a string on commas when it is sent for an array
whose items accept strings. That includes `engram_suggestions` (union items, a
change made deliberately for the #297 workaround). A single free-text suggestion
that contains a comma therefore becomes several engrams.
Replay (MCP driver, built server):
`plur_session_end {engram_suggestions: "Use pnpm, not npm"}` → `engrams_created: 2`.
Recall then returns two engrams: "not npm" and "Use pnpm".
Theorem (counterexample): `comma_split_breaks_statement`.
Not fixed: server.test.ts:196 pins exactly this ("coerces comma-separated input
for union (anyOf) item schemas" → engrams_created 2), on purpose.
Question: **for array parameters whose items are free-text statements
(`engram_suggestions`), should a bare string (A) keep being comma-split (current;
right for tag-like lists, corrupts sentences), (B) become a one-element array
`[string]` (never corrupts; a client that meant "a, b" as two items gets one
engram), or (C) be refused with the #297 hint, asking for a real array? Tag-like
arrays (`tags`) would keep the split under all three options.**
Also noted, not changed: `integer` maps to `z.number()`, so fractional values
pass validation.

## 8b. init-remote `.plur.yaml` rewrite idempotence (cli#9): CONFIRMED+FIXED

The file claims (init-remote.ts:20-21) that re-running is idempotent. Replay with
the built CLI against a local fake `/api/v1/me` server (`scratchpad/fake-me.mjs`),
running `plur init-remote --url … --token … --scopes group:acme/eng` three times:
BEFORE, the two header comment lines were appended again on every run (three
copies after three runs). AFTER, the sha1 is identical across runs
(`bdba9abbc443` ×3) and there is one header.
Also fixed: `stripRemoteKeys` matched the TRIMMED line, which deleted a user's
nested `  remote_url:` under another key. It now matches top-level lines only.
`readRemoteFromConfig` did not unquote, so it disagreed with core
project-config's `unquoteYamlValue`; it now strips balanced quotes. That
unquoting part is confirmed from the code and covered by the new test, but not
replayed on the original code: the seam I stubbed onto the original failed for
an unrelated reason (ESM `require`).
Fix: packages/cli/src/commands/init-remote.ts. `REMOTE_HEADER` is shared by the
writer and the stripper, keys are matched top-level only, and there is a new
`readRemoteFromContent` with unquoting. Test seams: `_buildConfigBody`,
`_readRemoteFromContent`.
Theorems: `buildY_idempotent`, `buildY_keeps_nested`, `fixed_init_remote_cases`.
Counterexamples: `orig_header_accumulates`, `orig_nested_deleted`.
Mutation check: dropping the header from `ours` breaks `fixed_init_remote_cases`;
trimmed matching breaks `buildY_keeps_nested`.
Tests: packages/cli/test/formal-adapters-init-remote.test.ts (4). Against the
original seams it failed 4/4 (3 on assertions, 1 on the stub). After the fix,
4/4 pass, and init-remote.test.ts passes (10 passed, 4 skipped).
Left out of the model: blank-line trimming and the list-skip state, which the
model abstracts into the line classifier.

## 9. `.plur.yaml` scope trust across adapters (mcp-integrations#2, cli#4): CONFIRMED and NEEDS-OWNER (policy)

Each adapter makes its own decision (`adoptScope`):
- opencode `resolveTrustedScope`: adopts scope/domain only when `isDirectoryTrusted(dir)`.
- MCP `plur_session_start`: adopts `readProjectConfig().scope` as the session
  default, with no trust check anywhere in mcp/src.
- dsh `readWorkspaceScope`: unconditional.
- CLI hooks (hook-inject.ts:376-379): scope/domain "are local filters and need no
  gate". Only the remote_* fields go through `resolveProjectRemote`.

Replay (MCP, server cwd = an untrusted dir containing `.git` and
`.plur.yaml: scope: group:acme/eng`):
`plur_session_start` → `default_scope: "group:acme/eng", scope_source: "project-config"`.
An unscoped `plur_learn "a personal note…"` then lands at `group:acme/eng`. If
the user has that scope registered, it goes to the team server.
Theorems: `adapters_agree_when_trusted` (non-vacuity: every adapter agrees on a
trusted directory) and `adapters_disagree_untrusted` (the counterexample).
Question: **should a `.plur.yaml` in an untrusted directory be able to set the
WRITE default scope and the READ/inject filter? Options: (A) opencode's rule
everywhere: untrusted means ignore scope/domain, warn, and point to `plur trust`.
Safest, but a fresh clone of one's own repo needs one `plur trust`. (B) Split
the grants: an untrusted file may NARROW reads (filter/inject) but may not set a
shared or remote write default, so writes fall back to the local default.
(C) Keep today's split: the three adapters trust the file and opencode does
not. Then opencode's docstring should say why it differs.** A wrinkle in dsh
for any option: `scope: global` in a workspace file yields scopes ['global'],
which contradicts dsh/src/scope.ts:25, "the ambient global store is never a
fallback".

---

## Summary of files changed (Adapters)
- packages/mcp/src/tools.ts (#1, #2)
- packages/cli/src/commands/init.ts (#3), packages/cli/src/cursor-hooks.ts,
  packages/cli/src/mcp-config.ts (#4), packages/cli/src/commands/feedback.ts,
  packages/cli/src/commands/forget.ts (#5), packages/cli/src/commands/init-remote.ts (#8b)
- packages/dsh/src/guard.ts, tools.ts, learn.ts (#6)
- packages/hermes/plur_hermes/bridge.py (#7)
- scopes.ts was touched and then restored to HEAD (#5 residue). client.py is unchanged (#7 NEEDS-FILE).

New tests: packages/mcp/test/formal-adapters-learn.test.ts (6),
formal-adapters-session.test.ts (2); packages/cli/test/formal-adapters-hooks.test.ts (6),
formal-adapters-cursor.test.ts (2), formal-adapters-exit.test.ts (8),
formal-adapters-init-remote.test.ts (4); packages/dsh/test/formal-adapters-dsh.test.ts (5);
packages/hermes/test/test_formal_adapters_argv.py (4).
Rebuilt: `pnpm --filter @plur-ai/mcp build` and `packages/cli` (`pnpm build`) for
the replays. The CLI bundle may include other agents' in-progress core source.

---

## Apply phase (2026-09-26, ApplySurface)

Decision S1 applied: `plur scopes register` exits 1 on a refused registration in
JSON mode too (packages/cli/src/commands/scopes.ts: `process.exitCode = 1` before
the failure `outputJson`, so the body is never truncated). Pinned test changed:
packages/cli/test/scopes.test.ts:45 ("register a scope no configured remote
authorizes → reports failure and exits 1") now reads stdout from the thrown
execSync error and asserts status 1; it failed on the unfixed code. The
text-only guard in formal-adapters-exit.test.ts is removed (both modes, 9/9
pass). Lean: `exitFixed` meets `exitSpec` on every command —
`fixed_meets_spec_scopes`, `fixed_meets_spec` (all commands),
`fixed_mode_independent` (replaces `fixed_mode_independent_changed`),
`fixed_scopes_refused_exit1`; the residue theorem is now
`orig_scopes_mode_dependent` on `exitOrig`. Mutation (json branch back to 0):
`fixed_meets_spec_scopes` and `fixed_scopes_refused_exit1` fail.

Decision S2 applied: a bare string sent for an array param whose items are a
union accepting a string (`anyOf`/`oneOf` — today only `engram_suggestions`) is
one item `[string]`, never comma-split (packages/mcp/src/tools.ts
`jsonSchemaPropToZod`). Arrays with `items: {type: 'string'}` (`tags` and the
other plain string lists) keep the #297 comma split; no other array parameter
shares the union item type, so none else changed. The two #297 hints and the
`engram_suggestions` description say so. Pinned test changed:
packages/mcp/test/server.test.ts:196 (was "coerces comma-separated input for
union (anyOf) item schemas" → engrams_created 2) is now "treats a bare string for
union (anyOf) item schemas as one item": "Use pnpm, not npm" → engrams_created 1,
the statement stored verbatim, no "not npm". It failed on the unfixed code
(2 created); server.test.ts 45/45 after. Lean: `coerce`/`coerceOrig` over
`ItemKind`; `statement_list_verbatim`, `tags_unchanged`, `fixed_coercion_cases`
(the counterexample `comma_split_breaks_statement` stays, for the original).
Mutation (union → `coerceComma`): `statement_list_verbatim` and
`fixed_coercion_cases` fail.

Decision E2 applied: wording only, behaviour unchanged. packages/mcp/src/tools.ts:
the `plur_learn` `visibility` description now says the default "private" excludes
the memory from packs and shared git sync, that an omitted visibility on a
team-scope write still goes to the team store, and that only an EXPLICIT
"private" keeps such a write local (with a warning). The `plur_learn_batch`
description now says its items carry no visibility (default) and a team-scope
item still goes to the team store. Test:
packages/mcp/test/formal-apply-surface-visibility.test.ts (3), 3/3 failed on the
old text, 3/3 pass. No Lean change (the write-path semantics are modelled in
WritePath §4, `team_write_still_pushed` / `explicit_private_stays_local`).

Decision S4 applied (the three NEEDS-FILE fixes of §3 and §7):
(1) packages/cli/src/plur.ts `parseGlobalFlags` stops at `--` and passes the rest
(with `--`) verbatim; packages/cli/src/commands/learn.ts takes the token after
`--` as the statement and stops parsing (usage line documents it). known-flags.ts
already stopped at `--`. Test packages/cli/test/formal-apply-surface-argv.test.ts
(5): 4 failed before (the parser test and three built-CLI replays: `--` stored
literally, `--path=…` inside a statement, `--json` as a statement), 5/5 after.
Replay with the built CLI (HOME/PLUR_PATH in scratchpad/s4p):
`learn --json --path P --scope global -- "--dry-run=true is required for deploys"`
→ exit 0, statement stored verbatim; `-- "--path=P/other is the fixture dir"` →
stored, `P/other` not created. Residue (not my file): cli/src/index.ts checks
`argv.includes('--help'|'--version'|'-h'|'-v')` over the WHOLE argv before
parsing, so `learn -- "--help"` still prints help and exits 0.
(2) packages/cli/src/commands/doctor.ts `hasAnyPlurHook` normalises `\` → `/`
and requires a string command (seam `_hasAnyPlurHook`). Test
formal-apply-surface-doctor.test.ts (3): the Windows-shim case failed before,
3/3 after; doctor.test.ts 32/32, doctor-timeout 6/6.
(3) packages/python/plur_ai/bridge.py: `_run_in_process_group(…, input=None)`
and `run_json(…, input=None)` (stdin piped only when input is given, else
inherited as before); client.py `learn()` sends a statement starting with `-`
on stdin. Test packages/python/tests/test_formal_apply_surface_argv.py (4,
incl. an end-to-end run through the built CLI): 3 failed before, 4/4 after;
with test_bridge_process_group.py and test_client.py 12 passed.
Lean: §7 `learnParse`/`globalPath` — `learn_sep_verbatim` (any flag prefix,
`-- st` stores st), `takeWhile_sep`, `statement_never_selects_store`,
`fixed_sep_cases`, `path_before_sep_kept` (non-vacuity), counterexamples
`orig_sep_stored_literally`, `orig_statement_selects_store`. §3
`doctorDetects`: `doctor_sees_installed` (every spec init installs is seen),
`doctor_ignores_user`, counterexample `orig_doctor_misses_windows`. `deliver`
(§7) now documents that it is the python client's rule too, so
`bridge_statement_verbatim` covers it. Mutations: removing the `--` case breaks
`learn_sep_verbatim` + `fixed_sep_cases`; `globalPath` without `takeWhile`
breaks `statement_never_selects_store` + `fixed_sep_cases`; doctor with
`!winPath` breaks `doctor_sees_installed`.

Decision S3 applied: packages/dsh/src/guard.ts `createWriteQueue({hardCapMs,
onRelease})` holds the slot until the write settles or the hard cap elapses;
at the cap it releases the slot, calls `onRelease` and resolves `undefined`
(the timer is `unref`'d so a hung write cannot keep the host alive). Cap:
`WRITE_HARD_CAP_MS = 60_000`, wired in index.ts as `max(60 000, timeoutMs)`;
60 s is core's store-lock stale threshold (`DEFAULT_STALE_THRESHOLD`), past
which a still-running write has lost the lock's guarantee anyway. `onRelease`
bumps `errors_swallowed` and `console.warn`s. learn.ts and capture.ts now
enqueue `queue(() => contain(write, onError))` (`contain` = guard with no timer,
new in guard.ts; `guard` treats a non-finite `timeoutMs` as "no timer"), so the
soft timeout no longer releases the slot. Tools are unchanged
(`guard(() => queue(write), soft)`): UNAVAILABLE at the soft timeout, write
keeps the slot. README/config docstring for `timeoutMs` updated. Test:
packages/dsh/test/formal-apply-surface-queue.test.ts (4): 2 failed before
(auto-learn past soft timeout overlapped: order start1,start2,…; a never-settling
write wedged the queue), 4/4 after; whole dsh package 24 files / 283 tests pass.
Lean §6: `holdFor`/`overlaps`; `fixed_serialises_within_cap`, `fixed_bounded`,
`caller_wait_soft`, `fixed_replay_serialised`, `hung_released_at_cap`
(non-vacuity), counterexample `orig_overlaps_past_soft`. Mutations: releasing
at the soft bound breaks `fixed_serialises_within_cap` +
`fixed_replay_serialised`; no cap for a hung write breaks `fixed_bounded`.

Decision E3 applied (opencode's rule in every adapter): a `.plur.yaml`
scope/domain is adopted only when the directory holding the file is trusted
(`plur trust`, core `isDirectoryTrusted`); otherwise it is ignored, fails closed
on a throwing check, and a warning names the file and `plur trust <dir>`.
- MCP (packages/mcp/src/tools.ts): new `readTrustedProjectConfig(plur)`
  replaces `readProjectConfig()` at all five sites (plur_learn domain, batch
  domain, session_start scope+domain, plur_session_scope clear, session_end
  domain). session_start returns `project_config_warning` and prefixes `guide`;
  stderr once per file.
- dsh (packages/dsh/src/workspace-scope.ts, engine.ts, client.ts, index.ts): new
  `findWorkspaceScope` (the reader, also returning the file) and
  `trustedWorkspaceScope(trusts, warn)`; the engine facade gains
  `trusts(dir)` (false when core did not load); `PlurClient` gains the optional
  `isDirectoryTrusted`. `scope: global` in a workspace file is never adopted, so
  "the ambient global store is never a fallback" holds. `readWorkspaceScope`
  keeps its contract (workspace-scope.test.ts unchanged).
- CLI (packages/cli/src/plur.ts `trustedProjectScope`, `storeTrustCheck`; used
  by hook-inject.ts (session start AND the periodic reminder),
  hook-codex-inject.ts, hook-cursor-session-start.ts,
  hook-agy-pre-invocation.ts). The notice rides the same channel as the
  remote-refusal notice.
Tests (new): packages/mcp/test/formal-apply-surface-trust.test.ts (3; 2 failed
before), packages/cli/test/formal-apply-surface-trust.test.ts (11, the 4 hooks
through the built CLI, untrusted/trusted, plus the helper; 7 failed before),
packages/dsh/test/formal-apply-surface-trust.test.ts (4). Pre-existing tests
changed because E3 changes what they pin (untrusted adoption):
packages/mcp/test/session.test.ts (#177 describe: `plur.trustDirectory(projectDir)`
in beforeEach), packages/mcp/test/tools.test.ts (#1148:
`projPlur.trustDirectory(projDir)`), packages/cli/test/hook-agy-pre-invocation.test.ts:49
(the `createPlur` mock now answers `isDirectoryTrusted: () => true`),
packages/dsh/test/integration.test.ts WIRING test (injected client trusts) plus
a new untrusted WIRING case beside it (fails with the old wiring: verified by
temporarily restoring `readWorkspaceScope`). Results: mcp session+tools 110/110,
server 45/45, session-scope-tool 10/10, formal-adapters-* 8/8; dsh whole
package 288/288; cli hook suites (adapter-remote-recall, hook-inject-trust,
hook-cursor-session-start, hook-agy-pre-invocation, hook-remote-recall,
hook-codex-guard, codex/agy hook-io, trust, …) all pass.
Replay with the built MCP server (scratchpad/e3r, cwd = untrusted repo with
`scope: group:acme/eng`): session_start → no default_scope,
`project_config_warning: "…/repo/.plur.yaml declares scope "group:acme/eng", but
…/repo is not a trusted directory — … run: plur trust …/repo"`; unscoped
plur_learn → `scope: global`. After `plur trust <repo>` (built CLI):
default_scope group:acme/eng, scope_source project-config, the next learn
stored at group:acme/eng.
Lean §9: `adoptScope` (fixed) vs `adoptScopeOrig`; `untrusted_never_adopted`,
`trusted_as_before`, `adapters_agree`, `dsh_never_global`,
`trusted_team_adopted` (non-vacuity); counterexamples
`adapters_disagree_untrusted`, `orig_dsh_global`. Mutations: MCP ignoring trust
breaks `untrusted_never_adopted` + `adapters_agree`; dropping the dsh global
guard breaks `dsh_never_global`.
NEEDS-FILE: packages/cli/src/commands/hook-codex-session-start.ts (not in my
file list) still adopts `projectRemote.config.scope` untrusted. Exact change:
import `trustedProjectScope` from '../plur.js'; `const projectConfig =
trustedProjectScope(plur, projectRemote.config, projectRemote.configDir)`; and
add `projectConfig.notice` beside the remote-refusal notice.

Decision E7 applied (MCP side), against ApplyCore's contract (writepath.md top):
packages/mcp/src/tools.ts `_resolveWriteSession(args)` = explicit session_id,
else the lone open session, else core's `NO_SESSION`. Used by plur_learn,
plur_learn_batch, plur_session_end's suggestion writes (`endSession ??
NO_SESSION`; the session to END is still resolved as before), plur_inject and
plur_inject_hybrid. Recall (`plur_recall`, keyword and hybrid) is unchanged: it
still resolves `undefined` → process slot for its remote dialing context (see
follow-up). "Not exactly one" includes ZERO open sessions, as decided: the
process slot set by `plur_session_scope` with no session open no longer governs
id-less writes, so that tool now says so (`NO_SESSION_SLOT_WARNING` on set and
on show) instead of implying it does. The session_id descriptions of the four
tools state the rule. Test: packages/mcp/test/formal-apply-surface-session.test.ts
(8): 5 failed before (learn/batch/session_end took project:b, zero-session learn
took the stale slot, inject passed `undefined`); 8/8 after. Pre-existing tests
changed because E7 changes the zero-session behaviour they relied on:
packages/mcp/test/session-scope-tool.test.ts "learn after a mid-session set
routes to the enterprise store" (now opens a session first) and
packages/mcp/test/tools.test.ts "hints on a user:* personal landing scope" (the
default now comes from a session started with default_scope user:alice instead
of `plur.setSessionScope` with none open; telemetry reset in `finally`).
Replay with the built MCP server (scratchpad/e7r): sessions A(project:a),
B(project:b) open; id-less plur_learn → `scope: global` (was project:b); with
`session_id: A` → project:a.
Lean §2: `effScopeW` (unresolved session ⇒ no default);
`unresolved_session_no_default` (learn, batch and end), `fixed_ambiguous_no_default`,
`fixed_no_session_ignores_slot`, non-vacuity `lone_session_default`,
`named_session_with_several_open`; `ambiguous_learn_takes_last_started` kept as
the original-code counterexample. Mutation (unresolved → process slot) breaks
`unresolved_session_no_default`, `fixed_ambiguous_no_default`,
`fixed_no_session_ignores_slot`.
