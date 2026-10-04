# Findings — R2-Persist (round 2 of the persistence cluster, 2026-09-26)

Model: `spec/formal/PlurSpec/R2Persist.lean` (namespace `PlurSpec.R2Persist`).
Check: `cd spec/formal && lake env lean PlurSpec/R2Persist.lean` (no output = clean).
Scratch replays and mutants: `<session scratchpad>/r2persist/` (not committed).

---

## 1. Removing an abandoned steal guard is itself unguarded (round-1 residual)

**Verdict: CONFIRMED + FIXED.**

Round 1 serialized lock stealing with one guard file, `<lock>.steal`, and proved mutual exclusion
in a model where a process holding the guard never dies. A guard left by a crashed stealer was
removed by `clearAbandonedGuard`: stat + read ("writer dead"), then `unlink(guard)`. That unlink
removes whatever sits at the path by then. The double fault is real. S crashes inside the guard.
A and B both judge S's guard abandoned. A unlinks it, takes the guard and re-reads the lock (H).
B's unlink, judged on S's file, removes A's live guard. B takes the guard and also re-reads H. Two
live stealers are inside the guard, which is the precondition of the round-1 race: A claims H and
acquires, B renames A's live lock aside, C acquires, and B's put-back loses.

**Replay** (`packages/core/test/formal-r2-persist-guard.test.ts`, first case). One process, with
symlinked views of one directory and wrapped `unlink`/`rename` to force the interleaving. Before
the fix: `AssertionError: expected 2 to be 1` (maxInCS = 2).

**Fix** (`packages/core/src/store/async-lock.ts`, sync twin `packages/core/src/sync.ts`). The
guard becomes a ladder of slots keyed by the judged token:
`stealGuardPath(lock, expected, k) = <lock>.guard-<sha256(expected)[:16]>-<k>`. A stealer O_EXCL-creates
the lowest slot above a run of abandoned ones. It then verifies that every lower slot still exists
and is still abandoned. Only after that does it re-read the lock and claim. While the judged token
is at the lock path, nobody but a slot's own writer ever unlinks that slot, so no read-then-unlink
of someone else's file remains. After a confirmed claim the token has left the lock path for good,
because tokens are unique per acquisition and a dead holder cannot re-acquire. The claimer then
clears the rest of that ladder (`clearStealSlots`). A stealer still inside the ladder re-reads,
finds another token and backs off. `claimAndRemove` / `claimAndRemoveSync` now return whether the
claim was confirmed. `STEAL_GUARD_SLOTS = 8`: after 8 stealer crashes on one lock instance the steal
gives up and the acquire deadline reports the lock file. A slot is judged abandoned by the same rule
as before (writer dead, or unknown liveness and older than 10 s). There is no lock-file format
change. Transient file names change from `<lock>.steal` to `<lock>.guard-…-k`.

**Theorems** (`PlurSpec.R2Persist.Guard`). Processes die at any step (`die`; `dead` is state):
- `old_two_holders` — counterexample, by `decide` on the executable old protocol (single guard +
  read-then-unlink): the 15-step trace above ends with `hold 1 = hold 3 = true`.
- `inv_step`, `reach_inv` — a 7-part invariant is inductive over all 16 actions of the fixed protocol,
  crashes included. The parts: live holders own the lock; stealers target dead tokens; `seen` ⇒ the
  lock is still the judged token; claims are confirmed and the token is gone; while the judged token
  is the lock, a live slot-holder's slot is its own and every slot below its verification point holds
  a dead writer.
- `excl` / `ladder_guard_excl` — two live processes past verification for the same judged token,
  while it is still the lock, are the same process. This is the property round 1's proof needed from
  its single guard.
- `ladder_mutex` — at most one LIVE process in the critical section in every reachable state.
- `init1_inv`, `ladder_recovers` — non-vacuity: with H dead and a crashed stealer's slot 0, a live
  process walks past slot 0, verifies it, steals, clears the ladder and enters.
- Model assumptions (unchanged from round 1): the liveness probe is exact (age-based "dead" for an
  unprobeable writer is the round-1 §4 policy); a dead token never reappears at the lock path.

**Mutation check** (scratch copies):
(a) no verification (`scanNew` goes straight to `crit`) ⇒ `inv_step` fails.
(b) clearing the ladder after an unconfirmed read ⇒ `inv_step` fails.
(d) verification accepts a live lower slot ⇒ `inv_step` fails.
(c) walking past a LIVE slot during the scan still proves. The post-create verification is what
carries safety, and the scan's skip rule only affects progress. This is recorded as a design fact.

