# Findings: Installer (`packages/cli/src/enterprise/`, epic 1797)

The model is `spec/formal/PlurSpec/Installer.lean`. It checks cleanly with `lake env lean PlurSpec/Installer.lean`: no sorry, axiom or native_decide. The survey is at `spec/formal/survey/installer.md`. The branch is formal/epic-1797, 2026-10-18. The orchestrator (`init.ts`, plan C task 10b) does not exist yet, so the summary and cleanup are modelled on the result types they are given.

The model is 543 lines including comments. It covers six candidates at medium depth. Left out:
- the TOML and JSONC byte editing;
- the WHATWG URL parser;
- process trees;
- Windows-only rmSync behaviour (an oracle only).

## I1. Cleanup: backup before change, failures isolated, no overwrite

**Verdict:** I1a REFUTED (holds). I1b CONFIRMED+FIXED. I1c REFUTED (holds).

**I1a: the run order holds.** Each `cleanupX` writes only after `makeBackup` returned. `atomicWrite` replaces the file in one step, so a failure leaves it as it was. `run` catches every throw per target.
- Theorems: `Cleanup.changed_implies_backup`, `Cleanup.not_removed_unchanged`, `Cleanup.one_failure_isolated`, `Cleanup.removal_reachable`.

**I1b: a short backup write was accepted.** `backupWriter` made one `writeSync(fd, data)` call and ignored the byte count it returned. A short write (for example near ENOSPC) left a truncated backup, and the config was then changed. That breaks the claim "a write happens only after its backup succeeded" (cleanup.ts:61-62). The backup was also not fsynced, although the config change after it is (atomicWrite).
- Replay: `formal-installer-backup.test.ts`, red on the original code. A mocked `fs.writeSync` writes half of the next request. The result is `status: 'removed'`, and the backup is the first half of the original (assertion `expected '{\n "mcpServers": …' to be …`).
- Fix (cleanup.ts `backupWriter`): loop until every byte is written, throw on a zero-byte write, and `fsyncSync` before the backup counts. The test is green after the fix.
- Theorems: `Cleanup.loop_complete` (fixed: a reported backup holds `len` bytes), `Cleanup.loop_reachable`, `Cleanup.old_backup_truncated` (counterexample).
- Mutation check: replacing the loop step with `some (off + n)` (one write accepted) breaks `loop_complete`.
- The fsync part cannot be replayed (it needs a crash). It is included because the config write it precedes is durable.

**I1c: no backup overwrites an earlier one.** The numbering loop is only a naming choice. The guarantee is `openSync(dest, 'wx')` (O_EXCL), which fails on anything present at that path, a dangling link included. The target is then refused.
- Theorem: `Cleanup.backup_never_overwrites`.

## I2. The shared header file is deleted only when nothing references it

**Verdict:** CONFIRMED+FIXED.

`headerHolders` skipped a config when `existsSync(path)` was false. existsSync is false for every failed stat, EACCES on an untraversable parent folder included. So a config that could not be looked at counted as "no reference", and the header was deleted. That breaks the docstring rule "every editor config could be read" (cleanup.ts:32-33): the tri-state collapsed into a boolean.
- Replay: `formal-installer.test.ts`, "header file: a config that cannot be looked at keeps it", red on the original code (`expected 'removed' to be 'refused'`, twice). In the first test, `~/.cursor` is mode 000 and its `mcp.json` holds the legacy entry. In the second, `$CODEX_HOME` is mode 000.
- Fix (cleanup.ts): a new `lookup(path)` returns `present`, `absent` or `unknown`. Only ENOENT and ENOTDIR count as absent. Any other stat error makes the config a holder ("could not be read"). The tests are green after the fix. With all configs absent, the header is still removed (good case test).
- Theorems: `Header.removed_only_when_unreferenced`, `Header.removal_reachable`, `Header.old_removes_referenced` (counterexample).
- Mutation check: mapping `denied` to "not a holder" breaks `removed_only_when_unreferenced`.
- Note: the per-tool cleanups still use existsSync. There, a false answer only reports `absent` and changes nothing. The detail is wrong ("absent" instead of "could not be read"), but nothing is lost. Not changed.

## I3. Owner-only protection before any secret is copied

**Verdict:** REFUTED (holds).

`protectOwnerOnlyWindows` accepts only when four things hold:
- the account is known;
- both icacls runs exit 0;
- at least one ACL entry was parsed;
- every parsed principal equals the account, ignoring case.

