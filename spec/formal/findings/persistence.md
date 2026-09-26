# Findings — Persistence cluster (run of 2026-09-23, origin/main 6200dbf6)

Model: `spec/formal/PlurSpec/Persistence.lean` (namespace `PlurSpec.Persistence`).
Check: `cd spec/formal && lake env lean PlurSpec/Persistence.lean` (no output = clean).
Scratchpad: `<session scratchpad, not committed>/`.

---

## 1. Git sync never pulls while a scope:local engram exists (core-persistence#1)

**Verdict: CONFIRMED + FIXED** (plus a second, narrower defect in the same function: the `pushed` report line).

The lead is correct but slightly broader than the behaviour: sync refuses to pull a remote
change **to `engrams.yaml`** (the file that holds the withheld record). Remote changes to other
store files pull fine — which is why `sync.test.ts:237/255` (episodes.yaml only) never saw it.

Mechanism: `commitChanges` makes `HEAD = strip(W)` (#396). With one scope:local engram, `W ≠ HEAD`
in `engrams.yaml` forever; `git pull --rebase` refuses ("unstaged changes"), the merge fallback
refuses ("would be overwritten"), sync reports `NOT pulled — still 1 commit(s) behind … resolve
locally and retry`. Retrying is identical; any later local commit then fails to push
(non-fast-forward). The machine never converges.

Second defect: `if (aheadAfter === 0 && aheadBefore > 0) parts.push('pushed')` — `aheadAfter` is
measured *before* the push, so a successful push never reported `pushed`.

**Theorems** (`PlurSpec.Persistence.Sync`):
- `old_never_pulls` — counterexample: any withheld record ⇒ `pullOld … = none` (for every merge oracle).
- `old_pulls_when_nothing_withheld` — non-vacuity: with nothing withheld the old code pulls.
- `fixed_pulls` — fixed code: HEAD is always the merged remote.
- `fixed_no_loss` — every working-tree record survives (given the merge keeps HEAD's records).
- `fixed_no_leak` — the next stripped commit is exactly the pulled HEAD: no withheld record reaches
  a commit, and no spurious commit (given the remote only carries push-set records).

**Replay** (before fix; two repos + bare remote, no network):
```
SCRATCH=$PWD tsx scratchpad/p1/replay1.ts
A sync:  {"action":"synced","message":"Synced. NOT pulled — still 1 commit(s) behind the remote; resolve locally and retry." …}
A has B1: false A has L1: true
A retry: … "NOT pulled — still 1 commit(s) behind …"
A sync2: … "1 file(s) committed, NOT pulled …, NOT pushed — the commit is local only." push_error: "! [rejected] main -> main (non-fast-forward)"
```
Failing test before the fix: `formal-persistence-sync.test.ts` — 2 failed / 2 passed
("Received: Synced. NOT pulled — still 1 commit(s) behind the remote; resolve locally and retry.").

**Fix** (`packages/core/src/sync.ts`): `pullRebase` now wraps the old body (`pullRebaseClean`) in
`holdWithheld` / `restoreWithheld`. For each store file whose working tree holds withheld records
(engrams.yaml; on `shared` remotes also the derived sibling records), the file is reset to its
staged = committed blob (`git checkout -- file`), the pull runs on a clean tree, and in `finally`
the held records are restored: verbatim bytes if the pull left the file unchanged, otherwise the
pulled file with the held records appended (re-dumped with the store's YAML options); an
unreadable result restores the saved bytes, so a failed pull can only mean "not pulled", never
"lost". The held records live only in memory and the working tree — never in a commit. Sync already
runs under the store lock (`index.ts` `sync()` → `_withStoreLock`), so no writer races the hold.
Report line fixed to `if (aheadAfter > 0 && !pushError) parts.push('pushed')`.

No git/on-disk layout change. Visible side effect: after a pull that changed engrams.yaml, the held
(scope:local) engrams move to the end of the list. Same-id collision (a withheld id also arriving
from the remote) keeps both records — noted, not handled.

**Tests**: `packages/core/test/formal-persistence-sync.test.ts` (4): control without local engram;
with local engram (pulls, keeps ENG-L1, HEAD never has it); with a local commit (rebases, pushes,
says `pushed`, remote has no ENG-L1); remote touched another file ⇒ engrams.yaml byte-identical.
`npx vitest run packages/core/test/formal-persistence-sync.test.ts packages/core/test/sync.test.ts`
→ 46 passed; plus sync-corrupt-push-guard / sync-push-failure / sync-index-error /
scope-metadata-sync → 27 passed.

**Mutation check**: scratch copies of the model —
(A) restore without the held records ⇒ `fixed_no_loss` fails;
(B) no hold (old refusal semantics) ⇒ `fixed_pulls` fails;
(C) restore the whole saved W after a changed pull ⇒ `fixed_no_leak` fails. All three stop proving.

Not fixed (out of scope, noted): `readEngramList` accepts a bare top-level array that
`parseEngramFile` rejects (sync.ts, engrams.ts:115) — reader drift, core-persistence#11 (deferred).

---

## 2. Failed migration restores a stale backup over the live store (core-persistence#2)

**Verdict: CONFIRMED + FIXED.**

`up()`/`down()` run on an in-memory copy; nothing touches the live file until every step has
succeeded. Yet on a throw, `restoreBackup` copied `.bak.<v>` over it — and `.bak.<v>` is
no-clobber (#813), i.e. the FIRST copy ever taken for that version. Non-atomic `copyFileSync`,
bypassing the shrink guard. Same shape in `rollbackMigrations`.

**Theorems** (`PlurSpec.Persistence.Migration`):
- `old_failed_run_replaces_live` — counterexample: live 3, stale bak 1, failing step ⇒ live 1.
- `fixed_failed_run_keeps_live` — any failing run leaves `live` identical, for every backup state.
- `fixed_success_writes` — non-vacuity: success writes the migrated corpus.
- `fixed_keeps_backup` — the backup is still taken (for manual recovery).

**Replay** (before fix): `tsx scratchpad/replay2.mts`
```
before failing run: 3
[plur:error] Migration 20260813-006-recompute-content-hashes failed: Error: boom
threw: Migration 20260813-006-recompute-content-hashes failed: Error: boom. Engrams restored from backup.
after failing run: 1
```
(1 engram → migrate (bak.0 = 1) → add 2 → rollback to 0 (bak.0 kept) → re-run with the last `up`
throwing.) Failing tests before fix: `formal-persistence-migrations.test.ts` 2 failed (byte compare).

**Fix** (`packages/core/src/migrations/runner.ts`): removed `restoreBackup` and both restore calls;
the failure path writes nothing and says so (`engrams.yaml was not modified.`). Backup creation
unchanged. No test pinned the restore; the CLI only prints `backup_path`.

**Tests**: `packages/core/test/formal-persistence-migrations.test.ts` (2: run and rollback paths,
byte-identical live file). `npx vitest run packages/core/test/formal-persistence-migrations.test.ts
packages/core/test/migrations.test.ts packages/core/test/sp2-migrations.test.ts
packages/core/test/pr1-indexed-migration.test.ts packages/core/test/migration-006-recompute-hashes.test.ts`
→ 41 passed.

**Mutation check**: restoring `none => ⟨backup, …⟩` in `runFixed` ⇒ `fixed_failed_run_keeps_live` fails.

Residual (not modelled): `saveEngrams` succeeding and `setSchemaVersion` then throwing leaves a
migrated corpus stamped with the old version; the next run re-applies. Out of this candidate.

---

## 3. Lock steal by rename lets two processes hold the lock (core-persistence#3)

**Verdict: CONFIRMED + FIXED** (async lock replayed; the synchronous twin in sync.ts has the same
code shape and got the same fix, but is not independently replayed — a synchronous single-thread
interleaving cannot be driven from one process).

`stealLock` renames whatever is at `lockPath` *now*, not the file the contender judged stale. The
survey's 3-process interleaving is real: H dead; A and B both judge H stale; A renames H aside,
confirms, O_EXCL-acquires, enters; B renames the path — A's live lock — aside; C O_EXCL-creates at
the empty path and enters; B's `wx` put-back fails ("theirs wins"). A and C are both inside, and A's
`releaseIfOurs` later leaves C's file (token mismatch), so the pairing persists to the end of A's hold.

**Theorems** (`PlurSpec.Persistence.Lock`):
- `old_two_holders` — counterexample, by `decide` on the executable old protocol: the 8-step trace
  `[judge 1 9, judge 2 9, rename 1, finish 1, acq 1, rename 2, acq 3, finish 2]` ends with
  `hold 1 = hold 3 = true`.
- `inv_step`, `reach_inv` — the invariant (every holder is the lock's token and alive; a guarded
  stealer's re-read equals the lock and names a dead process; every claim moved the stale file) is
  inductive over all 7 actions of the fixed protocol.
- `fixed_mutex` — at most one process in the critical section in every reachable state.
- `init0_inv`, `fixed_steal_reachable` — non-vacuity: the dead holder's lock is stolen and a live
  process enters.
- Model assumption (the fix's scope): only a process whose liveness probe says **dead** is stolen
  from. The age-based steal of a process whose liveness is *unknown* violates it — that is #4.

**Replay**: `packages/core/test/formal-persistence-lock.test.ts` — three "processes" in one process,
locking the same file through three symlinked directories (the in-process queue is keyed by
`path.resolve`, which does not follow symlinks; the O_EXCL file is one inode); `fs/promises.rename`
wrapped to force the interleaving. Before the fix, 3/3 runs: `AssertionError: expected 2 to be 1`
(max concurrent holders = 2). After: 1 passed (6/6 repeated runs).

**Fix**: `packages/core/src/store/async-lock.ts` `stealLock` — stealing is serialized by an O_EXCL
guard file `<lock>.steal`, and the lock is re-read under it; only if it still carries the judged
token is it claimed (the existing rename/verify/put-back tail, now `claimAndRemove`). While the
guard is held no stealer can touch the path, no acquirer can (file exists), and a dead holder cannot
release, so the file re-read is the file renamed. A contender that finds the guard taken returns and
re-evaluates; a guard whose writer is dead (or older than 10 s when liveness is unknown) is removed
(`clearAbandonedGuard`). Same change in `packages/core/src/sync.ts` `stealLockSync`
(+ `claimAndRemoveSync`). No lock-file format change; one extra transient file name.

**Tests**: `npx vitest run packages/core/test/formal-persistence-lock.test.ts
packages/core/test/async-lock.test.ts packages/core/test/async-lock-contention.test.ts
packages/core/test/async-lock-key.test.ts` → 28 passed; with sync.test.ts and the other lock tests → 107.

**Mutation check**: (a) `gRead` records the judgement without re-reading under the guard ⇒ `inv_step`
fails; (b) `gAcq` without `guard = none` (no serialization) ⇒ `inv_step` fails. Code-level: restoring
HEAD's async-lock.ts makes the replay test fail again (3/3).

Residual: removing an abandoned guard is itself unguarded; a double fault (a stealer crashes inside
the guard AND two live stealers race its removal inside the same window) could re-open the race.

## 4. Stale threshold (60 s) < longest legitimate hold (~90 s sync), no heartbeat (core-persistence#4)

**Verdict: CONFIRMED + NEEDS-OWNER** (policy).

The age-based steal applies only when liveness is unknown (holder on another host sharing `~/.plur`,
or a legacy bare-pid token). For such a holder, a legitimate `Plur.sync()` hold (git fetch/pull/push,
each with a 30 s timeout — the file's own comment puts it at ~90 s) is stolen at 60 s; nothing
refreshes the lock's mtime while it is held. This is exactly the assumption `fixed_mutex` needs
("only dead holders are stolen from"), so the Lean result does not cover this case.

**Replay**: `tsx scratchpad/replay4.mts` — lock token `other-host:4242:1:0`, mtime now−61 s:
`entered critical section after 57 ms while other-host holder is mid-hold`.

**Question for the owner** — how should a live holder on another host be protected?
- (a) Heartbeat: while `fn` runs, the holder re-touches its own lock (token-checked `utimes`) every
  `staleThreshold/3`; stealing then only happens to a holder that stopped heartbeating. Local change in
  async-lock.ts + sync.ts, no format change.
- (b) Raise `DEFAULT_STALE_THRESHOLD` above the max honest hold (e.g. 150 s); crash recovery for
  foreign/legacy holders slows accordingly.
- (c) Declare a `~/.plur` shared between hosts unsupported and keep the current behaviour (document it).

---

## 5. Postgres: failed advisory unlock returns the lock-holding session to the pool (core-persistence#5)

**Verdict: CONFIRMED + FIXED.**

`withExclusiveAccess` swallowed a failed `pg_advisory_unlock` and then called `client.release()`
with no argument, under a comment claiming the connection is "discarded". Without an argument the
pg pool returns the session to idle — still holding the session-level advisory lock. Every other
session's `pg_advisory_lock` (no timeout) then blocks forever; the same session re-enters silently
(advisory locks are re-entrant per session). The file's own `close()` docs (lines ~794-797) state
the correct rule: only `release(err)` removes a connection.

**Theorems** (`PlurSpec.Persistence.PgLock`): `old_pool_gets_locked_session` (counterexample),
`fixed_pool_never_locked` (no pooled session holds the lock, for every unlock outcome),
`fixed_clean_reuses` (non-vacuity).

**Replay**: `packages/core/test/formal-persistence-pg-unlock.test.ts` — mock lock pool whose sessions
track advisory-lock depth, adapter's `getLockPool` stubbed, no database. Before the fix:
`AssertionError: expected [ { id: +0, locked: 1, … } ] to deeply equal []` (an idle session holding
the lock). After: 3 passed.

**Fix** (`packages/core/src/storage-postgres.ts`): a `poisoned` error is recorded when the unlock (or
the lock call itself) throws, and the finally calls `client.release(poisoned)` — destroyed when
poisoned, returned otherwise.

**Tests**: `npx vitest run packages/core/test/formal-persistence-pg-unlock.test.ts
packages/core/test/postgres-close.test.ts packages/core/test/postgres-multi-writer.test.ts
packages/core/test/postgres-adapter.test.ts` → 3 passed, 51 skipped (no `PG_URL` here; the coordinator
should run the postgres suites against a database if one is available).

**Mutation check**: `endFixed := some (!unlockOk)` ⇒ `fixed_pool_never_locked` fails.

---

## 6. Backup "unrecoverable" list counts non-engram ids (core-persistence#6)

**Verdict: CONFIRMED + FIXED (narrowed).**

`idsCreatedAfter` — documented as "engram ids the history log records as created after `since`" —
collected `engram_id` from every event type. Real writers put non-engram values there: `co_injection`
(index.ts ~5562) writes an injection id `INJ-…`; `session_scope_changed` (index.ts ~10156) writes `''`.
Both surfaced in `plur restore`'s "History records N engram(s) … it does not contain" warning.

Narrowed fix, not the full "created only" filter: the existing (read-only) test
`backup.test.ts` "names SAME-DAY engrams the snapshot cannot recover" uses a non-existent event name
`engram_learned` (not in `HistoryEvent`); filtering to `event === 'engram_created'` would break it.
So the fix filters by canonical engram-id shape (`^(ENG|ABS|META)-[A-Za-z0-9-]+$`, same regex as
schemas/engram.ts). Residual (NEEDS-OWNER, low): an existing engram that gets only feedback/injection
events after the snapshot and is absent from it still counts; should the list be restricted to
`engram_created` events (requires updating backup.test.ts's event name)?

**Theorems** (`PlurSpec.Persistence.Backup`): `unrecoverable_only_engrams`.
**Replay / failing test first**: `packages/core/test/formal-persistence-backup.test.ts` before fix:
`Received: [ "ENG-2026-08-02-050", "INJ-2026-08-02-abc", "" ]`. After: pass.
**Fix**: `packages/core/src/backup.ts` `idsCreatedAfter` + `ENGRAM_ID` constant.
**Tests**: `npx vitest run packages/core/test/formal-persistence-backup.test.ts packages/core/test/backup.test.ts` → 25 passed.
**Mutation check**: dropping the id-shape filter from the model ⇒ `unrecoverable_only_engrams` fails.

## 7. Daily backups stop forever after one legitimate >10% removal (core-persistence#7)

**Verdict: CONFIRMED + NEEDS-OWNER** (policy: truncation vs legitimate shrink are indistinguishable by
count alone; the principled fix needs the write path, engrams.ts, which this agent does not own).

`last_good_count` is written only by a successful snapshot (backup.ts is its sole writer); the shrink
gate compares against it. After a user legitimately forgets >10% the gate refuses every day, the
baseline can never move, rotation (only after success) stops, and the corpus must regrow past 90% of
the old count before any snapshot is taken again. The warning says "Your last good backup is
unchanged" — true, and it gets older every day.

**Theorems**: `backups_stop` (for every day sequence below the floor, state is unchanged — no snapshot,
no baseline move), `healthy_day_snapshots` (non-vacuity).

**Replay**: `tsx scratchpad/replay7.mts`
```
day1 true
day2 false invalid shrunk
day3 false invalid shrunk
day10 false invalid shrunk
day40 false invalid shrunk
regrow to 89: false
snapshots: 2026-08-01:100
```

**Question for the owner** — how should a legitimate shrink re-baseline the backup gate?
- (a) The write path records what PLUR itself last wrote (`saveEngrams` stores its outgoing count in
  backups/.state.json); the gate compares the file against that — an external truncation still fails,
  a deliberate forget does not. Needs engrams.ts (WritePath's file) + backup.ts.
- (b) Re-baseline after the shrunk store has been stable and schema-valid for N consecutive days.
- (c) Explicit user action: `plur backup --accept-shrink` (CLI + backup.ts), and make the daily
  warning say so.
- (d) Re-baseline when the history log explains the drop (retire/forget events ≥ the missing count).

---

## 8. orderBySupersedes with duplicate ids (core-persistence#10)

**Verdict: CONFIRMED + FIXED** (the permutation property). Distinct-id behaviour (edges, stability,
cycles) was already right; it is now also checked by a randomized property test.

Keyed by id, `byId` is last-wins while `ready` lists a duplicated id once per copy: output carries the
last copy twice and drops the first — an engram vanishing from the flush, which the module's own
docstring calls worse than failing. Can `flushOutbox` pass duplicates? `pending` comes straight from
`_primaryStore.load()`, and the YAML loader does not reject duplicate ids (no dedup in engrams.ts'
`parseEngramFile`), so yes whenever the store holds one (hand edit, a sync that kept both sides).
Not replayed end-to-end through `flushOutbox` — replayed on the exported function.

**Theorems** (`PlurSpec.Persistence.Outbox`): `old_duplicate_drops` (counterexample by `decide`:
`[(7,1),(7,2)] ↦ [(7,2),(7,2)]`), `fixed_is_permutation` (positions emitted by the loop, nodup and in
range, plus the unplaced remainder = a permutation of the input), `fixed_no_edges_identity`
(stability, non-vacuity). Left out of the proof: edge order and stability of the Kahn loop itself —
covered by the property test, not proved.

**Replay**: `packages/core/test/formal-persistence-outbox-order.test.ts` against HEAD's
outbox-order.ts: duplicate-id case fails (tags `[2,2,3]`, expected `[1,2,3]`); against the fix: pass.

**Fix** (`packages/core/src/outbox-order.ts`): Kahn's algorithm over POSITIONS; an id may map to
several positions, and an engram superseding a duplicated id waits for every copy; `placed[]` by
position; leftovers (cycles) appended in input order. Same public signature.

**Tests**: `npx vitest run packages/core/test/formal-persistence-outbox-order.test.ts` + all
outbox/supersedes tests → 82 passed.

**Mutation check**: `fixedOrder := o ++ range n` (no unplaced filter) ⇒ `fixed_is_permutation` fails.

---

## 9. learn-async: locked check outside the lock (core-persistence#8)

**Verdict: CONFIRMED + FIXED.**

`executeDedupDecision` UPDATE/MERGE checked `commitment !== 'locked'` on `getById`'s pre-lock snapshot,
then re-loaded the row under the store lock and wrote it without re-checking. An engram locked in
between was rewritten (UPDATE) or appended to (MERGE). The UPDATE history event also recorded
`old_statement` from the stale snapshot.

**Theorems** (`PlurSpec.Persistence.LearnAsync`): `old_overwrites_locked` (counterexample),
`fixed_never_writes_locked`, `fixed_updates_unlocked` (non-vacuity).

**Replay / failing test first**: `packages/core/test/formal-persistence-learn-async.test.ts` —
`MemoryPrimaryStore` holding the locked row, `getById` returning the unlocked pre-lock snapshot, LLM
stub answering UPDATE / MERGE. Before the fix: `expected 'the deploy host is beta' to be 'the deploy
host is alpha'` (UPDATE) and `'the deploy host is alpha the deploy host is beta'` (MERGE). After: pass.

**Fix** (`packages/core/src/learn-async.ts`): under the lock, a row now locked returns `null` — the
existing fall-out path to ADD, the same outcome as locked-before-the-check; `old_statement` is taken
from the row read under the lock.

**Tests**: `npx vitest run packages/core/test/formal-persistence-learn-async.test.ts` + all
learn-async/dedup tests → 43 passed, 3 skipped.

**Mutation check**: dropping `cur.locked` from `writeFixed` ⇒ `fixed_never_writes_locked` fails.

---

## 10. Pack integrity hash is not injective (core-policy#5)

**Verdict: CONFIRMED + NEEDS-OWNER** (the hash is defined by ENGRAM-STANDARD-v1 §5.5; changing it
changes every shipped `INTEGRITY` value and every registry baseline).

`computePackHash` = SHA256(SKILL.md ‖ engrams.yaml), unframed; a missing file contributes nothing.
So bytes moved across the file boundary keep the hash (e.g. the tail of a SKILL.md instruction moved
into engrams.yaml), a missing SKILL.md equals an empty one, and the docstring's "usable as a
content-addressable identifier" is false. `verifyPackIntegrity` itself already says the check is no
defence against a determined sender — the defect is the identifier claim and the boundary ambiguity.

**Theorems** (`PlurSpec.Persistence.Packs`): `hash_boundary_collision`, `hash_missing_eq_empty` (both
for every hash oracle `H`).

**Replay**: `tsx scratchpad/replay9.mts`
```
A f624e206892d90782bbd7e551febe78b72ccca4aa526937ad486155dea0ad512
B f624e206892d90782bbd7e551febe78b72ccca4aa526937ad486155dea0ad512
A==B true            (SKILL.md "…Never run rm -rf.\n" + "engrams: []"  vs  "…Never run rm" + " -rf.\nengrams: []")
empty SKILL.md == missing SKILL.md true
```

**Question for the owner** — keep or version the pack hash?
- (a) New hash version: `sha256:v2:` over length-prefixed, named parts (e.g. `SKILL.md\0<len>\0<bytes>`
  per file, absent ≠ empty); accept both prefixes on verify; spec bump to §5.5 v2.
- (b) Keep the hash; correct the docstring (drop "content-addressable identifier") and document the
  boundary ambiguity in the standard.
- (c) (a) plus re-baselining installed packs on first verify.

## 11. Pack registry keyed by manifest name, directories by basename (core-policy#4)

**Verdict: CONFIRMED + NEEDS-OWNER** (registry.yaml is persisted state; the fix changes its key).

Install writes the registry row under `preview.manifest.name`, the pack directory under the source
basename. Two directories whose manifests share a name share one row: the second install overwrites
the first's baseline, and `listPacks` then reports the untouched first pack as `modified`.
`uninstallPack(dir)` removes the row by dir name AND by manifest name, so uninstalling one erases the
other's baseline — it becomes `unverified`, i.e. tamper detection silently lost.

**Theorems**: `registry_shared_row` (by `decide`).

**Replay**: `tsx scratchpad/replay10.mts` (two local packs `pack-one`, `pack-two`, both `name: shared-name`)
```
after both installs: [["pack-one","modified"],["pack-two","ok"]]
after uninstalling pack-one: [["pack-two","unverified"]]
```

**Question for the owner** — what identifies a pack in the registry?
- (a) Directory name: add a `dir` field to registry rows, match on it when present, fall back to
  `name` for legacy rows; uninstall removes only the row for that dir. Additive format change.
- (b) Manifest name, enforced: refuse to install a second pack whose manifest name is already
  installed under another directory (or install it under the manifest name).
- (c) Both: key by dir, warn on a duplicate manifest name.

---

## Run summary

- Model: `PlurSpec/Persistence.lean`, 586 lines (over the ~400 guideline; eight small sections, each
  modelling only the core property). Checks clean; no sorry/admit/axiom/native_decide.
- Combined targeted run (61 files matching formal-persistence|sync|lock|migrat|backup|pack|learn-async|
  dedup|outbox|supersedes|postgres|restore): 564 passed, 1 expected fail, 123 skipped (postgres
  suites need `PG_URL`), 1 failure = `formal-persistence-sync` "local commit" case timing out at 30 s on
  a loaded machine (381 s run). Fixed by giving that describe a 120 s timeout; re-run 4/4 pass.
- `npx tsc --noEmit -p packages/core` clean.
- Coordinator: run the full suite, and the postgres suites against a database if one is available.

---

## Apply phase (2026-09-26)

Decision P3 applied: engram_created only. `idsCreatedAfter` (packages/core/src/backup.ts) reports
ids with an `engram_created` event after the snapshot instant, minus ids with an `engram_retired`
event after it (the id-shape filter stays). Docstrings of `idsCreatedAfter` and
`RestorePlan.unrecoverable` updated. Pre-existing test changed: packages/core/test/backup.test.ts
"names SAME-DAY engrams the snapshot cannot recover" used the invented event name `engram_learned`
(not in `HistoryEvent`); now `engram_created` (comment explains). Model: `Kind`,
`unrecoverableP3`, theorems `unrecoverableP3_sound` (every reported id has a created event, no
retired event, is absent from the backup — for every log) and `unrecoverableP3_reports`
(non-vacuity). Mutation-check: dropping the retired filter, or counting every event kind ⇒
`unrecoverableP3_sound` and `unrecoverableP3_reports` fail, and each mutant proves a retired/other
id is reported (`mut_ref` by decide). Tests: packages/core/test/formal-apply-budget-backup.test.ts
P3 block (3; 2 failed before).

Decision P2 applied: last-written. `saveEngrams` (packages/core/src/engrams.ts) calls the new
`recordLastWritten(filePath, count)` (backup.ts) after its write lands; it writes
`backups/.last-written.json` (`{file, count}`) in the store file's directory, only if that
`backups/` already exists (the first snapshot creates it; packs, migrations and scratch stores never
grow one), best-effort and never throwing. `maybeDailyBackup` uses `readLastWritten(storePath) ??
last_good_count ?? strongest snapshot` as the shrink baseline. `restoreBackup` records the restored
count too (a restore is a PLUR write). The refusal reason now says "the baseline (what PLUR last
wrote, else the last good snapshot)". New machine-local state file; no change to the store, the
snapshots, their sidecars or `.state.json`. Model: `PState`, `Ev`, `stepP`, `runP`, theorems
`write_then_snap` (after any PLUR write, the next check snapshots), `truncation_refused` (a file
below 90% of the recorded count without a PLUR write is refused), `replay_rebaselines` (the
replayed 100 → 70 sequence snapshots every day; pre-fix `backups_stop` kept as the
counterexample), `replay_truncation_refused`. Mutation-check: a write that does not record
(`.write n => ⟨n, s.lw, …⟩`) ⇒ `write_then_snap` and `replay_rebaselines` fail. Tests:
formal-apply-budget-backup.test.ts P2 block (5; 2 failed before — the legitimate-shrink and the
restore cases; the truncation cases passed before and after, as intended). Regression: 22
backup/restore/engrams/primary-store/migration/packs/learn-async/formal-persistence files, 212 pass.
Residual (follow-up): a `plur sync` pull rewrites engrams.yaml through git, not saveEngrams; a pull
that legitimately removes >10% is refused for one day, until PLUR's next write records the count.

Decision P1 applied: heartbeat. packages/core/src/store/async-lock.ts: new `startHeartbeat(lockPath,
token, staleThreshold)` registers the held lock and starts an unref'd `setInterval` every
`floor(staleThreshold/3)` that re-touches the lock (`utimes`) iff it still carries the holder's
token; returns a stop function. New `heartbeatHeldLocks()` (synchronous, throttled to the same
interval) touches every lock this process holds; new `activeHeartbeats()` diagnostic. `withFileLock`
starts the heartbeat after acquisition and stops it in the `finally` before release (return and
throw). Synchronous twin packages/core/src/sync.ts `withLock`: same start/stop. Because both
`Plur.sync()`'s git work and the sync twin's `fn` block the event loop (a timer cannot fire), sync.ts
`git()` calls `heartbeatHeldLocks()` before every git command: the lock's age is then bounded by
interval + longest blocking segment = 20 s + 30 s (git timeout) = 50 s < 60 s. No lock-file format
change. Model (new §3b `Heartbeat`): `timer_never_stale` (interval T/3, every instant of the hold),
`sync_age_bound` (age < H + B for every sequence of blocking segments ≤ B, with the throttle),
`default_sync_fresh` (three 30 s git commands stay < 60 s) and the pre-fix counterexamples
`old_stolen_mid_hold` (replayed 61 s) and `old_default_sync_stale`. Mutation-check: no timer touch
(`staleTimer := t > T`) ⇒ `timer_never_stale` fails (omega); no touch at sync points (`a' := a`) ⇒
`sync_age_bound` fails and `default_sync_fresh` is refuted by decide. Tests:
packages/core/test/formal-apply-budget-lock.test.ts (6; 4 failed before, incl. the replay: a
host-A holder mid-hold, contender on "host-B" via mocked `os.hostname` through a symlinked path,
stole the lock and overlapped). Regression: 53 lock/sync/persistence/backup/episode/tension/
migration/learn-async/plur files: 716 pass; the only failures were ApplyCore's in-progress
formal-apply-core-queued-scope.test.ts (D3/D4, not touched here).
Limits: a synchronous `withLock` holder that blocks for longer than the threshold WITHOUT passing a
touch point (e.g. a very long migration) is still unprotected — no such hold is known; the
migration runner does not call git.