**Tests**: `formal-r2-persist-guard.test.ts` (4): the replay; async recovery from an abandoned guard
leaves no guard files; the same for the sync twin; a live stealer's slot is never removed or
bypassed (sync twin times out instead). Regression: `formal-persistence-lock`, `async-lock*`,
`lock`, `config-lock`, `formal-apply-budget-lock`, `audit-821-blockers`,
`secondary-store-retire-lock` → 68 passed.

Residue: slots created by a stealer that arrives after the ladder was cleared, and then crashes, are
left as files. They are keyed by a token that never returns, so they are harmless.

---

## 2. Store-shape and duplicate-id rules drift across readers (core-persistence#11)

**Verdict: CONFIRMED + FIXED (shape rule, the detector, chunk-dependence) + NEEDS-OWNER (which copy of a duplicated id wins).**

Five readers checked, with these rules before the fix:

| reader | bare top-level list | duplicate id |
|---|---|---|
| `parseEngramFile` (loader) | refused | both copies returned; YAML-path lookups (`Array.find`) see the FIRST |
| sync `readEngramList` | **accepted** — stripped, committed, pushed | ignored |
| backup `validateStore` | refused | snapshot refused (`duplicate-ids`) |
| PGLite `upsertEngramsTx` | (via loader) | index keeps the LAST copy, silently |
| Postgres `save`/`updateMany` | n/a | error inside one 500-row chunk; **silently last-wins across chunks** |

**Replays**:
- Shape: `tsx <scratch>/head/replay2.mts` against HEAD's sources:
  `loader: refused — … top-level value is not a mapping` /
  `sync: initialized …` / `committed blob: "- id: ENG-2026-09-26-001\n  statement: bare array\n"`.
  Sync committed a store that PLUR cannot load.
- Postgres, against the throwaway pgvector container:
  `formal-r2-persist-shape.test.ts` before the fix. Cross-chunk: `promise resolved "undefined" instead of rejecting`.
  In-chunk and updateMany: `got 'ON CONFLICT DO UPDATE command cannot …'`.

**Fix**:
- `packages/core/src/engrams.ts` factors the loader's rules into three exported single sources.
  `engramStoreEntries` is the shape rule and throws `EngramStoreUnreadableError`. `parseEngramEntry`
  is normalise + validate. `duplicateEngramIds` is the one detector.
- `parseEngramFile` uses the first two, so its behaviour is unchanged.
- `sync.ts` `readEngramList` uses `engramStoreEntries`, so a bare list is now `SyncStoreUnreadableError`.
  `stageStrippedEngrams` drops its bare-list branch. `restoreWithheld` restores the saved bytes when
  the pulled engrams.yaml fails the shape rule.
- `backup.ts` `validateStore` uses `parseEngramEntry` (the loader's per-entry rule, normalisation
  included) and `duplicateEngramIds`. Its failure codes are unchanged.
- `storage-postgres.ts` `save`/`updateMany` call `refuseDuplicateIds` before anything is written. The
  refusal is one clear error naming the ids, and it no longer depends on where the chunk boundary falls.
- `storage-pglite.ts` still keeps the last copy, because `pglite-duplicate-ids.test.ts` pins that on
  purpose. It now logs a warning naming the duplicated ids through the same detector.

**Theorems** (`PlurSpec.R2Persist.Shape`):
- `old_sync_accepts_unloadable` — counterexample.
- `readers_agree` — sync and backup shape = loader shape, for every document.
- `canonical_accepted` — non-vacuity.
- `old_chunk_dependent` — counterexample by `decide`. The same batch errors when both copies share a
  chunk and silently keeps the later one when they do not.
- `fixed_chunk_independent` — for EVERY chunking of the batch, the outcome is "refused iff an id
  repeats, else every row upserted in order".
- `fixed_no_loss` — when the save goes through, every row is stored as given.

**Mutation check**:
- `syncNew := syncOld` ⇒ `readers_agree` fails.
- Dropping the whole-batch refusal ⇒ `fixed_chunk_independent` fails.

**Tests**: `packages/core/test/formal-r2-persist-shape.test.ts` (7, of which 3 Postgres, gated on
`PLUR_TEST_POSTGRES_URL`). Before the fix, 3 failed (Postgres). The sync case was replayed on HEAD by
script, because the fix to sync and the test were written together.

**Pre-existing test changed**: `packages/core/test/sync.test.ts`. Its fixture `engrams.yaml` was a bare
top-level list in `beforeEach` and in six inline writes (lines 23, 48, 110, 123, 185, 229, 261). No
test there is about the shape: they test git behaviour and used the shape PLUR's loader has refused
since #766. They now write `engrams:\n  - id: …`. After the fix and before this change, 19/42 failed
with `SyncStoreUnreadableError`. After the change, 42/42 pass.