`backupWriter` writes the secret only after the folder check (`protectBackupDir`: not a symlink, a folder, our uid, mode read back as 0700, or the Windows ACL) and the per-file check (fstat mode & 077 = 0, or the Windows ACL on the empty file). On failure the empty file is unlinked and the target refused.
- Theorems: `OwnerOnly.protect_sound`, `OwnerOnly.secret_only_when_protected`, `OwnerOnly.failure_leaves_nothing`, `OwnerOnly.copy_reachable`.
- Mutation check: writing the secret on the folder-failure path breaks `secret_only_when_protected`.
- Not verified: the real icacls output format on Windows (the exec is mocked). Settled by a Windows CI run.

## I4. Hello proof: calls bounded, child always ended, marker removed, folder map never written

**Verdict:** REFUTED (holds), plus one DOWNGRADED note.

- Every successful `openMcpSession` is closed on every path: learn refused, learn throws, recall hit, miss or throw, and an extra launch whose open fails. A failed open ends its own child (the initialize catch).
- Every request arms a timer that rejects and terminates the child. `terminate` checks `exitCode` and `signalCode` (a death by signal) and escalates to SIGKILL after 2 s.
- `rmSync` of the temporary folder runs in the outer `finally`, last.
- The only file written is the marker inside that folder.
- A save counts only for `delivery: 'remote'` with a non-empty id.
- Theorems: `Hello.every_session_closed`, `Hello.tmp_removed_last`, `Hello.only_write_is_marker` (structural), `Hello.call_bounded`, `Hello.kill_escalates`, `Hello.saved_means_remote`, `Hello.reachable`.
- Existing tests already pin this: enterprise-hello.test.ts kill checks after initialize and tool-call timeouts, ENOENT, and the neutral cwd; enterprise-hello-real-mcp.test.ts checks that `folders.yaml` is never created and the temporary folder is gone.

DOWNGRADED: the claim "the marker goes with the folder" holds only when rmSync succeeds. The code says it is best effort (Windows can refuse while a handle closes), so a `.plur.yaml` can survive in a temporary folder (`Hello.marker_left_iff`). Low risk: it turns memory on only inside that folder. Not changed. Adding `maxRetries` to rmSync would narrow it, but it cannot be checked here. The process-tree orphan (an npx or cmd.exe wrapper) is already a review follow-up for Task 5.

## I5. Init arguments, and the URL rule against the served installer

**Verdict:**
- I5a (empty value): CONFIRMED+FIXED.
- I5b (unknown options, missing values): REFUTED (holds).
- I5c (the URL rule): CONFIRMED+NEEDS-OWNER (contract mismatch).

**I5a: an empty value was accepted.** `--server ""` gave `server: ''`. Then `if (!server) server = env.PLUR_SERVER` used the environment without a word. That is the same failure review finding 1 fixed for a trailing flag. `--ca-file ""` and `--expect-version ""` passed through as `''`.
- Replay (args.ts compiled to a scratch folder): `--server ""` with PLUR_SERVER=https://env.example.com gives `{"server":"https://env.example.com",…}`. The output for `--ca-file ""` contains `"caFile":""`.
- Fix (args.ts): `value === ''` is "needs a value", like a missing value. Tests are in `formal-installer.test.ts` (I5): red, then green.
- Theorems: `Args.empty_value_is_error`, `Args.given_server_nonempty` (fixed: a server from `--server` is never empty, so the env fall-back runs only when no `--server` was given), `Args.old_empty_server_falls_back` (counterexample).
- Mutation check: dropping the empty test breaks `empty_value_is_error` and `given_server_nonempty`.

**I5b: unknown options and missing values are errors.** Theorems: `Args.unknown_is_error`, `Args.value_flag_needs_value`.

**I5c: contract mismatch with `served-installer.ts`.** Checked on enterprise `origin/agent/efi-a13`, `readInstallSettings`, compiled and run on the same inputs as `parseInitArgs`.

| PLUR_BASE_URL | server bakes | `plur-enterprise init --server <baked>` |
|---|---|---|
| `http://127.0.0.2:8080` | accepted | refused: "Insecure server URL …" |
| `http://127.1.2.3` | accepted | refused |
| `https://plur.example.com/plur` | `…/plur` | `https://plur.example.com`: **the path is dropped silently** |
| `https://plur.example.com:99999` | accepted | refused: "Invalid server URL" |
| `http://127.999.0.1` | accepted | refused: "Invalid server URL" |

