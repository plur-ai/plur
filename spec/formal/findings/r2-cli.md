# Findings — R2-CLI (formal round 2)

Model: `PlurSpec/R2CLI.lean` (namespace `PlurSpec.R2CLI`), checked with
`lake env lean PlurSpec/R2CLI.lean` from `spec/formal` — clean, no
`sorry`/`admit`/`axiom`/`native_decide`. 467 lines, seven sections, one per item.
Not yet imported from `PlurSpec.lean` (coordinator's file).

Replays ran through built binaries with HOME, TMPDIR and PLUR_PATH in temp dirs under
the session scratchpad (`scratchpad/r2cli/`). BEFORE = a pre-fix binary built from
`git archive HEAD packages/cli/src` into `scratchpad/r2cli/prefix/dist`. AFTER =
`packages/cli/dist` (rebuilt with `pnpm --filter @plur-ai/cli build`). The new test
files take `PLUR_R2_CLI=<binary>` so the same suites were run against both builds.

Mutation checks: `scratchpad/r2cli/mut/run.py` puts each bug back into a scratch copy
of the model. All 12 mutations broke the theorem that backs the fix (table at the end).

---

## 1. cli#8 — session guards and session-dir vetting — CONFIRMED+FIXED (security)

Four defects confirmed by replay (`scratchpad/r2cli/replay1.sh`):

(a) **Planted content reached the model (security).** Readers never vetted the
directory. `readAgyTurnCache` read `$TMPDIR/plur-agy-sessions/<id>.turncache` through a
symlink the attacker planted, and `hook-agy-pre-invocation` emitted its `message` as
recalled memory. The writer refused that directory, but the reader believed it. The
same gap let a planted sentinel switch the Codex, Antigravity and Cursor guards off.
(b) **Cursor wrote into a directory it refused.** `sessionsDir()` computed the
`ensureSessionDir` verdict and returned the path anyway. `markSessionStarted`,
`incrementCounter` and post-tool's reminder `writeFileSync` then wrote through the
symlink. Codex `session-end` also unlinked through an unvetted directory.
(c) **The Claude Code family was not hardened.** `hook-session-mark` used a plain
`writeFileSync($TMPDIR/plur-session-<id>, '')`. That follows a planted symlink and
truncates the target. The guard counter, the `hook-inject` state dir and the
`hook-learn-check` counter all used a bare `mkdirSync`.
(d) **Claude exempted only the exact tool name.** The Claude guard exempted only
`mcp__plur__plur_session_start`, so a plur server registered under another name had
its one permitted call denied. The Codex, Cursor and Antigravity guards match by
suffix.

Replay BEFORE:
```
A agy stdout: {"injectSteps":[{"ephemeralMessage":"PLANTED-BY-ATTACKER"}]}
B attacker dir after cursor guard: c1.turncache  c2.marker.guard-count
C victim bytes after session-mark: 0            (was "precious\n")
D guard on mcp__plugin_plur_plur__plur_session_start: {"…permissionDecision":"deny"…}
```
Replay AFTER: A emits nothing. B leaves the attacker dir untouched and the guard fails
open with its stderr line. C leaves the victim at 9 bytes. D produces no output
(exempt).

Fix:
- `sessionDirTrusted(dir)` (codex-hook-io.ts) is the read-side verdict. It never
  creates or chmods. The directory must be a real directory, owned by this uid, and
  not writable by group or others. It is used by every reader: `isSessionStarted`
  for Codex and Cursor, `agyIsSessionStarted`, and `readAgyTurnCache`.
- Cursor: `markSessionStarted` and `touchReminder` write only after
  `ensureSessionDir`. `incrementCounter` checks `sessionDirTrusted(dirname(path))`
  and never creates the directory, so an unwritable or refused directory still
  reports `MAX_SAFE_INTEGER`, as before. Codex `session-end` unlinks only when
  `sessionDirSafeToSweep` passes.
- Claude family: `writeFileNoFollow` (O_NOFOLLOW, 0600) writes the tmpdir sentinel.
  The guard believes the sentinel only if `ownFileExists` holds (a regular file owned
  by this uid). The `plur-sessions` dir is vetted in guard, inject and learn-check,
  and a refused dir takes each hook's existing fail-open branch. The guard exempts
  any `__plur_session_start` suffix.

Theorems: `trusted_iff_not_plantable`, `fixed_never_reads_plantable`,
`fixed_writes_only_vetted`, `fixed_exempts_every_server`, `fixed_extends_orig`
(the change only widens the exemption). Non-vacuity: `fixed_reads_own`,
`fixed_gates_bash`. Counterexamples: `orig_reads_planted`, `orig_writes_refused`,
`orig_denies_plugin_server`.

Tests: `test/formal-r2-cli-session-dir.test.ts` (9). BEFORE: 7 failed, 2 passed. The
two that passed are the regression guards: nudge-once still fires, and mark-then-guard
still works. AFTER: 9 passed.
Residual (not changed): the Claude `hook-session-mark` matcher in `init.ts` is still
the exact `mcp__plur__plur_session_start`. With another server name, the guard now
exempts the call, but the mark hook never fires, so the next tool gets its one nudge
and then fails open. Widening the matcher changes installed settings.json (survey
item 1 territory), so it was left alone.

## 2. cli#6 — session checkpoint lifecycle — CONFIRMED+FIXED

The property "a checkpoint is removed only after a durable capture" did not hold for
the deferred wrap-up in `hook-inject`:
(a) a valid stale orphan produced a transient notice and was then unlinked, with no
episode captured;
(b) a corrupt checkpoint was unlinked outright;
(c) the only orphan test was idle for more than 5 minutes. A session still running in
another terminal between checkpoints (one every 10 responses) was declared dead.
(d) the writer (`hook-learn-check`) and the scan read only PLUR_PATH, while
`hook-session-end` honoured `--path`.

Replay BEFORE (`test/formal-r2-cli-checkpoint.test.ts` against the pre-fix binary):
6/6 failed. Stale orphan: the checkpoint was gone and `episodes.yaml` was absent.
Corrupt: deleted. Checkpoint keyed by a live pid: deleted. Dead pid: no episode.
Capture fails (`episodes.yaml` is a directory): deleted anyway. `--path`: the
checkpoint was written under PLUR_PATH.

Fix (`hook-inject.ts processDeferredWrapups`, now exported and passed `plur` and the
root):
- The orphan is captured first (`plur.capture`, tags `session-end`,
  `deferred-wrapup`) and unlinked only if the capture succeeded. If the capture fails,
  the checkpoint is kept and a stderr line is written.
- A corrupt checkpoint, or one with an invalid `last_checkpoint`, is renamed to
  `<file>.corrupt`. The bytes are kept and the file leaves the scan.
- A checkpoint whose key is all digits (the ppid fallback, the common case) is left
  alone while that pid is alive. This is an extra condition on top of the time rule,
  so it is strictly more conservative. PID reuse can only make it skip a dead session,
  and that session is retried later.
- One root rule everywhere, `flags.path || PLUR_PATH || ~/.plur`
  (`checkpointRoot`). It is used by the writer, the scan and `hook-session-end` (which
  used `??`).

Downgraded sub-claim: "writer and closer key sessions differently". The closer tries
`[payload session_id, CLAUDE_SESSION_ID, ppid]`. The writer keys
`CLAUDE_SESSION_ID || ppid`. With the same environment and ppid, the closer's list
always contains the writer's key (`closer_finds_writer`), and the scan is
key-agnostic. The keys are not a defect.

Theorems: `removed_only_after_capture` (every checkpoint, every capture result),
`live_session_kept`, `session_end_removed_only_after_capture`, `closer_finds_writer`.
Non-vacuity: `orphan_recovered`. Counterexamples: `orig_removes_uncaptured`,
`orig_removes_corrupt`, `orig_removes_live`, `orig_writer_ignores_path`.
Tests: `test/formal-r2-cli-checkpoint.test.ts` (6). BEFORE: 6 failed. AFTER: 6 passed.
The existing `session-checkpoint.test.ts` deferred suite (non-numeric keys) passes
unchanged.

## 3. cli#7 — session identity and inject lock — CONFIRMED+FIXED

(a) **Identity.** The marker was keyed by `process.ppid` and never deleted, while the
guard keys by `session_id`. After `/clear` (same process, new session), the old marker
made the new session's first prompt count as a mid-session prompt, so there was no
injection. A recycled PID behaves the same way.
(b) **Lock without O_EXCL.** The lock was stat-then-write. In the schedule A-stat,
B-stat, A-write, B-write, both hooks proceed, which is the pile-up #519 exists to
prevent.
(c) **Lock not released on throw.** The unlink sat on the success path only. A throw
from createPlur, the BM25 fallback or the project-config reads left the lock in place
for LOCK_STALE_MS (55 s), and every prompt in that window skipped injection.

Replay BEFORE: `/clear` from `sess-A` to `sess-B` in the same process gave empty
stdout for B. With PLUR_PATH set to a file, a `*.injecting` lock was left behind.
Interleaving replay (`scratchpad/r2cli/replay-interleave.mjs`, the old fs calls in
order): `cli#7 old lock: A proceeds = true B proceeds = true`.

Fix (`hook-inject.ts`): the payload is read first. The key is
`sid-<safeSessionKey(session_id)>`, or the ppid when the payload has none, so payloads
without an id behave exactly as before. The `sid-` prefix keeps the two key spaces
disjoint. Week-old state is swept (vetted dir only), because keys are now one per
session. `acquireInjectLock` uses `openSync(path,'wx')`. A stale lock is unlinked and
taken over with one retry. When the dir or the I/O is unusable, the result is
`'unavailable'` and the hook proceeds unlocked (fail open, as before). The body runs
in `try { … } finally { unlink }`.

Theorems: `fixed_clear_injects` (under `safe s1 ≠ safe s2`),
`fixed_same_session_no_reinject`, `excl_at_most_one` (any number of acquirers, any
order), `fixed_released_every_path`. Non-vacuity: `excl_someone_wins`.
Counterexamples: `orig_clear_skips_injection`, `orig_both_proceed`,
`orig_leaks_on_throw`.
Tests: `test/formal-r2-cli-inject-session.test.ts`, first two describe blocks.
BEFORE: 2 failed (/clear, lock released on throw). AFTER: all passed. The existing
`hook-inject-lock.test.ts` (keyed by ppid) passes unchanged.
Residual, recorded: stale-lock takeover can still race (A unlinks the stale lock and
creates its own, then B, having also seen the stale lock, unlinks A's). The window
needs a crashed holder plus two firings inside the same few microseconds. The model
covers the non-stale path only. `safeSessionKey` is many-to-one, so two ids that
sanitize to the same key share a marker. Claude session ids are UUIDs, where
`safeSessionKey` is the identity.

## 4. cli#11 — "atomic" append-then-stat counters — CONFIRMED+FIXED

Each append is atomic, but the append-then-stat pair is not. Interleaving replay:
`cli#11 old counter: A = 2 B = 2`. Value 1 is never handed out and 2 is handed out
twice, so an Nth-stop nudge or checkpoint fires twice and the next is skipped.

Fix: `ticketCounter` (codex-hook-io.ts). The caller appends one line carrying a random
token with a single O_APPEND write, then reads the file. Its value is 1 + the position
of its own line. It is used by `hook-learn-check` and the Cursor `incrementCounter`.
Lines are matched with `endsWith(token)`, so a legacy dot file continues from 1
instead of throwing. The Codex and Antigravity read-modify-write counters are
documented as accepting a lost increment. They are out of this item and were left as
they are.

Theorems: `ticket_distinct` (distinct callers get distinct values), `ticket_stable`
(the value does not depend on when the caller reads, because appends only extend the
file), `pos_append`, `pos_lt`. Non-vacuity: `sequential_counts`. Counterexample:
`orig_duplicate`.
Tests: `test/formal-r2-cli-inject-session.test.ts` "cli#11 ticket counter" (3),
including 12 concurrent `hook-cursor-stop` processes producing exactly 4 nudges. The
concurrency test also passed on the pre-fix binary by luck, so the deterministic
interleaving replay above is the evidence. Pre-existing test changed:
`test/hook-cursor-stop.test.ts` "does not count aborted/error stops". It asserted the
counter file's size was 1 byte, and now asserts 1 line. The on-disk representation
changed on purpose.

## 5. cli#10 — doctor false green — CONFIRMED+FIXED

`hooksInstalled` is `configs.some(hasPlurHooks)` over the Cursor, Codex and
Antigravity files too, and the healthy verdict always printed "ready to use in Claude
Code". Replay BEFORE, on a HOME with only Codex wired (`script -q` for a TTY):
```
✓ Codex (~/.codex/hooks.json): plur hooks
✓ Healthy. plur is ready to use in Claude Code.
```
AFTER: `✓ Healthy. plur is ready to use in Codex. Claude Code has no plur hooks — run
\`plur init\` to add them.`

Fix: `hookHarnesses(configs)` and `readyLine(harnesses)` (doctor.ts). The Claude Code
line is printed only when a Claude Code config carries hooks. `overall` and the exit
code are unchanged. Whether a machine with no Claude Code wiring should fail doctor is
a scoping choice with no bug behind it. The conservative option was taken: the text
was corrected and the status was left alone.

Theorems: `fixed_claim_sound`. Non-vacuity: `fixed_claims_when_true`.
Counterexample: `orig_false_green`.
Tests: `test/formal-r2-cli-misc.test.ts` "cli#10" (2).

## 6. cli#12 — Antigravity per-turn cache — CONFIRMED+FIXED

(a) With `step_index` missing, it becomes -1. An identical message sent again ("yes" …
"yes") therefore has the same step and the same hash, and the first turn's memory was
replayed with no recall.
(b) An unusable cache dir means `cached === null` on every turn, so every turn was
"first": the session-start header, a 3000 budget and the refusal notices, repeated
each turn.

Replay (`scratchpad/r2cli/replay6.sh`): BEFORE, `(a) recalls run for two user turns:
1` and `(b)` emitted `…session started, 0 engrams…` on turn 2. AFTER, `(a) … 2` and
`(b)` emits nothing (turn 2 with 0 engrams is silent, which is correct).

Fix: `lastUserInput` walks the transcript bytes and returns `offset` (the absolute
byte offset of the USER_INPUT line) and `firstInTranscript` (whole file read and
exactly one user message). A new turn is also detected when the offset differs from
the cache's offset. `isFirst` also requires `firstInTranscript` when the transcript
is readable. The cache gains an optional `offset`, and old caches without it behave
as before. "Failed counter never nudges" is consistent fail-open behaviour and was
not changed.

Theorems: `fixed_later_line_is_new`, `fixed_second_turn_not_first`. Non-vacuity:
`fixed_same_line_replays` (mid-turn replay still works), `fixed_first_turn_first`.
Counterexamples: `orig_replays_stale`, `orig_every_turn_first`.
Tests: `test/formal-r2-cli-misc.test.ts` "cli#12" (3). BEFORE: 2 failed and 1 skipped
by the filter. AFTER: all passed. Pre-existing test changed:
`test/antigravity-hooks.test.ts`, the three `lastUserInput` assertions. They moved
from `toEqual({stepIndex, text})` to `toMatchObject`, because the result gained
fields on purpose. The pinned fields are unchanged.

## 7. Follow-up — `--` in free-text commands — CONFIRMED+FIXED

`plur capture -- "-starts with a dash"` stored the summary `"--"`, and
`plur recall -- "-dash statement"` searched for `"--"`. Replay BEFORE:
`{"summary":"--"}` and `{"results":[],"count":0}`. AFTER: `{"summary":"-starts with a
dash"}` and `count: 1`. `recall --limit 1 -- "--limit"` searches for `--limit`.

Fix: the `learn` rule (decision S4) was applied to recall, capture, ingest, inject,
similarity-search, timeline and forget. On `--`, the next token is the positional
value, verbatim.
Theorems: `fixed_after_dashdash_is_data`, `fixed_even_a_flag_name`. Counterexample:
`orig_query_is_dashdash`.
Tests: `test/formal-r2-cli-misc.test.ts` "`--`" (2). BEFORE: 2 failed. AFTER: passed.

---

## Mutation checks (`scratchpad/r2cli/mut/run.py`)

| Mutation (bug put back into the model) | Theorem that stops proving |
|---|---|
| reader ignores trust | `fixed_never_reads_plantable` |
| unlink although capture failed | `removed_only_after_capture` |
| drop the liveness check | `live_session_kept` |
| marker keyed by ppid | `fixed_clear_injects` |
| lock not exclusive | `excl_at_most_one` |
| release only on the ok path | `fixed_released_every_path` |
| counter value = size, not position | `ticket_distinct` |
| doctor claim from any hooks | `fixed_claim_sound` |
| turn identity without offset | `fixed_later_line_is_new` |
| first = no cache | `fixed_second_turn_not_first` |
| `--` treated as positional | `fixed_after_dashdash_is_data` |
| exact-name exemption | `fixed_exempts_every_server` |

## NEEDS-FILE

- `packages/mcp/src/tools.ts` ~3814 (`plur_session_end` checkpoint cleanup) resolves
  the sessions dir as `process.env.PLUR_PATH ?? ~/.plur`. The CLI uses `||`, so with
  `PLUR_PATH=""` the MCP close looks in `./sessions`. Suggested change: use `||`. Minor.

## Test run

`npx vitest run --testTimeout=120000 packages/cli/test` (after the final build):
92 files, 876 passed, 1 failed, 4 skipped. The failure was `list.test.ts` "filters by
domain" at 13 s under full parallel load. `list.ts` is not touched here, and that file
passes alone (4/4). The previous full run had it green (874 passed plus the 3
antigravity shape assertions fixed since).