**NEEDS-OWNER (duplicate ids — which copy is "the" engram?)**. The store can hold two records with
one id, and not only through hand edits. `generateEngramId` mints `max(same-day suffix)+1` per
machine, so two synced machines that learn on the same day mint the same id for two different
engrams. The records then disagree across readers. YAML-path lookups and updates (`find` /
`findIndex` in index.ts) act on the first copy, and the second copy is never reachable by id. The
PGLite index shows the last copy, so recall can surface one engram while feedback and forget act on
the other. The Postgres writer now refuses. The backup gate refuses to snapshot.
- (a) **Re-id on detection** (recommended): when the loader sees a repeated id, the later copy gets
  a fresh id (logged, and recorded in history as a rename). Every reader then sees distinct
  engrams. This is a persisted change to the store, so it needs the owner.
- (b) First copy wins everywhere, and later copies are quarantined (kept in the file, excluded from
  reads), like schema-invalid entries. PGLite would switch to first-wins, which changes
  `pglite-duplicate-ids.test.ts`.
- (c) Last copy wins everywhere (the PGLite/F7 choice). YAML-path lookups would switch to the last copy.

---

## 3. Sync restore keeps both records when a withheld id also arrives from the remote (round-1 residual)

**Verdict: CONFIRMED + NEEDS-OWNER.** This is the same decision as item 2 (duplicate ids), so it is
reported once there, with this case added.

`restoreWithheld` appends the held (withheld) records to the pulled engrams.yaml. If the pull brought
a record with the same id, the store now holds that id twice. The realistic source is the same-day id
minting described in item 2. The effect: the pulled record comes first, so every YAML-path lookup by
that id returns the REMOTE record. The machine's own local engram can no longer be read, updated or
forgotten by id. The PGLite index shows the local one (last copy wins), and the backup gate refuses
to snapshot the store.

**Replay** (`tsx <scratch>/r3/replay3.mts`: two repos and a bare remote, real `sync`). A holds
`ENG-2026-09-26-002` (scope local, "A local note"). B mints the same id for "B team fact" and pushes it.
```
A sync: Synced. pulled 1 remote commit(s).
A engrams.yaml: ["…-001:global:A shared","…-002:global:B team fact","…-002:local:A local note"]
A lookup ENG-…-002 -> B team fact
```

**Theorems** (`PlurSpec.R2Persist.Restore`): `old_restore_shadows_local` (counterexample by
`decide`), `restore_no_collision_reachable` (non-vacuity).

**Why not fixed**: every fix picks a user-visible outcome.
- Re-id the held record: a persisted id change of the user's engram.
- Drop one of the two copies: data loss.
- Refuse the pull: sync stops converging until the user acts.

**Question for the owner** (asked together with item 2): on a collision between a withheld local
record and a pulled record with the same id, what should happen?
- (a) **Re-id the held (local) record** (recommended). It was never pushed, so nothing outside this
  machine refers to it. Record the rename in history.
- (b) Keep both and apply the item-2 duplicate rule.
- (c) Refuse the pull ("not pulled — id collision on X"), restore the saved bytes and leave it to the user.

---

## 4. A failed schema stamp after a successful save splits corpus and version (round-1 residual)

**Verdict: CONFIRMED + FIXED.**

`runMigrations` and `rollbackMigrations` call `saveEngrams` and then `setSchemaVersion`. The code's own
comment says "the corpus and the version it claims to be at must become visible together, or they can
disagree". When the stamp throws (the config lock is held by another process, EACCES, a full disk),
they disagree:
- **Run**: the migrated corpus keeps the old version, and the next run re-applies the migrations to
  already-migrated data.
- **Rollback**: this is the worse case. The corpus is rolled back but still claims the current version.
  `pending` is empty from then on, so nothing ever migrates it again. The missing `commitment` /
  `content_hash` fields go undetected.

**Replay / failing test first** (`packages/core/test/formal-r2-persist-schema-stamp.test.ts`). The fault
is a live holder of `config.yaml.lock`, which makes `withLock` give up after ~3 s. Before the fix, both
fault cases failed: `expected false to be true` (the engrams.yaml bytes had changed while the version
had not).