The CLI's http rule is a subset of the server's (`Args.cli_subset_server`), so nothing the CLI accepts is refused by the server. The other direction fails:
- `Args.mismatch_127_slash_8`: an address in 127.0.0.0/8 is accepted by the server and refused by the CLI.
- `Args.path_dropped`: the server keeps a base path, and the CLI keeps only the origin.

No fix here: the plan says the CLI takes the origin and allows only localhost, 127.0.0.1 and [::1], and the server is another repository.

## I6. Summary: a failed version check or hello is never shown as plainly wired

**Verdict:** CONFIRMED+FIXED.

`formatSummary` printed "wired — restart X" whenever `tool.proven` was true. It never checked the evidence in the same result: whether the hello save was confirmed and whether this tool's own recall hit. So `proven: true` together with a failed save, no hello at all, or a recall miss was shown as plainly wired. That breaks the plan's rule "Every ✓ stands for a check that ran and passed". The caller (`init.ts`) is not written yet, so the formatter is the only place this can be pinned now.
- Replay: `formal-installer.test.ts` I6, 4 tests red on the original code (`expected true to be false`; for the recall miss, `expected [ …(3) ] to include '• OpenCode  wired, but not proven: …'`).
- Fix (summary.ts): plainly wired needs `proven && hello.saved.ok && perTool[tool].recalled`. Otherwise the line is "wired, but not proven: <reason>": the recall reason, "the connection check did not save", or "could not be verified". A failed version check still comes first. All 18 existing summary tests are unchanged and green: every existing `proven: true` fixture already carries the evidence.
- Theorems: `Summary.plain_wired_has_evidence`, `Summary.plain_wired_reachable`, `Summary.old_collapses_failed_save` (counterexample).
- Mutation check: going back to the `proven`-only rule breaks `plain_wired_has_evidence`.
- Left as is: a tool with no `version` field (the check did not run) can still be plainly wired. The plan's own fresh-machine fixture has no `version` field, and plan task 10 always runs the check. See NEEDS-OWNER question 3.

## Files changed
- `packages/cli/src/enterprise/args.ts`: an empty flag value is an error.
- `packages/cli/src/enterprise/cleanup.ts`: the tri-state `lookup` in `headerHolders`; the backup write loop and fsync.
- `packages/cli/src/enterprise/summary.ts`: plainly wired needs the evidence.
- New tests: `packages/cli/test/formal-installer.test.ts` (11), `packages/cli/test/formal-installer-backup.test.ts` (1).
- `spec/formal/PlurSpec/Installer.lean`, `spec/formal/findings/installer.md`, `spec/formal/survey/installer.md`, and `spec/formal/verify.yaml` (one entry appended). `PlurSpec.lean` (the root import) is not edited. That is for the coordinator.

## Tests
`cd packages/cli && npx vitest run test/formal-installer.test.ts test/formal-installer-backup.test.ts test/enterprise-args.test.ts test/enterprise-summary.test.ts test/enterprise-cleanup.test.ts test/enterprise-hello.test.ts test/enterprise-launch-check.test.ts`: 7 files, 107 passed. `tsc --noEmit -p packages/cli` and `tsc -p tsconfig.tests.json --noEmit` report no errors in these files. enterprise-hello-real-mcp.test.ts was not run (it needs a build), and the full suite was not run.

## NEEDS-OWNER
1. **The http-loopback rule (I5c).** The served installer allows plain http to all of 127.0.0.0/8. The CLI allows only 127.0.0.1. Options:
   - (a) widen the CLI to 127.0.0.0/8, matching the server's comment and error text;
   - (b) narrow the server to 127.0.0.1, matching plan C task 1.
   Either way it is a one-line change, plus a test on both sides.
2. **A base path in PLUR_BASE_URL (I5c).** The server bakes `https://host/plur`, and the CLI silently drops `/plur`. Options:
   - (a) the server refuses a path;
   - (b) the CLI refuses a path instead of dropping it;
   - (c) the CLI keeps the path, if the remote client supports a base path (not checked).
   Also: the server's `:\d{1,5}` accepts a port above 65535. Should it be held to 1–65535?
3. **Version check not run (I6).** Should a tool with no `version` result be "not proven", since "could not check is a failure"? Today it can still show as plainly wired. The plan's fresh-machine fixture has no version, so changing this means changing that pinned fixture.
