# Folder rules (cluster folder-rules)

Model: `spec/formal/PlurSpec/FolderRules.lean` (checks clean, no sorry).
Tests added: `packages/mcp/test/formal-folder-rules-gate.test.ts`, `packages/core/test/formal-folder-rules-writes.test.ts`.
Source changed: `packages/mcp/src/folder-gate.ts` (check loop). The mcp dist needs a rebuild for the stdio tests to see it.

## Lead 1: policy resolution and the gate (OFF-1, OFF-3, OFF-4)

**Resolver: PROVED.** `resolveExplicit`/`resolve` model `resolveExplicitFolderPolicy` and
`resolveFolderPolicy` in their order, with path matching abstracted into the facts they read.
- `malformed_never_on`: a broken map is ask with reason malformed, and a git default cannot change it.
- `off_always_off`: any matching off entry is off, whatever else matches.
- `remote_only_kept`: a marker, an untrusted request or git never undoes remote-only.
- `untrusted_asks`, `explicit_ask_kept`, `home_keeps_asking`: git fills only an absent default.
- Reachability: `git_fills_default`.

**Gate: CONFIRMED+FIXED.** `createFolderGate().check` reads the map twice: `folderOffAnswer`
over every folder, then `resolveFolderPolicy` per askable folder. The loop treated every mode
other than ask as on, so an `off` written between the two reads let that call run with memory
(OFF-1 fail-open, narrow window).
- Replay (stub Plur whose policy flips on→off after the first read):
  `vitest run` printed `RESULT {"plur":"on"} calls 3`.
- Test first: `formal-folder-rules-gate.test.ts::an off decision read while checking the folders turns memory off, even when the earlier off check saw on` failed (`expected 'on' to be 'off'`), passes after the fix.
- Fix: in the loop only on and remote-only continue; anything else returns the off answer.
- Model: `check_runs_only_on` (holds for any two reads), `check_ask_never_runs`,
  `old_gate_runs_in_off_folder` (the defect), `new_gate_refuses_that`, `gate_runs_when_on`.

**Guess/near-miss: PROVED.** `suggest_safe`, `guess_never_on`, `guess_never_remote_only`
(edit distance is an arbitrary oracle), reachability `guess_off_reachable`. This also backs
the "near-miss of remote-only is left alone" half.

**NEEDS-OWNER (OFF-4 wording vs pinned behaviour).** With no client roots and the server started
in the home folder (or a filesystem root), `askable` is empty and the gate returns on, so memory
runs in a folder whose policy is ask (`home_undecided_runs`). Pinned on purpose by
`folder-ask.test.ts::without roots, a client started in the home folder is not asked: memory as today`.
Options: (a) keep, and narrow OFF-4's text to exclude home/root; (b) return an off answer
("open a project folder") instead of running.

## Lead 2: answer nonces

**PROVED** for the single-use and per-answer properties:
- `verify_binds`: a verified nonce was issued for that folder and an answer with the same key.
- `trusted_distinguished`: a plain yes never grants `--trusted`.
- `issued_grants_only_its_answer`, `issued_works_once`, `nonce_single_use`: one nonce per
  offered answer, it works once, and after a successful write it is refused for every answer and folder.
- `failed_write_keeps_nonce`: a refusal after verification consumes nothing.
- `unbound_record_authorises_nothing`.
- `same_key_same_write`: answers with the same key make the same write in a folder that is not remote-only.

**CONFIRMED+NEEDS-OWNER (residual).** `answerKey` makes `--scope X` equal to `--scope X --on`. In an
undecided folder they write the same thing. If a parent becomes remote-only after the question was
shown, `--scope X` keeps remote-only but `--scope X --on` leaves it (`same_key_differs_on_remote_only`).
Replay (temp store): nonce for `{scope}` on F, parent set remote-only, then `set F --scope X --on --nonce`:
`BEFORE remote-only` / `AFTER on`. The user did answer "yes" to memory, so this may be acceptable.
Options: (a) keep; (b) bind the nonce to the exact flags offered (`--scope X` only);
(c) refuse a nonce-redeemed write when the folder's policy is no longer ask.

**Process-id reuse: PROVED with a stated residual.** `no_start_no_match` (no start time, no match),
`match_same_pid_close`, `reused_pid_far_start`. Within the 3 s tolerance a reused id is
indistinguishable (`reused_pid_close_start_matches`). That window is the documented tolerance for
`ps` etime rounding, and a match only shows the host's question again; each answer still needs
its nonce and the session that holds it. Lead downgraded: no replay.

## Lead 3: unbacked rules

| Anchor | Verdict | Backing |
|---|---|---|
| folder-ask.ts#skippedStoreHintClaimed | TESTED | lookup creates no marker folder and adds or removes no file |
| folder-map-check.ts#parses | TESTED | a parseable map with 4-space indentation keeps it; mutation `if (true)` fails the test |
| folders.ts#load | TESTED | child process holds the lock and writes folders.yaml; the import returns theirs and leaves it byte-identical; mutation (drop the re-read) fails the test |
| folders.ts#lockHeld | TESTED | 6 processes × 4 `setFolderEntry` lose no entry (children run core's dist) |
| folders-policy.ts#policy | TESTED | `bindFolder` honours a legacy grant and writes no folders.yaml |
| folder-gate.ts#isFilesystemRoot | TESTED | a filesystem root is never asked about, no nonce issued |
| folder-gate.ts#createFolderGate.check | TESTED | the gate touches only `resolveFolderPolicy` and `storageRoot`, never `setSessionScope` |
| folder-gate.ts#ancestorHosts | PROVED (model of the match it feeds) | `no_start_no_match`, `match_same_pid_close` |

## Mutation checks (scratch copy of the model; each broke the named proofs)

| Mutation | Broke |
|---|---|
| gate loop continues on off | gateLoop_runs_only_on, new_gate_refuses_that |
| marker checked before remote-only | remote_only_kept, untrusted_asks |
| git default ignores `reason` | malformed_never_on |
| off checked after remote-only | off_always_off |
| near-miss may be remote-only | guessNear_safe |
| key drops `trusted` | same_key_same_write, trusted_distinguished |
| consume on a failed write | failed_write_keeps_nonce |
| consume is a no-op | nonce_single_use, issued_works_once |
| host matched without a start time | no_start_no_match |
| verify skips the folder check | verify_binds |
| unbound record verifies | verify_binds, issued_grants_only_its_answer |