**Fix** (`packages/core/src/migrations/runner.ts`). A new `saveAndStamp` is used by both paths. It
keeps the pre-write bytes and saves. If the stamp throws, it atomically writes the old bytes back,
re-records the backup gate's last-written count (`recordLastWritten`) and throws `… engrams.yaml was
restored to its previous contents; nothing changed`. If the restore fails too, the error names both
versions and the manual fix: set `schema_version`, or restore `.bak.<v>`. This matches the round-1
doctrine that a failed run leaves the live file as it was. Not handled: a crash between the two
writes. Closing that needs the version inside the store file, which is a format change.

**Theorems** (`PlurSpec.R2Persist.Stamp`):
- `old_rollback_split` — counterexample: 6 → 0 with a failed stamp gives corpus 0, stamp 6.
- `fixed_consistent` — starting consistent, corpus = stamp after the run for every stamp/restore
  outcome, or the double fault is reported loudly.
- `fixed_success` — non-vacuity.

**Mutation check**: dropping the restore (`else ⟨target, s.stamp, false⟩`) ⇒ `fixed_consistent` fails.

**Tests**: formal-r2-persist-schema-stamp (3) + formal-persistence-migrations, migrations,
sp2-migrations, pr1-indexed-migration, migration-006-recompute-hashes → 44 passed.

---

## 5. PGLite skip-if-unchanged fingerprint `size:mtimeMs` misses same-size writes (core-persistence#9)

**Verdict: CONFIRMED + FIXED.**

`syncFromYaml` returns early when the stored fingerprint equals `size:mtimeMs`. Its docstring says
the guard "cannot mask a real change: any write … changes size or mtime". yaml-primary-store.ts:9-13
(#25) contradicts that for filesystems with coarse timestamps. Take a same-size rewrite inside one
timestamp tick, for example a feedback counter 1 → 2, or a statement edited to the same length.
It keeps both fields, the sync is skipped, and the index serves the old text until the next
different-size write.

**Replay / failing test first** (`packages/core/test/formal-r2-persist-fingerprint.test.ts`). The
tick is simulated by putting the old mtime back with `utimes`. Before the fix:
`expected 'deploy host is alpha' to be 'deploy host is gamma'`.

**Fix** (`packages/core/src/storage-pglite.ts`). The recorded fingerprint is now JSON
`{stat, hash, racy}`:
- `stat` = `size:mtimeNs:ctimeNs:ino` (bigint stat).
- `hash` = sha256 of the bytes.
- `racy` = the file's mtime or ctime was within `RACY_FINGERPRINT_MS` (3 s) of the moment the
  fingerprint was recorded. This is git's "racily clean" rule.

A stat match that is not racy is trusted as before, and costs nothing, which is the #1046 hot path.
Otherwise the bytes are hashed. An equal hash only refreshes the stat, with no DB work. A different
hash runs the full sync. The stat is taken before the read, so a change landing in between is either
in the hash or leaves the record racy. A pre-round-2 `size:mtime` row does not parse, which forces
one full sync. The index format is unchanged apart from this one `sync_state` value.

**Theorems** (`PlurSpec.R2Persist.Fingerprint`). Granularity `g`, a write at `t` stamped
`t / g * g`, and the hash modelled as the content (collision-free):
- `old_skips_change` — counterexample by `decide`.
- `fixed_skip_sound` — if the window covers the granularity plus the read-to-record delay
  (`g + d ≤ R`), a skip implies the new content equals the synced content, for every later version.
- `fixed_quiet_skip` — non-vacuity: a quiet file is skipped on the stat alone.

Assumption: the filesystem's clock is the local clock, with granularity ≤ 3 s minus the
read-to-record delay.

**Mutation check**: dropping the racy condition (skip on any stat match) ⇒ `fixed_skip_sound` fails.

**Tests**: `formal-r2-persist-fingerprint.test.ts` (2), `pglite-duplicate-ids`, `normalize-engram`,
`storage-adapter-role`, `vector-index-strategy`, `embedding-staleness-812` pass. In a first run on a
loaded machine (five agents running suites), `pglite-adapter` and `sync-index-error` tests timed out at
their 30 s limit, and the failing tests changed between runs. Both files pass in the final combined run
(run summary below).

---

## 6. Shrink guard: ratchet through tolerated writes; `countEngramsOnDisk` null fails open (core-persistence#12)

**Verdict: fail-open CONFIRMED + FIXED; ratchet CONFIRMED + NEEDS-OWNER.**

**(a) Fail-open.** `countEngramsOnDisk` returned `null` ("no baseline") for an EXISTING file it could
not count, and `assertShrinkAllowed` lets `null` through. That covers conflict markers, zero bytes,
EACCES, and a shape the loader rejects. So an undeclared whole-corpus write replaced a store whose
size nobody knew. Concrete case: a manual `git pull` in `~/.plur` leaves both sides' engrams between
conflict markers, and a running process overwrites them with its older in-memory corpus. The
docstring's defence ("callers already went through `loadEngrams`") holds for the file as it was at
load time, not for the file being replaced.

Replay / failing test first: `packages/core/test/formal-r2-persist-shrink.test.ts`. Before the fix,
three cases failed with `expected function to throw an error, but it didn't`: conflict markers, zero
bytes, and a store chmod 000.

Fix (`packages/core/src/engrams.ts` `countEngramsOnDisk`):
- A missing file or a directory still returns `null`.
- A read error other than ENOENT throws `EngramStoreUnreadableError`.
- An unscannable shape now goes through the loader's own `engramStoreEntries` (item 2's single
  rule), which counts or throws.
