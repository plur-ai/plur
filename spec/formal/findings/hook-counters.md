# Findings: hook counters and the auto-rate worker lock

Models: `spec/formal/PlurSpec/HookCounters.lean` (new) and `spec/formal/PlurSpec/R2CLI.lean`
(extended; every existing theorem name still proves).

## 1. Which counters lose increments — CONFIRMED+FIXED (Codex), CONFIRMED+DECIDED (Antigravity, option "switch")

Both reports in the lead were true, about different counters:

| Counter | Mechanism | Loses increments? |
|---|---|---|
| Claude Code Stop (`hook-learn-check.ts` `incrementCounter`) | wrapper of `ticketCounter` | no |
| Cursor (`cursor-hook-io.ts` `incrementCounter`) | `ticketCounter` | no |
| Codex (`codex-hook-io.ts` `incrementCounter`) | read-then-write | **yes**, now fixed |
| Antigravity (`agy-hook-io.ts` `agyIncrementCounter`) | read-then-write | **yes**, now fixed (owner decision) |

Callers depend on distinct values. `hook-codex-guard` and `hook-agy-guard` deny while the
count is at most 1 (`MAX_BLOCKS_BEFORE_FALLBACK = 1`), and their docstrings say "nudge once".
With read-then-write, parallel PreToolUse hooks all read 0, all get 1 and are all denied.

Replay against the built code (12 processes started at the same instant on one counter):
`node worker.mjs dist/commands/chunk-6LRRRY5M.js incrementCounter …` gave
`1 1 1 1 1 1 1 1 1 1 1 1` in 4 of 5 trials. `ticketCounter` gave `1..12` in 5 of 5 trials.
`agyIncrementCounter` (chunk-VFKQXXR5.js) gave `1 1 1 1 1 1 1 1 1 1 1 2`.
The script was a throwaway worker that calls the built counter functions.

- Lean: `HookCounters.RMW.rmw_duplicate` (counterexample), `Ticket.ticket_distinct_any_schedule`
  (distinct values under any interleaving: each reader reads a prefix of the final file that
  holds its own token), `Ticket.guard_denies_at_most_once`, `Ticket.guard_first_denied`
  (shows the good case is reachable), `FailOpen.fail_open`, `FailOpen.counts_when_ok`.
- Fix: Codex `incrementCounter` now returns `ticketCounter(path)`, keeping the untrusted-dir
  check and the fail-open `MAX_SAFE_INTEGER`. The test was written first and failed on the
  old code (`[1,1]` where `[1,2]` was expected). It passes now:
  `packages/cli/test/formal-hook-counters-codex.test.ts`, which replays the racing hook
  in-process between the first hook's read and its write.
- Antigravity, DECIDED (owner, option "switch"): `agyIncrementCounter` returns
  `ticketCounter(path)` like the Codex counter, keeping the untrusted-dir check and the fail-open
  `MAX_SAFE_INTEGER`. Test, red before the change (`expected [ 1, 1 ] to deeply equal [ 1, 2 ]`
  and `expected [ 1, 1, 1, 1, 1 ] to deeply equal [ 1, 2, 3, 4, 5 ]`), green after:
  `packages/cli/test/formal-hook-counters-agy.test.ts` (two racing hooks; a chain of five
  racing increments). The format pin in `formal-r2-cli-misc.test.ts` ("an identical message
  re-sent…") now counts ticket lines in `a1.turncount` (1, then 2) instead of reading an integer.
- R2CLI header: all four counters use `ticketCounter`.

Mutations, each tried in a scratch copy:
- `value := l.length` (append-then-stat): `ticket_distinct_any_schedule` breaks.
- deny threshold 2: `guard_denies_at_most_once` breaks.
- a failed write returns 1: `fail_open` breaks.

## 2. Stale docs — FIXED / TESTED

- `cursor-hook-io.ts` `incrementCounter` docstring said a racing pair could lose an increment.
  It now says `ticketCounter` hands each caller a distinct value.
- `hybridEnabled`: new test "every off spelling, in any case and padding, turns hybrid
  injection off" covers `0/false/off/no`, case, padding, the alias, and which variable wins.

## 3. Theorems that were true by definition — strengthened, names kept

- `R2CLI.Vet.fixed_writes_only_vetted` used to be `h : writesFixed ok = true ⊢ ok = true := h`.
  It now models `ensureSessionDir` branch for branch: symlink or foreign owner is refused; a
  loose mode is tightened by chmod, or refused if chmod fails. On top of that it models
  `markStarted` (both writes) and Cursor's `incrementCounter` (checks `sessionDirTrusted`).
  The theorem proves four things:
  - any change to the dir's files implies the dir is trusted after `ensure`;
  - the counter writes only in a trusted dir;
  - a refused dir is left unchanged;
  - an untrusted counter returns MAX.
  Non-vacuity: `fixed_writes_tightened`. Mutations that break it: `ensure` ignores the owner;
  `cursorIncr` checks only symlink; a loose mode is accepted without chmod.
- `R2CLI.Checkpoint.session_end_removed_only_after_capture` was proved by its hypothesis. It
  now models `closeSession`: folder mode, none/corrupt/valid checkpoint, the checkpoint's own
  folder, and the capture result. **The old statement was false for the code.** A remote-only
  session, or a checkpoint whose own folder is remote-only, is unlinked without capture (by
  design: no capture in remote-only folders). The theorem now proves:
  `removed → captured ∨ session remote-only ∨ checkpoint folder remote-only`.
  It is accompanied by `session_end_keeps_on_failure`, `session_end_keeps_corrupt`, and
  `session_end_closes` (non-vacuity). Mutations that break it: unlink after a failed
  capture; unlink a corrupt checkpoint; drop an unresolvable-folder checkpoint.

## 4. Auto-rate worker lock — CONFIRMED+DECIDED (takeover, option "core"), PROVED (wait), TESTED (hook)

Model `HookCounters.WorkerLock`. Lock = token or nothing. A takeover is `rename` then `check`
(claim = judged token: unlink it; otherwise restore it with `wx`). An acquire is `wx`.

- PROVED `stale_taken_over_at_most_once`: under every interleaving of any number of
  contenders and acquirers, at most one takeover removes the judged token. The proof is an
  invariant over `run`: the token is in at most one place. Also `second_contender_loses`,
  `lone_contender_takes_over` (non-vacuity), and `live_holder_restored` (a live lock moved
  aside is put back when nobody acquires in the window). Mutation: claiming by read instead
  of exclusive rename breaks the invariant proof and `second_contender_loses`.
- REFUTED for the cli's own takeover, "a live holder is never displaced" (the inventory rule of
  `takeOverStaleWorkerLock`): `orig_live_holder_displaced`. Steps:
  1. A takes over dead lock 9 and acquires.
  2. B, acting on its outdated read of 9, renames A's live lock aside.
  3. C acquires in that window.
  4. B's `wx` restore fails.
  A and C both run as the session's worker. Replayed against `auto-rate.ts` in-process
  (a throwaway replay test against auto-rate.ts):
  `{"bResult":false,"cGot":true,"aStillHolds":false}`.
  Consequences:
  - C's `orphans()` picks up A's in-flight `.queue.<pidA>` batch.
  - "At most one verdict per engram per session" and "orphaned batches only under the lock"
    rest on the lock, so a verdict or a capture can be applied twice.
  Core's `stealLock` has the same rename-and-restore. It is safe there only because the
  steal-guard ladder (`takeOverSync`, R2Persist `ladder_mutex`) lets a stealer rename only
  after re-checking, under the guard, that the judged token is still at the path. The docstring
  "mirroring core's stealLock" leaves that out.
