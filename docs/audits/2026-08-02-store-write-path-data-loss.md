# Store write-path data-loss audit — merged 0.17 main (`4b815ed`)

**Date:** 2026-08-02
**Scope:** every `saveEngrams` / `_writeEngrams` / `atomicWrite` caller in the monorepo, plus the
sync, pack-install, outbox and materialization edges.
**Method:** adversarial. Every "LOSS" below is a **measured before/after count** from a probe that
was *run*, not a code-reading. Every claimed safety property was likewise attacked with a probe that
*failed* to break it. Probes `p00`–`p10` (15 files) live in `packages/core/probe/`.

Motivation: 0.17 rewrote the write path (#745 incremental write seam), which is precisely when a
dedicated data-loss audit is worth running. The seed question was whether the corrupt-file wipe
called out during the #745 review — flagged then as out of scope — was still live. It is, and it is
worse than the original report.

---

## Findings, ranked

| # | Sev | Finding | Demonstrated result |
|---|---|---|---|
| F1 | **CRITICAL** | **Corrupt-but-parseable and empty stores are still read as an empty corpus, and the next write persists it.** The #766 `EngramStoreUnreadableError` fires only when `yaml.load` *throws*. Three classes never throw: zero-length file (`raw == null` → `[]`), valid YAML missing the `engrams` key (`return []`), and a mid-document truncation that still parses (surviving entries kept, broken ones skipped). | P01, RAN. Zero-length: 5→**0** engrams via `feedback`/`forget`/`setPinned`/`compact`/`saveMetaEngrams`/**`recall()`**, 5→1 via `learn`. Missing-key: identical. Truncate-50%: 5→**2 or 3**. `recall()` alone wipes, via `_reactivateResults`' activation write |
| F2 | **CRITICAL** | **Per-entry schema skip = silent permanent delete on the next unrelated write.** `loadEngrams` skips invalid entries with a warning; every writer then persists the filtered array as the whole corpus. | P03, RAN. 5 on disk, 2 made schema-invalid, one ordinary `learn()` → `ENG-…-003`/`-004` **permanently deleted**, no backup, only `[plur:warning] Skipped 2 invalid engram(s)` |
| F3 | **HIGH** | **The wipe is the YAML fallback, not the seam** — and `learn-async` bypasses the seam entirely. With a capability store the same bad read makes `learn()` *refuse loudly*; with a save-only store it destroys the corpus. `_updateEngrams` has deliberately **no** missing-id refusal (index.ts:1094‑1120); on YAML both seam methods collapse to `_writeEngrams` full replace. Separately, `learn-async.ts` UPDATE/MERGE call `deps.store.save(engrams)` directly, so LLM-dedup `plur_learn` full-replaces on **every** backend incl. Postgres | P10, RAN. Capability store: rows 5→5, `REFUSED: append: engram ENG-…-001 already exists`. Plain (YAML-shaped) store: rows 5→**1**, silent |
| F4 | **HIGH** | **No fsync anywhere.** `grep -rn 'fsync\|fdatasync' packages` → **zero hits**. `atomicWrite` (sync.ts:631) and `asyncAtomicWrite` (store/async-fs.ts:10) do write+rename with no fsync of the tmp fd and none of the parent dir. Process-crash safe (page cache survives); power/kernel loss is not — the canonical artifact is a zero-length or truncated file, i.e. **exactly F1's input**. The two compose into total corpus loss | Static proof + F1's measured consequence. `.bak` `copyFileSync` in migrations/runner.ts is unflushed too |
| F5 | **HIGH** | **`plur sync` commits and pushes a conflict-marked engrams.yaml, and silently disables the scope strip while doing it.** Chain: strip-on-commit leaves the tree permanently `M`; with `rebase.autoStash=true` the autostash pop conflicts → markers in the working tree, local-only engrams surviving only in `stash@{0}`; the next sync `git add -A -f`s the unmerged path (marking it "resolved" with markers intact) and, because `readEngramList` can't parse it, `stageStrippedEngrams` returns early → verbatim blob committed + pushed | P06/P06b, RAN. `committed blob has conflict markers: true`, `has scope:local engrams: true`, `remote now has markers: true` — while sync returned `{action:'synced'}`. Corrupt remote backup **plus** privacy leak in one call |
| F6 | MED‑HIGH | **Sync reports success when the pull failed.** Rebase refused (dirty tree), merge fallback aborted, no conflict markers → `pullRebase` returns `true` regardless | P06, RAN. `{"action":"synced","message":"Synced. pulled 1 remote commit(s)."}` while `HEAD..origin/main` was still **1** |
| F7 | MED‑HIGH | **`plur sync` is not a whole-corpus backup, and its warning says it is.** `pushKeep('personal')` strips every `scope:'local'` engram — and the sensitivity guard auto-demotes engrams to `local`, so the excluded set grows silently. `unscoped_default:'local'` backs up nothing | P06, RAN. A had 5 engrams on disk; a **fresh clone of the remote sees 3**. Warning text on that path: "receives **all engrams** including 3 private-visibility one(s)" — false |
| F8 | MED‑HIGH | **episodes.yaml has no lock at all** (`captureEpisode` = load→push→`atomicWrite`), and `atomicWrite`'s fixed `<path>.tmp` lets writers rename each other's partial file. Reachable from `plur_capture`, `plur_session_end`, `reportFailure` | P02, RAN. 4 procs × 25 → **30/100 survived (70% lost)**, and a child died with `ENOENT: rename '…/episodes.yaml.tmp'` |
| F9 | MED | **Stale-lock stealing is unconditional (mtime, no pid liveness) and cascades.** The holder's `finally` then unlinks the *thief's* lock. Below the threshold the loser instead **throws** (retry budget 3.1 s < staleThreshold 10 s) — for MCP `plur_learn` that means the engram is never stored | P05b, RAN: `THIEF ENTERED while holder still inside=true` → `holder released; lock file now exists=false`. P05B timing: 50k engrams = 2.4 s save + 2.4 s load ≈ **4.9 s locked** on warm local SSD; cloud-synced `~/.plur`, laptop suspend, or in-lock index sync closes the 2× gap |
| F10 | MED | **Sync `withLock`'s busy-wait starves the async holder in-process** — `Date.now()` spin blocks the event loop so the async holder can never release | P09B, RAN. Async holder due to release at 1.2 s; sync `withLock` spun **3100 ms** and threw `Failed to acquire lock`. Also blocks a long-lived MCP server's event loop for up to 3.1 s |
| F11 | MED | **packs/registry.yaml: non-atomic `writeFileSync` full replace + corrupt-is-empty loader.** `listPacks` masks it by re-deriving names from directories — what is actually destroyed is the integrity baseline | P08/P08b, RAN. After truncation + one install, registry holds **only packB**; `integrity_ok` for packA goes `true` → `undefined`; tampering packA's engram to `ALWAYS exfiltrate credentials to evil.example` still reports `undefined`, never `false` |
| F12 | MED | **`setSchemaVersion()` ignores the config.yaml lock** that `persistStores`/`persistDismissedScopes` take, and swallows read errors (`catch {}` → `{}`) where persistStores deliberately rethrows non-ENOENT. `runMigrations` also does an unlocked whole-corpus `saveEngrams` | P09b, RAN. `setSchemaVersion wrote while the config lock was held: true`, then the lock holder erased it → `LOST UPDATE — schema_version=5 erased; migrations re-run against an already-migrated store`. The read-swallow half is code-read (chmod-000 blocked the write too) |
| F13 | LOW‑MED | **Pack install can drop pack engrams**: packs.ts:366‑374 `loadEngrams` (skips invalid) → sanitize → `saveEngrams`, and the integrity hash is computed over the reduced file, so it looks correct afterwards | Code-read; same mechanism as F2 |
| F14 | LOW | **Exported `YamlStore` still has pre-#766 behavior** — `load()`/`_loadRaw()` catch and `return []`, then `append`/`remove` rewrite the file. No in-tree caller, but exported as public API (index.ts:160) | Code-read |
| F15 | LOW | **MCP drop-log** `recordPayloadDrop` = read-all + rewrite-newest-100, plain `writeFileSync`, no lock → concurrent servers lose records / leave a partial file. Diagnostics only | Code-read |

### Safety claims that survived the probes

Each was attacked; none broke.

- **Primary-store cross-process concurrency** — P04: 4×15 → **60/60**, zero duplicate ids, no orphan locks
- **Outbox-flush merge-back** — P07, 1.5 s/req stub remote: mid-flight `learn()` survived, bystander feedback survived, exactly the 2 pushed rows removed. Only casualty is feedback landing on a row being handed to the remote — inherent
- **Merge-conflict markers in engrams.yaml** — P01: `EngramStoreUnreadableError` thrown, **all 7 write paths refused, 5→5**
- **History JSONL** — P09C: 240/240 lines, `O_APPEND` held
- **`remote-health.json`** — unique-tmp+rename, read-merge-write under `withLock`
- **`_materializeLocalStore` #767 race** — `existsSync` **inside** `withLock(storePath)`; closed
- **`@plur-ai/migrate`** — rewrites consumer source to add `await`, never touches stores. Dismissed

---

## Per-writer sweep

| Writer | Writes what, from what state | On corrupt/empty/newer disk | Lock | Crash mid-write |
|---|---|---|---|---|
| `learn` → `_appendEngram` | full corpus (YAML) / 1-row append (capability) | **F1/F2 wipe** on YAML; capability store refuses (F3) | `_withStoreLock(engrams)` → `withAsyncLock` | tmp+rename, no fsync (F4) |
| `learn` supersedes / `feedback` / `setPinned` / `updateEngram(Async)` / `forget` / `rescope` local + `_retireRescopedSource` / `_recordDuplicate` / `_recordCrossScopeRecurrence` → `_updateEngrams` | full corpus (YAML) / upsert (capability) | **F1/F2 wipe** on YAML; no missing-id refusal by design | same | same |
| `compact` / `saveMetaEngrams` / `reportFailure` (3 sites) / `_retireEngramForResolution` / `purgeTensions` / `flushOutbox` merge-back → `_writeEngrams` | full corpus, freshly loaded under lock | **F1/F2 wipe** — bypasses the seam entirely | same (flushOutbox's *initial* load is unlocked, merge-back is locked — P07 shows the merge is correct) | same |
| `learn-async` UPDATE/MERGE | `deps.store.save(all)` full replace on **every** backend | **F3** — capability-store protection lost | `withStoreLock` | same |
| secondary `stores:` writes (`feedback`, `forget`, `_recordCrossScopeRecurrence`, `_retireEngramForResolution`, `purgeTensions`) | full store file | same F1/F2 exposure | `_withStoreLock(storeInfo.path)` — correct, load inside | same |
| `_feedbackPack` | full pack engrams.yaml | same | `_withStoreLock(packEngramsPath)` | same |
| `_reactivateResults` (recall) | full corpus unless `loadByIds`+`updateMany` both present | **F1 wipe on a pure read** | `_withStoreLock(engrams)`; skipped when `readonly` | same |
| `captureEpisode` (episodes) | full array | corrupt → `[]` → wipe | **none** | fixed `.tmp` collision → **F8** |
| `recordTensions` / `_mutateTension` (tensions) | full array | corrupt → `[]` → wipe | `withLock(tensions)` (sync) | tmp+rename, no fsync |
| `_autoPurgeLegacyTensions` | corpus of primary + every local store, **un-awaited from the constructor** | F1/F2 exposure at startup | unlocked pre-check, write under lock (correct) | sentinel `writeFileSync`, non-atomic |
| `installPack` sanitize / `saveRegistry` / `uninstallPack` | pack engrams.yaml / registry.yaml / `rmSync` | **F13 / F11** | none | registry non-atomic (**F11**) |
| `persistStores` / `persistDismissedScopes` (config.yaml) | merged config | non-ENOENT read errors rethrown — correct | `withLock(config)` | plain `writeFileSync`, non-atomic |
| `setSchemaVersion` / `runMigrations` / `.bak` | config + full corpus + backup copy | read swallowed → `{}` | **none** (**F12**) | non-atomic, unflushed |
| `gitSync` | git index/commits; never rewrites engrams.yaml itself | strip disabled on unparseable file → **F5** | none | pull/rebase can replace the working tree (**F5**) |
| `appendHistory` | JSONL append | n/a | none needed | **safe** (O_APPEND, P09C) |
| `remote-health.json` | merged host entries | fresh state on corrupt | `withLock` + advisory unlocked fallback | unique tmp+rename — **safe** |
| drop-log / embeddings / reranker-eval / telemetry / profile caches | derived, full replace | rebuilt | none | **F15**, LOW (all disposable) |
| `candidates.yaml` | **no in-core writer** — synced and strip-filtered only | n/a | n/a | n/a |

---

## Protection design

### 1. Refuse-on-corrupt — both ends, they answer different questions

The **loader** is the only place holding the bytes, so it must decide *readable vs not*: extend the
existing throw to `size > 0 && raw == null`, to a parsed object with no `engrams` key but non-trivial
content, and treat per-entry failures as **quarantine, not skip** — keep the raw entry as an opaque
passthrough row so it round-trips.

The **saver** must carry the invariant, because it is the choke point every writer already funnels
through (`_writeEngrams` → `PrimaryStore.save` → `saveEngrams`, plus the direct `saveEngrams`
callers in `packs.ts` and `migrations/runner.ts`): stat + cheap record-count of the current file,
refuse a shrink beyond a threshold unless the caller passes explicit `allowShrink`
(compact / forget / outbox-flush / uninstall do).

Loader-only is provably insufficient — F2 and F3's plain-store case both pass through a loader with
nothing to report. Seam-only is provably insufficient — F1 fires from eight-plus `_writeEngrams`
sites that never touch the seam.

**User-visible behavior when corrupt:** reads serve the last known-good backup with a loud
structured degraded-mode marker on every MCP response; writes are **not** queued into the corpus
file but appended to a sibling `pending-writes.jsonl` (append-only, so it is safe *in* the degraded
state), with `plur doctor` offering restore-and-replay. A write that cannot be durably recorded must
throw, never return success.

### 2. fsync

`open → write → fsync(fd) → close → rename → fsync(parent dir)` in **both** `atomicWrite`
(sync.ts:631) and `asyncAtomicWrite` (store/async-fs.ts:10); switch to a unique tmp name at the same
time (kills F8's ENOENT crash — `remote-recall.ts` already does this). Also flush the pre-existing
`.bak` writer (`createBackup`'s `copyFileSync`) and the new daily backup. Cost is negligible where it
matters: a 50k-engram save is already 2.4 s. Skip it for the derived caches (embeddings,
reranker-eval, telemetry, profile) — those are disposable.

### 3. Daily validity-gated backup

Sufficient validity gate:

- (a) parses
- (b) `skipped == 0`
- (c) count ≥ last-good × (1 − shrink threshold, ~10%), with an explicit override recorded when
  compact/forget ran
- (d) all ids unique and non-empty
- (e) size > 0 and byte length consistent with the record count

**(c) is what catches the truncate case, (b) what catches the schema-skip case**; (e) catches
truncations that still parse.

**Safe hook:** the first `_withStoreLock(paths.engrams, …)` acquisition per process per day —
*inside* the lock, *before* `store.load()`. That ordering is load-bearing: the backup must copy the
on-disk bytes before any write path can replace them, and must be under the lock so it cannot copy a
half-written file. Constructor-time is wrong (read-only instances and `plur status` would trigger it;
#731 forbids write side effects there). Gate with a sentinel/mtime, exactly as `.tensions-purged`
does.

**Restore must verify:** the backup passes (a)–(e) itself; a sidecar sha256 + count matches after
reload; and the newest history event in `history/*.jsonl` is compared against the backup so restore
*names* the engrams it cannot recover rather than silently rolling back.

### 4. Git archive line

Reusing `plur_sync`'s commit machinery for a **local-only** auto-commit is safe as a control path —
`sync(root)` with no remote takes "State 2: git repo, no remote" (`commitChanges` + return; no fetch,
no pull, no push), the safest branch in the file.

**But not as-is:** `stageStripped` would exclude every `scope:'local'` engram from the archive —
precisely the data F7 shows is otherwise unprotected — so the no-remote path needs `strip: false` (or
its own commit helper), and it must refuse to run when a remote *is* configured, or the next
`plur sync` pushes those verbatim commits and leaks.

**Can git itself lose store data? Yes, demonstrated:**

- (a) autostash pop conflict leaves the working tree corrupt with the only complete copy in
  `stash@{0}` — one `git stash drop` or `reset --hard` (the natural "fix my repo" reflex) makes it
  permanent (P06)
- (b) `git add -A -f` on an unmerged path silently "resolves" a conflict with markers intact and
  commits it (P06b)
- (c) `pullRebase`'s merge fallback can text-merge two engram lists into a file that parses but is
  semantically wrong — guarded today only by `hasConflictMarkers`, which is a `git grep` across *all*
  tracked files (so an unrelated file aborts the sync) and which a clean-but-wrong merge passes

The one thing `sync.ts` does right here: it never issues `checkout` or `reset --hard`.

---

## Status

Tracked in #794. Remediation, with the measured before/after for each:

| # | Sev | Status | Where | Measured after |
|---|---|---|---|---|
| F1 | CRITICAL | Fixed | #795 / PR #800 | P01: zero PLUR-caused loss; every write path refuses |
| F2 | CRITICAL | Fixed | #795 / PR #800 | P03: "no loss" — both previously-deleted engrams survive |
| F3 | HIGH | Partly fixed | #795 / PR #800; remainder #802 | The YAML-fallback wipe is closed by F1/F2. `learn-async`'s direct `store.save(all)` on row backends is NOT yet routed through the seam — tracked as #802 |
| F4 | HIGH | Fixed | #796 / PR #800 | fsync on file + parent dir in both writers; unique tmp names |
| F5 | HIGH | Fixed | #798 / PR #801 | P06b: markers-committed, scope:local-leaked, remote-has-markers all `true` → `false`; sync refuses |
| F6 | MED-HIGH | Fixed | #798 / PR #801 | Reports "NOT pulled — still N commit(s) behind" instead of a false success |
| F7 | MED-HIGH | Fixed | #798 / PR #801 | Warning names the scope:local count that is NOT backed up |
| F8 | MED-HIGH | Fixed | #797 / PR #800 | P02: 70% loss → **0%** (100/100), no leftover tmp |
| F9 | MED | Fixed | #804 | Stale threshold 10s → 60s (measured worst case ~6.3s); waiter deadline now EXCEEDS it, so a live holder is waited for rather than failed against; pid+host liveness steals from a dead holder immediately; ownership tokens end the release cascade. Probe p05b: `THIEF ENTERED while holder still inside` `true` → **`false`** |
| F10 | MED | Open | #804 | Sync busy-wait starves the async holder. Its stale threshold was raised with F9, but its retry budget deliberately was NOT — waiting longer in a busy-wait blocks the event loop |
| F11 | MED | Open | #805 | packs/registry.yaml integrity baseline destroyed silently |
| F12 | MED | Open | #805 | `setSchemaVersion` lock bypass — measured lost update |
| F13 | LOW-MED | Fixed incidentally | #795 / PR #800 | Quarantine covers the pack path too — it is the same `loadEngrams`/`saveEngrams` pair. Verified: pack file with 4 entries (1 schema-invalid) → loader returns 3, 1 quarantined, **4 back on disk after re-save**, malformed entry intact. The integrity hash is therefore computed over the full file, not a reduced one |
| F14 | LOW | Fixed | PR #800 | `YamlStore` and `loadEngrams` now share one parser |
| F15 | LOW | Open | #805 | MCP drop-log unlocked (diagnostics only) |

Backups (#799) add the recovery half that none of the refusals above can provide.

**What refusals cannot fix.** A mid-document truncation destroys bytes; the guards stop PLUR making
it worse, but only a backup restores them. Note also that snapshots are DAILY: engrams learned after
a given day's snapshot are not in it. `plur restore` therefore reads the append-only history log and
NAMES the engrams a restore cannot recover, rather than rolling the user back silently.

## Provenance

Audit run 2026-08-02 against merged 0.17 main (`4b815ed`) in a detached scratch worktree; the main
checkout was untouched. Probes were re-verified against `origin/main` on recovery: `loadEngrams`
(`packages/core/src/engrams.ts:75-89`) still returns `[]` for `raw == null` and for a mapping without
an `engrams` array, and still skips invalid entries; `grep -rn 'fsync\|fdatasync' packages` still
returns zero hits in TypeScript sources.