- `allowShrink` callers never reach the guard, so a deliberate repair still goes through.

**(b) Ratchet.** Each undeclared write is judged against the file as it is now, so the 10% tolerance
compounds. Replay (`tsx <scratch>/r6/replay6.mts`, real `saveEngrams`):
`after 10 undeclared writes, none refused: 37 of 100`.

**Theorems** (`PlurSpec.R2Persist.Shrink`):
- `ratchet_to_37` — counterexample by `decide`.
- `old_fails_open` — counterexample.
- `fixed_fail_closed` — an allowed undeclared write lands only on a missing store, or drops at most
  10% of a store it counted.
- `fixed_allows` — non-vacuity.
- For the owner's option (a): `ratchetBase`, `base_bounds` (a run of shrinking writes never ends
  below 90% of its starting baseline) and `base_refuses_replay` (the replayed run is refused at step 2).

**Mutation check**: `.uncountable => true` ⇒ `fixed_fail_closed` fails.

**Tests**: `formal-r2-persist-shrink.test.ts` (5) + `store-corruption-guard`, `property-shrink-guard`,
`primary-store`, `learn-async-seam`, `corruption-matrix`, `unreadable-store-guard` → 146 passed.

**Question for the owner** (ratchet): the guard's comment allows undeclared small removals ("paths
that forget to declare themselves"), so making the tolerance cumulative would refuse writes that
succeed today.
- (a) **Cumulative since the last non-shrinking write** (recommended; proved above): the baseline
  moves on growth or on a declared shrink, and a run of undeclared shrinks may drop at most 10% of
  it in total. In-process baseline, no new persisted state. A process restart resets it.
- (b) Per write, as today (document that the guard catches single bad writes, not a slow leak).
- (c) Zero tolerance: every removal must declare `allowShrink`. Audit the undeclared removers first.

---

## 7. Follow-ups: record the count after a sync pull; warn on a too-short staleThreshold

**Verdict: both CONFIRMED + FIXED.**

**(a) A pulled shrink skipped the backup.** Decision P2 records what `saveEngrams` wrote. A `plur sync`
pull rewrites engrams.yaml through git instead, so after another machine legitimately forgot more
than 10%, the next daily backup was refused as `shrunk`. That lasted until PLUR's next local write.
Replay on HEAD (`tsx <scratch>/head/replay7.mts`): `day1 taken: true` →
`A sync: Synced. pulled 1 remote commit(s).` → `day2 taken: false [ 'shrunk' ]`.
Fix (`packages/core/src/sync.ts`): `sync()` keeps engrams.yaml's text before `pullRebase`. After the
pull, a new `recordPulledCount` calls `recordLastWritten` with the count that landed. It runs only if
the text changed and the file passes the loader's shape rule (`engramStoreEntries`). An external
truncation that is neither a PLUR write nor a pull is still refused.

**(b) Short custom `staleThreshold`.** The heartbeat bounds a lock's age by `T/3 + 30 s`: one git
command blocks the event loop between touch points. For `T ≤ ~45 s` that bound does not keep the
lock fresh, and a holder whose liveness cannot be probed (another host) can be stolen from mid-sync.
Nothing said so. HEAD replay: `staleThreshold 40000 warnings: 0`.
Fix (`packages/core/src/store/async-lock.ts`): `startHeartbeat` calls `warnIfThresholdTooShort`. That
logs one warning per distinct non-default threshold when `T/3 + GIT_COMMAND_TIMEOUT_MS ≥ T`, and names
the minimum (> 45 000 ms). The warning is advisory and refuses nothing, since short thresholds are
fine for locks that never run git. `GIT_COMMAND_TIMEOUT_MS = 30_000` is now exported and used by
sync.ts `git()` as its `execFileSync` timeout, so there is one source for both.

**Theorems** (`PlurSpec.R2Persist.Followups`):
- `old_pulled_shrink_refused` — counterexample.
- `pull_then_snap` — after any pull, the next daily check snapshots.
- `ext_still_refused` — an external truncation is still refused.
- `warns_iff` — the warning fires exactly when `T/3 + B < T` fails.
- `warns_examples` — 40 s warns; the 60 s default does not.

**Mutation check**: a pull that does not record (`.pull n => file only`) ⇒ `pull_then_snap` fails.

**Tests**: `packages/core/test/formal-r2-persist-followups.test.ts` (3: the two-machine pulled-shrink
scenario, one warning for 40 s, none for the default or 120 s).

---

## Run summary