- PROVED (`HookCounters.Wait`):
  - `wait_bounded`: the wait ends by `waitUntil` + one sleep.
  - `inline_never_waits`: `waitForLockMs: 0` returns at once.
  - `current_holder_not_waited`.
  - `waits_then_acquires` (non-vacuity).
  Mutations: ignoring `waitUntil` breaks `inline_never_waits`; waiting for a current holder
  breaks `current_holder_not_waited`.
- TESTED (`formal-hook-counters-auto-rate.test.ts`):
  - spawn failure runs the worker inline with `{ waitForLockMs: 0 }`;
  - a started worker means nothing runs inline;
  - Cursor queues the workspace-wide scope, or an explicit `null`;
  - an off or dirless workspace queues nothing;
  - real `runWorker` inline leaves in under 1 s behind a live older holder with a pending
    `.queue-ws` turn.

- DECIDED (owner, option "core"): core exports `takeOverLockSync(lockPath, abandoned)`, the
  guarded takeover behind `takeOverSync` with a pluggable abandonment rule, plus
  `publishLockFileSync`. `acquireWorkerLock` publishes its token with `publishLockFileSync` and
  takes a stale lock over with `takeOverLockSync(path, workerLockAbandoned)`. The cli's own
  `takeOverStaleWorkerLock` is gone. Model: `grename` (a rename only while the path still holds
  the judged token, which the steal guard makes one step), PROVED `live_holder_never_displaced`
  (once the path holds a live token, every schedule of creates, guarded takeovers and checks
  leaves it there), `live_holder_kept_replay` (the counterexample's schedule, now harmless);
  `stale_taken_over_at_most_once` still proves with `grename`. Test, red before the change
  (`expected '…:worker-c:qws' to be '…:worker-a:qws'`), green after:
  `packages/cli/test/formal-hook-counters-worker-lock.test.ts::two workers race for a stale lock
  while a third acquires: the live holder keeps the lock`. The H2 test "a stale worker lock is
  taken over atomically" now calls `acquireWorkerLock` and `takeOverLockSync`.

## NEEDS-OWNER

1. DECIDED: option (a) "core", see §4. Worker-lock takeover window (auto-rate.ts). Options:
   - (a) export a sync takeover from core with a pluggable liveness check, and use its guard
     ladder here;
   - (b) port the ladder into auto-rate.ts (about 40 lines, duplicates core);
   - (c) accept the window (it needs a stale lock, two contenders and a third acquire inside
     one rename) and change the docstring and inventory rule to say so.
2. DECIDED: option (a) "switch", see §1. Antigravity counter. Options:
   - (a) switch `agyIncrementCounter` to `ticketCounter` and update the `formal-r2-cli-misc`
     assertion to the line count;
   - (b) switch only the guard's `guard-count` path;
   - (c) keep read-then-write. The agy guard may then deny parallel tool calls more than once.

## Not covered

`hook-auto-rate.ts#guard` (worker ceiling waits for an idle store) and `auto-rate.ts#captureDeadline`
stay unbacked.