- Model: `PlurSpec/R2Persist.lean`, 971 lines in seven sections. It is over the ~400-line guideline
  because §1 carries a full inductive proof over 16 actions with crashes. It checks clean, with no
  sorry/admit/axiom/native_decide. It is not yet imported from `PlurSpec.lean`; the coordinator adds
  `import PlurSpec.R2Persist`.
- Combined targeted run with `PLUR_TEST_POSTGRES_URL` set: 86 files in `packages/core/test` matching
  lock|sync|backup|engram|pglite|postgres|migrat|shrink|corrupt|primary|formal-persistence|formal-r2-persist|store|restore|learn-async|normalize|unreadable|yaml|episode|tension|config
  → 85 passed, 1 skipped; 1039 tests passed, 7 skipped.
- `npx tsc --noEmit -p packages/core`: no errors in files owned here. The one reported error is
  `index.ts:6324`, which is R2-CoreA's file and in progress.

---

## Apply phase — owner decisions of 2026-09-27

Decision P1 applied: "keep both, rename one" (item 2). `engrams.ts` exports the one rule,
`resolveDuplicateIds`: the first copy keeps the id; a later copy with different content gets
`freshDuplicateId` = `<id>-D<8 hex of sha256(canonical content)>` (`-2`, `-3`, … only if taken),
which is deterministic, so every reader and every re-read agree on it; an exact duplicate (same
content, key order ignored) is read once. `parseEngramFile` applies it, so the loader and every
caller of `loadEngrams` (PGLite sync/reindex, packs, the indexed store) see distinct ids.
`loadEngrams` records each rename as a history event `engram_rekeyed` (new event type in
`history.ts`; `engram_id` = new id, `data.from`/`data.to`, `reason`), once, however often the
file is read. History is written only when the store sits in a PLUR root (a `history/` dir or
`config.yaml` beside it), so a pack gets no history directory. The rename reaches the file on the
next write. Exact duplicates the loader dropped are subtracted from the shrink guard's count, so
a store holding one record twice is not refused as a 50% shrink. PGLite `upsertEngramsTx` applies
the same rule instead of last-wins (idempotent on loader output). Postgres `save` applies it instead
of refusing; `updateMany` still refuses a repeated id, because its rows name existing rows to
replace and renaming one copy would insert rather than update. The backup gate no longer fails on
`duplicate-ids`, because the loader resolves them without loss.
- Theorems (`PlurSpec.R2Persist.DupIds`): `old_loader_shadows` (OLD, counterexample: the later
  engram answers to no id), `resolve_example`, `resolve_ids_distinct` (no id repeats after the rule),
  `resolve_no_loss` (every record's content is readable under some id), `resolve_first_keeps`,
  `resolve_idem` / `resolve_twice` (re-applying the rule in PGLite/Postgres to loader output changes
  nothing). `freshNat` models the TS "outside every taken id" loop.
- Mutation checks (scratch copies of the full file): the rename branch keeping the old id ⇒
  `resolve_example` fails and `resolve_ids_distinct` stops proving; its statement is false on
  `[(2,7),(2,8)]`, checked by `decide`. Dropping the later copy (first-wins) ⇒ `resolve_no_loss` is
  false on the same input, content 8 is missing.
- Tests: `formal-r2-apply-persist-dupids.test.ts` (9, of which 2 Postgres). All failed before the change.
- Pre-existing tests changed:
  - `pglite-duplicate-ids.test.ts`: pinned last-wins. Now both copies are indexed, the later under
    the loader's fresh id. The F7 no-abort property is unchanged.
  - `backup.test.ts` "rejects duplicate ids" → "accepts duplicate ids — the loader resolves them (P1)".
  - `formal-r2-persist-shape.test.ts`: two Postgres `save` cases pinned the interim refusal. They now
    assert both copies are kept, independent of the chunk boundary. `updateMany` still refuses.
  - `pack-lifecycle-conformance.test.ts` invariant 7: `engrams_without_record` was pinned at 0 while
    two engrams answered to one id. It is now 1: the second engram is distinct and has no record of
    its own. `record_count` is still 1, and the gap is still never negative.

Decision P1b applied: re-id the held local record (item 3). `sync.ts` `restoreWithheld` →
`rekeyHeldAgainstPulled`: when the pull brings a record with a held record's id, the pulled record
keeps the id and the held (never pushed) record gets `freshDuplicateId`. The rename is recorded
in `<root>/history` (`engram_rekeyed`, `cause: 'sync-pull'`). A held record identical to the pulled
one is not appended twice. On a shared remote, held sibling records (tensions, episodes, candidates)
that name the old id are rewritten to the new id, including when the pull left that sibling file
alone. Otherwise a tension about the local engram would silently attach to the teammate's engram.
- Theorems (`PlurSpec.R2Persist.Restore`): `old_restore_shadows_local` is kept, labelled OLD.
  New: `restore_example`, and `restore_both_reachable` (for every pulled list: every pulled id still
  returns the pulled record, and the held record is readable under its own, possibly new, id).
- Mutation check: no rename (`some r` for a clashing held record) ⇒ `restore_example` fails
  (`decide`) and `restore_both_reachable` does not prove.
- Tests: `formal-r2-apply-persist-sync-collision.test.ts` (2: the item-3 two-machine replay, and
  the shared-remote sibling follow-through). The first failed before the change (`expected 2 to be 3`).
  The second was mutation-checked: an identity `renameIdRefs` ⇒ it fails.
- Not covered: on a PERSONAL remote, sibling files are not held. A committed episode that names a
  `scope:local` engram id keeps the old id after a P1b rename. See the question below.

Decision P2 applied: cumulative tolerance (item 6b). `engrams.ts` `judgeShrink` keeps, per store
file and in process only, `shrinkRuns = {base, last}`: the baseline of the current run of
undeclared shrinks, and the count this process last wrote. A write that does not shrink, a declared
(`allowShrink`) write, or a first write starts a new run at its own count. An undeclared shrink is
allowed only if it keeps ≥ 90% of the baseline. If the file's count is no longer what this process
last wrote (another process, a sync pull, a hand edit), the run restarts at the file as it is, so
a legitimate removal made elsewhere does not refuse this process's next small one. The per-write
rule is kept, because the baseline is never below the file. The refusal message names the baseline
when a run is the cause.
- Theorems (`PlurSpec.R2Persist.Shrink`): `ratchet` / `ratchet_to_37` are kept, labelled OLD.
  The proposal (`ratchetBase`) is replaced by the implemented model (`RS`, `judge`, `stepR`, `runR`).
  `base_bounds`: after a write of `d`, a run of undeclared shrinks never ends below 90% of `d`.
  `new_implies_old`: never weaker than the per-write rule. `base_refuses_replay`: 100 → 90 → 81 is
  refused at step 2. `growth_resets`, `declared_resets`, `ext_restarts`: non-vacuity.
- Mutation checks: per-write baseline (`base := disk`) ⇒ `base_refuses_replay` (`decide`) and
  `base_bounds` fail. No restart on an external write ⇒ `ext_restarts` fails. Dropping `max` ⇒
  `new_implies_old` fails.
- Tests: `formal-r2-apply-persist-ratchet.test.ts` (6). The replay and the 37-run failed before the
  change. No pre-existing test changed.

Apply-phase run: `PLUR_TEST_POSTGRES_URL=… npx vitest run --testTimeout=120000` over 121 core test
files matching lock|sync|backup|engram|pglite|postgres|migrat|shrink|corrupt|primary|formal-persistence|
formal-r2|store|restore|learn-async|normalize|unreadable|yaml|episode|tension|config|dup|compact|
forget|pack. Result: 119 passed, 2 skipped files; 1403 tests passed. Two tests failed on the loaded
machine: `formal-apply-budget-lock` (heartbeat timing) and `formal-r2-retrieval-telemetry`
(concurrent processes). Neither touches changed code, and both pass when run alone (12/12).
`npx tsc --noEmit -p packages/core`: clean. `lake env lean PlurSpec/R2Persist.lean`: clean, 1327
lines, no sorry/admit/axiom/native_decide.

Questions for the owner (follow-ups): the coordinator answered all three under the owner principle
"keep both, rename one — nothing lost or hidden". They are applied below.

### Follow-ups under "keep both, rename one — nothing lost or hidden"

Decision P1b follow-up 1 applied: committed sibling references follow the rename (personal remote).
`sync.ts`: `pullRebase` reads the sibling files (episodes, tensions, candidates) from the working
tree before the pull (`readSiblingsBeforePull`). After a P1b rename, `rewriteLocalSiblingRefs`
rewrites the old id to the new id in every sibling record that was already on this machine before
the pull, committed ones included. Before the pull the old id named only the local engram, so those
references meant it. Records the pull brought are left alone, because their references mean the
pulled engram. `sync()` then commits the rewritten files, and the same sync pushes them to the
user's own remote. The rename is recorded once as `engram_rekeyed` with `cause: 'sync-pull'` and
`files` (every sibling file rewritten, held or committed). `restoreWithheld` now returns its renames
and rewritten files instead of recording them itself.
- Theorems (`Restore`): `old_local_ref_hijacked` (OLD, counterexample: the local reference reads the
  other machine's engram), `local_ref_follows` (a rewritten local reference resolves to the held
  record) and `other_refs_unchanged`. Mutation: `rewriteRef` as the identity ⇒ `local_ref_follows`
  fails.
- Test: `formal-r2-apply-persist-nothing-hidden.test.ts`, case 1. A's episode EP-A follows the new id,
  B's EP-B keeps the pulled id, the remote holds the rewritten EP-A, and the event lists
  `files: ['episodes.yaml']`. It failed before the change, and fails again with the rewrite disabled.

Decision P1 follow-up 2 applied: Postgres `save` renames reach history. `storage-postgres.ts`: the
adapter has `setRenameListener(fn)`. `save` hands the listener the renames from
`resolveDuplicateIds` after the transaction commits. `index.ts` (the constructor, for this item
only): when the injected store offers `setRenameListener` and the instance is not readonly, `Plur`
registers a listener. It appends `engram_rekeyed` (`cause: 'store-save'`, `store: 'postgres'`) to
the instance's own history root. The log line remains for a bare adapter that no engine is attached
to.
- Theorems (`DupIds`): `renames` (what is reported), `renames_complete` (every record stored under a
  changed id is reported) and `renames_sound` (every reported rename changes an id, and its new id
  is stored). Mutation: reporting nothing ⇒ `renames_complete` fails.
- Test: case 2 (Postgres). `new Plur({ path, store: adapter })`, then a clashing `save`: the history
  has one `engram_rekeyed` for the new id. It failed before (`expected [] to have a length of 1`),
  and fails again with the listener call disabled.

Decision P1 follow-up 3 applied: a quarantined entry that shares a valid engram's id is kept.
`engrams.ts` `saveEngrams` used to DROP such an entry ("re-added properly"), which lost it whenever
the two were different engrams. Now it is written back verbatim except for a fresh id
(`freshDuplicateId`, the same rule as the loader), so both stay addressable. The quarantine map is
updated to the new ids. The rename is recorded in history (`quarantined: true`) when the store is in
a PLUR root, and logged either way. A second load and save renames nothing more.
- Theorems (`DupIds`): `old_quarantine_dropped` (OLD, counterexample), `reattach_no_loss` (every
  quarantined entry is written back under some id), `reattach_clear` (no re-attached entry carries a
  valid engram's id) and `reattach_example`. Mutations: dropping the entry ⇒ `reattach_no_loss`
  fails; keeping the old id ⇒ `reattach_clear` and `reattach_example` fail.
- Test: case 3. It failed before the change, and fails again with the old drop restored.

Run: `PLUR_TEST_POSTGRES_URL=… npx vitest run --testTimeout=120000` over 128 core test files (the
earlier pattern plus quarantin|history): 126 passed, 2 skipped; 1446 tests passed, 0 failed.
`npx tsc --noEmit -p packages/core`: clean. `lake env lean PlurSpec/R2Persist.lean`: clean, 1432
lines, no sorry/admit/axiom/native_decide.

Decision P1 follow-up 2, amended: every attached instance records the rename. With a single
listener slot (`setRenameListener`), the last `Plur` registered on a shared `PostgresAdapter`
silently took over the other instances' history records. That broke "nothing hidden". Now
`storage-postgres.ts` holds a Set of listeners, and `addRenameListener(fn)` returns an unsubscribe
function. `save` calls every listener after the commit. `index.ts`: the constructor subscribes, and
a new `Plur.close()` unsubscribes. `close()` is idempotent and does not close the store, which the
caller owns. A bare adapter with no instance attached has no history root, so the log line is its
only record. This is documented at `addRenameListener`.
- Theorems (`DupIds`): `old_first_instance_misses` (OLD, counterexample: single slot),
  `every_subscriber_records`, `closed_records_nothing` and `two_instances_both_record`. Mutations: a
  single-slot `subscribe` ⇒ `two_instances_both_record` fails; delivering to the head subscriber only
  ⇒ `every_subscriber_records` and `two_instances_both_record` fail.
- Test: `formal-r2-apply-persist-nothing-hidden.test.ts`, case "several Plur instances on one adapter
  all record the rename; a closed one stops". It failed before (`expected [] to have a length of 1`),
  and fails again with a single-slot `addRenameListener`. The existing Postgres case now closes its
  instance.
- Run: the targeted Postgres-backed files (formal-r2-apply-persist*, formal-r2-persist*, postgres*,
  primary-store, storage-adapter*): 22 files, 202 tests passed. `npx tsc --noEmit -p packages/core`:
  clean. `lake env lean PlurSpec/R2Persist.lean`: clean, 1472 lines.

## Merge with #1354 (main, 2026-09-30)

#1354 first reached the double-holder race of item 1 from the empty-lock side with one
`<lock>.takeover` guard, the round-1 single guard this round replaced. Main then adopted this
round's ladder for it (#1424, owner decisions C1 and C2), so this branch takes main's
`takeOver` / `takeOverSync` unchanged, with this branch's heartbeat (decision P1) on top. The
ladder here is keyed by the judged token as modelled; the inode and still-abandoned re-checks under
the slot are main's.
