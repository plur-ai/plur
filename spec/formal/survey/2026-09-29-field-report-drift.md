# Field report × formal models — drift and conflict report (2026-09-29)

Branch `formal/field-report-2026-09-29` =
`integration/field-report-2026-09-29` @ `baf6df61` (the 15 field-report PRs;
merge notes in `docs/audits/2026-09-29-integration-notes.md`) merged
`--no-ff` with #1228 `verify/formal-lean` @ `420f4f25`. No PR branch was
touched. This is a workspace for auditing the two bodies of work together,
not a candidate for main.

## Refresh 3 (2026-09-29, final pass)

Merged `--no-ff`: `integration/field-report-2026-09-29` @ `8f1cdafd` (heads
and resolutions in `docs/audits/2026-09-29-integration-notes.md`, "Refresh
3"). `origin/verify/formal-lean` @ `420f4f25` and #1401 @ `83d3ffdf` were
already contained. The C3/F1 commit `5d370bb5` is kept.

### Resolutions on this branch

- **Outbox claims (#1277 C3/C4 vs this branch's C3):** #1277's claim code
  replaces this branch's (atomic takeover with a stale-content re-check and a
  read-back, live same-host owners, no orphan/in-doubt, no probe, no
  `--resend`, key persisted before the first POST, claims released however
  a flush ends). #1228's flush structure (D1 retire queue, `routeFor`, the
  lease-free selection from C3) is kept around it. Kept from this branch:
  per-instance claim tokens so only the taker releases a claim, and the
  advisory `listOutbox().leased_until` derived from the claim file alone.
- **`async-lock.ts` (#1424 vs this branch):** #1424 ports this branch's
  lock + ladder composition and adds C2; its text is taken, with the P1
  heartbeat import (`utimesSync`) from #1228.
- **Loader/recall stamps (#1228 `stampStoreRow` × #1273
  `_fromRemoteStore`):** both.
- **importer `engine.ts`:** this branch's `wouldDeduplicate`-based dry run
  (F1 applied in core); #1275's scope-keyed map is not needed here.
- **stub server:** this branch's (keeps the `ignoreIdempotencyKeys` knob the
  conflict-I replays use).
- **Claude/Codex/Cursor/Antigravity hooks (#1228 E3 × #1418 folder map):**
  #1418's folder gate and `sessionSettings` are taken; #1228's
  `trustedProjectScope` notices are removed. Session-state paths are nullable
  everywhere (H3, #1395), the O_EXCL inject lock and marker handling from
  #1228 stay. `hook-learn-check`: #1395's dir rule under #1228's
  `checkpointRoot(flags)` (cli#6). **OPEN CONFLICT J** below.
- **`init-remote.ts`:** #1415 turned it into an alias of `plur remote`; its
  file is taken, so #1228's Adapters #8b fixes to the old rewrite are gone.

### OPEN CONFLICT J — the E3 notice vs the folder map (#1228 × #1418)

Round-1 decision D1 said #1228's E3 code stays and #1348 regenerates its
goldens for the notice. #1418 instead drops untrusted hints through the
folder policy and asks once; it prints no "Ignored the scope … run `plur
trust`" notice, and #1415 hides `plur trust`. Failing here:
`formal-apply-surface-trust` (4), `formal-gaps-codex-session-start` (1),
`formal-audit-1228c` (3). Not decided: either #1418 keeps the E3 notice
(pointing at `plur folders set --trusted`), or #1228 retires those tests in
favour of the ask flow.

### Formal check

`lake build` ok (16 jobs); `formal_check.py --base origin/verify/formal-lean`:
build ok, no gaps, 3272 theorems, none using axioms outside propext /
Classical.choice / Quot.sound, **no drift** against that base. The pre-push
formal gate (range of this push) reports 10 models that may be stale, each
because code it models changed in refresh 3 while the model did not:
WritePath, Persistence, Adapters (twice: hooks/init/init-remote, and the hook
matcher), R2CoreA, R2CoreB, R2Persist, R2CLI, Folders, Outbox. None was
remodelled in this pass.

### Suites (one at a time; load average about 50)

| Suite | Result | Failures, rerun alone |
|---|---|---|
| core | 4477 passed, 6 failed, 4 expected fail, 46 skipped | `formal-fr-c3` thrown_merge_new_key and 3 `secrets` linear-time tests pass alone; `formal-r2-apply-core-always-store` "good case" and `formal-writepath-tension` "missing tensions.yaml" fail again (A1/A3 fixtures predate the ladder) |
| core-pglite | 115 passed, 121 skipped | — |
| mcp | 608 passed | — |
| cli | 1313 passed, 14 failed, 2 expected fail | all 14 fail again alone: conflict J (8), `formal-adapters-init-remote` (4, code removed by #1415), `hook-force-exit-lock` and `init-windows-h3` (as in refresh 2) |
| cli-spawn | 82 passed | — |
| migrate | 105 passed, 1 failed | `method-list` NEWLY_ASYNC: `verifyRemoteStore` (#1415) unaccounted for; fails again alone |

## Refresh 2 (2026-09-29, quiet machine)

Merged `--no-ff`: `integration/field-report-2026-09-29` @ `d159c6dd` (refresh 2,
heads in `docs/audits/2026-09-29-integration-notes.md`), `origin/verify/formal-lean`
@ `420f4f25` (already contained), #1401 `fix/h1-session-key-1228` @ `83d3ffdf`.

### Refresh 2 resolutions

- **core `store/async-lock.ts` + `sync.ts` (#1228 × #1398)** — code change. #1398's
  file is the base: complete-on-publish locks (`publishLockFile`, hard link),
  `EMPTY_LOCK_GRACE_MS`, inode-checked steal with link restore, `takeOver` /
  `takeOverSync` shared by both locks. #1228's heartbeat (decision P1) is added
  back verbatim, and #1228's steal-guard LADDER (persistence candidate 3,
  r2-persist item 1, `R2Persist.lean ladder_mutex`) replaces #1398's single
  `.takeover` guard inside `takeOver`: slot keyed by the judged token,
  re-inspect (token AND inode) under the slot, claim, clear the ladder. sync.ts
  takes #1398's `withLock` (publish, `abandonedByAge`, `takeOverSync`) with #1228's
  heartbeat; its private steal/ladder helpers move into async-lock.ts.
  **OPEN CONFLICT G** — two designs for the same takeover race: #1398's single
  guard is removed by a read-then-steal of an abandoned guard, the double fault
  #1228's ladder closes; the composition here is untested against #1398's
  concurrency proofs and unmodelled (Persistence, R2Persist drift). Needs a
  decision on which PR carries it (a PR against #1398 porting the ladder is the
  natural home).
- **core `index.ts` `flushOutbox` (#1228 × #1277's 2026-09-29 audit rework)** —
  code change. #1228's lease skeleton (D1/D2) with #1277's per-entry claims,
  random persisted idempotency key, lookup by key for in-doubt entries, `resend`,
  `unconfirmed` (+ `OUTBOX_INCONCLUSIVE_LIMIT`), `RemoteTimeoutError` as in doubt
  (and a host failure). learn()'s immediate push carries both the D2 lease and
  the claim + key. A thrown flush now also releases the claims of entries whose
  POST never landed (commit `c329872d`), or #1228's finding-4 test fails.
  **OPEN CONFLICT I** — two mechanisms for one property (no duplicate push):
  #1228's row leases, taken under the store lock, and #1277's claims, taken
  without it. They coexist here, but #1277's `hook-outbox-flush.test.ts` › "a hook
  abandoned after its POST landed…" fails: it holds the store lock and expects
  the POST to land first; with the lease the flush waits for the lock before
  posting, so nothing is posted (no duplicate either way). Needs an owner call on
  whether both stay.
- **cli `hook-inject.ts` (#1228 × #1395 × #1353 × #1349 × warmup)**: #1395's
  `hookSessionDir` (0700 dir, falls back to a private dir) replaces #1228's
  null-returning vetted dir — **OPEN CONFLICT H** (degrade to no persistence vs
  fall back to a private dir; both refuse a planted marker). #1228's O_EXCL
  `takeInjectLock` stays; #1353's attempt cap and watchdog release use its
  ownership-checked hold. #1395's `session-task.js` replaces `sessionTaskPath`.
- **cli `init.ts` / `doctor.ts` (#1228 × #1270 H2/H3)**: #1270's `isPlurHookSpec`
  (exec form, any `hook-*`) with #1228's null guard (`isPlurClaudeHookSpec`).
- **core recurrence (#1228 × #1275 A1–A3)**: A1 makes every shared-save hit
  credit-only; `_teamValidationMatch` (remote route) now credits any-scope hits;
  `_crossScopeMatch` keeps the shared-hit preference.
- **stub-server**: #1277's idempotency replay, key list and `ignoreIdempotencyKeys`
  inside #1228's `appendHook` wrapper; #1318's `getByIdCalls` / `feedbackDelayMs`.
- **#1401**: the formal branch already had H1; its reader/writer edits resolved to
  the existing code, its tests and the r2-cli note kept.

### Formal check (refresh 2)

`lake build` → Build completed successfully (14 jobs).
`formal_check.py --base origin/verify/formal-lean` → build ok, no gaps, 2236 theorems,
0 using axioms outside `propext`/`Classical.choice`/`Quot.sound`; drift: 8 models —
WritePath (core `index.ts`, `store/remote-store.ts`), **Persistence** (`sync.ts`,
`store/async-lock.ts`), Adapters (cli `hook-agy-pre-invocation`,
`hook-cursor-session-start`, `hook-codex-inject`, `hook-inject`, `learn`, `doctor`,
`init`, `cursor-hooks`, `mcp-config`; mcp `tools.ts`), R2CoreA (core `index.ts`),
R2CoreB (`store/remote-store.ts`), **R2Persist** (`store/async-lock.ts`, `sync.ts`),
R2CLI (cli `lib/codex-hook-io.ts`, `hook-inject`, `hook-learn-check`,
`hook-session-end`, `hook-agy-pre-invocation`, `doctor`), R2Integrations (mcp
`tools.ts`).

### Suites (refresh 2; sequential, default timeouts, load ~15–45)

| Suite | First run | Rerun of failures alone |
|---|---|---|
| core | 309/317 files, 4404 passed, 3 failed, 1 expected fail, 46 skipped | 3/3 failed again → fixed the lease/claim one (`c329872d`); full rerun 310/317, 4405 passed, 2 failed |
| core-pglite | 11 passed, 10 skipped; 115 passed | — |
| mcp | 54/54, 608 passed | — |
| cli | 112/115, 1203 passed, 3 failed, 4 skipped | 3/3 failed again |
| cli-spawn | 11/12, 81 passed, 1 failed | failed again (18 passed, 1 failed) |
| migrate | 6/6, 106 passed | — |

Remaining failures, all deterministic, none caused by load:
- core `formal-r2-apply-core-always-store` › "good case … cross-scope #176" — A1
  changes what it pins (carry: #1228).
- core `formal-writepath-tension` › "a missing tensions.yaml … may lock" — A3
  default holds, but the A1 team copies change which engram the fourth save
  matches (carry: #1228 fixture, or #1275).
- cli `hook-force-exit-lock` › "hook-inject, when its watchdog fires mid-write" —
  #1349's slow-lock preload patches `writeFile(O_EXCL)`, which #1398's
  `publishLockFile` (hard link) no longer calls, so no delay happens and the hook
  finishes before its watchdog (carry: whichever of #1349 and #1398 lands second;
  not verified on the integration branch).
- cli `init-windows-h3` › "a spaced home without short names" — #1318's
  `hook-auto-rate` hooks break its per-editor prefix check (carry: #1270/#1318).
- cli `plur-yaml-fixture` › "an untrusted remote .plur.yaml" — D1 golden vs #1228's
  E3 notice line (carry: whichever of #1403 and #1228 lands second).
- cli-spawn `hook-outbox-flush` › "a hook abandoned after its POST landed…" —
  OPEN CONFLICT I.

## Formal check

`cd spec/formal && lake build` → **Build completed successfully (14 jobs)**.

`python3 spec/formal/formal_check.py --project spec/formal --base origin/verify/formal-lean`:

| Check | Result |
|---|---|
| build | ok |
| gaps | none |
| axioms | 2236 theorems, 0 using axioms outside `propext`, `Classical.choice`, `Quot.sound` |
| drift | 6 models may be stale (below) |

### Drift: models whose covered code the field-report work changed

| Model | Changed files it covers (vs `origin/verify/formal-lean`) | Field-report PRs behind the change |
|---|---|---|
| `PlurSpec/WritePath.lean` | core `index.ts`, `store/remote-store.ts` | #1264 learn delivery, #1265 addRemoteStore, #1268/#1275 recurrence, #1269/#1277 flush budget + in-doubt + Idempotency-Key, #1299/#1307 needs_action/held/force, #1308/#1309 4xx breaker, #1310/#1318 auto feedback source, #1319/#1334 duplicate stores |
| `PlurSpec/Adapters.lean` | cli `hook-agy-pre-invocation.ts`, `hook-cursor-session-start.ts`, `hook-codex-inject.ts`, `hook-inject.ts`, `learn.ts`, `doctor.ts`, `init.ts`, `cursor-hooks.ts`, `mcp-config.ts`; mcp `tools.ts` | #1264, #1267/#1270 Windows init + hook matcher, #1274/#1276 inject delivery, #1310/#1318 auto-rate, #1311/#1315 opencode, #1312/#1342 correction, #1313/#1341 sync inject |
| `PlurSpec/R2CoreA.lean` | core `index.ts` | as WritePath (learn/learnRouted recurrence, listOutbox, flush) |
| `PlurSpec/R2CoreB.lean` | core `store/remote-store.ts` | #1269 AbortSignal + findByStatement + Idempotency-Key, #1299 RemoteHttpError status, #1310 feedback source capability |
| `PlurSpec/R2CLI.lean` | cli `hook-inject.ts`, `hook-learn-check.ts`, `hook-session-end.ts`, `hook-agy-pre-invocation.ts`, `doctor.ts` | #1276/#1301 session key + marker-after-output, #1277/#1314 session-end flush + checkpoint key, #1313/#1341 bounded inject + abandoned-hybrid wait, #1318 recordInjected |
| `PlurSpec/R2Integrations.lean` | mcp `tools.ts` | #1264 delivery fields, #1299 outbox states, #1278 checkpoint keys |

Most relevant to re-proving: WritePath/R2CoreA for the outbox flush, which now
combines #1228's leases (D1/D2) with #1269's budget and in-doubt probe and
#1299's `held` back-off (see conflict 9 below); R2CLI for the inject session
key (open conflict E).

## Merge conflicts and resolutions (#1228 into the integration)

1. **CHANGELOG.md** — both sides' Unreleased entries kept, field-report first.
2. **cli `doctor.ts` `hasAnyPlurHook`** — kept #1270's `isPlurHookCommand`
   (normalises backslashes and case, whole-path shim + known subcommand),
   which covers #1228 S4's backslash fix; added #1228's guard that a
   non-string `command` never matches and never throws.
3. **cli `hook-codex-session-end.ts`** — #1277 removed the early return so the
   outbox flush runs without a session id; #1228 added "never unlink through
   an unsafe session dir" (cli#8). Both: unlink only when `sessionId` and
   `sessionDirSafeToSweep(sessionDir())`; the flush always runs.
4. **cli `hook-learn-check.ts`** — #1301's payload-first `key` threaded
   through, plus #1228's vetted `ensureSessionDir` for the counter and
   `--path`-honouring `checkpointDir(flags)`: `writeCheckpoint(key, count, cwd, flags)`.
5. **cli `init.ts` hook matcher** — `isPlurHookSpec` keeps #1228's shape
   (non-string guard, exported for its tests) around #1270's
   `isPlurHookCommand`. Per-spec stripping (both sides did the same thing)
   kept. See OPEN CONFLICT F.
6. **cli `hook-inject.ts`** (15 blocks) — ported #1228 cli#7/cli#8/cli#6 onto
   the field-report file: vetted `sessionDir()` → `string | null` and
   `statePath`; O_EXCL `takeInjectLock`/`releaseInjectLock` with ownership
   check replaces #1278's stat-then-write lock (same try/finally release);
   reminder path trust-gated (E3); `processDeferredWrapups(plur, checkpointRoot(flags))`
   capture-before-unlink; marker/task/reminder writes `0o600` and skipped
   when no vetted dir; stale-marker sweep. Kept #1276's marker-written-after-
   output, #1274 task file, #1313 bounded injection + abandoned-hybrid wait,
   #1318 `recordInjected`, #1342 correction reminder. Session key: OPEN
   CONFLICT E.
7. **core `index.ts` exports** — `AddRemoteStoreError`, `LearnDelivery` and
   #1228's `rrfScoreOf` all kept.
8. **core `index.ts` recurrence** — ladder widening uses #1275's
   `_isTeamStoreBound` (a superset of #1228 D3 "no-widen when `_outbox`").
   `learn()`: #1228's Decision-A `_crossScopeMatch` (persistable hit vs
   foreign, history note) now also carries #1275's "prefer a shared hit for a
   shared write"; a non-shared hit is credited and the team copy written
   (#1275). `learnRouted()` (remote write): #1228 keeps cross-scope
   recurrence off; a new `_teamValidationMatch` still credits a same-text
   NON-shared engram (#1275, never absorbs). OPEN CONFLICTS A–C.
9. **core `index.ts` `flushOutbox`** — #1228's lease skeleton
   (`_flushOutboxClaimed`, D1 retire queue, D2 leases, `routeFor`) with the
   field-report features threaded in: `flushOutbox({ timeoutMs, force })`,
   budget clock started after the leased load (#1277 review), `deferred` on
   an exhausted budget (push and retire loops), in-doubt probe before re-POST
   and `{ signal }` on the POST (#1269), a cut push recorded in doubt and not
   `settled` and not fed to the breaker, `last_status` recorded/cleared and
   4xx refusals not fed to the breaker (#1299/#1308), `held` needs_action
   entries neither dialled nor leased unless `force` (#1299). Result shape
   `{ flushed, failed, deferred, held, skipped, expired_warnings }`.
   Immediate-push failure keeps #1299's `last_status` and #1228's lease drop.
10. **core `index.ts` feedback id-collision guard** — #1228's `_remoteCacheAnswer`
    peek, then #1318's "auto feedback does not dial on a cold cache".
11. **core `index.ts` `listOutbox`** — #1228's `toEntry` for `push` and
    `retire` rows + `leased_until`, with #1299's `state`/`reason`/`next_step`/
    `next_retry_at` computed per entry.
12. **core test `stub-server.ts`** — one `appendCalls` (both sides added it);
    #1307 per-scope refusals, #1277 Idempotency-Key and delayed/dropped
    answers, #1318 `feedbackBodies`/`meCalls`, #1228 `deleteCalls` and
    `appendHook`, all in one POST handler.
13. **mcp `tools.ts`** — import union (#1228 dropped `readProjectConfig`);
    `plur_learn` returns #1228's `learnDecision` (`ADD` or `NOOP` +
    `existing_id`) and #1264's `delivery`/`delivery_warning`.

Test fixtures updated on this branch only because the PRs meet:
`init-windows-1267` snapshot (#1228 widened the session-mark matcher to
`mcp__.*__plur_session_start`), and #1228's `formal-r2-cli-*` tests read
`hookSpecificOutput.additionalContext` (#1276's envelope).

## OPEN CONFLICTS — as found (decided: see "Owner decisions" below)

| | Field-report side (decision cited) | #1228 side (decision cited) | On this branch | Failing test |
|---|---|---|---|---|
| **A** | #1275: a shared save matching another *shared* engram absorbs into it (shared↔shared recurrence), in `learn()` **and** `learnRouted()` alike (#1268 review finding 1). | R2-CoreA / round-2 principle "your writes": an explicit write to a team store must reach it — cross-scope recurrence never applies to a remote write scope. | #1228 (no absorb on the remote route); non-shared hits still credited. | `cross-scope-recurrence-review.test.ts` › "1: learn() and learnRouted() agree…" |
| **B** | #1275 + owner decision 4 and the second round ("what is in a team store stays there; global duplicates may be created"): a recurrence that would promote a team-bound (queued/served) engram leaves it **untouched** and credits a global copy. | D3 `no-widen`: the queued row keeps its scope **and records the recurrence on itself**. | #1275 (copy-on-promote). Neither side widens. | `formal-apply-core-queued-scope.test.ts` › "D3: a second cross-scope hit records the recurrence…" (count 1, expects 2) |
| **C** | #1275 / owner decision 4: a shared-scope save matching a non-shared engram (including one the ladder already promoted to `global`) is a team *validation* — it escalates commitment **never to `locked`**. | WritePath candidate 5 fixture: project:a→b→c→d reaches `locked` when no tension exists. | #1275. The #1228 test is about the tension gate; its fixture relies on the pre-#1275 ladder. | `formal-writepath-tension.test.ts` › "a missing tensions.yaml still means no tension (the engram may lock)" |
| **D** | #1348 folder map r2 (owner-approved 2026-09-29): an existing `.plur.yaml` behaves as on main — its scope/domain *hint* applies untrusted; only its remote needs trust (`resolveFolderPolicy` rule 2). Goldens pin this. | E3 `opencode` (principle "egress: untrusted repo settings are ignored"): scope/domain from an untrusted `.plur.yaml` are ignored, with a notice. | #1228 (E3 gate is in `hook-inject.ts`). | `plur-yaml-fixture.test.ts` › "a scope/domain .plur.yaml…" and "an untrusted remote .plur.yaml…" |
| **E** | #1301 (#1278): the Claude Code session key is `safeSessionKey(payload session_id → CLAUDE_SESSION_ID → ppid)`, used for the inject marker, reminder, lock **and** the Stop-hook checkpoint, so `hook-session-end` finds it. | cli#7: inject key `sid-<safeSessionKey(session_id)>` or ppid (no env); cli#6 checkpoint keyed env-first. | #1301 scheme everywhere; #1228's `injectSessionKey` kept exported (its unit tests) but unused by the hook. | `formal-r2-cli-checkpoint.test.ts` › "the checkpoint writer honours --path…" (expects `path-sess.checkpoint.json`, gets the payload-keyed `p.checkpoint.json` in the right `--path` dir) |
| **F** | #1270 (#1267): a PLUR hook is the shim as a whole path segment or the npx fallback plus a **listed** subcommand; `plur-hook-backup.ps1` is the user's. | S4 / formal Adapters #3: PLUR binary substring plus **any** `hook-*` subcommand. | #1270's matcher with #1228's non-string guard. No test fails; a future `hook-*` subcommand must be added to the list (as `hook-auto-rate` was). | — |

## Owner decisions on the open conflicts (2026-09-29)

Source: `docs/audits/2026-09-29-formal-decisions.yaml` (branch
`docs/field-report-triage`). These are decided; the models are updated only
after the PRs below land them and this branch is refreshed.

| Conflict | Decision | What it means | Carried by |
|---|---|---|---|
| **A** | **A1 = never** | A team save is never absorbed into an engram in another team scope; it is written to its own scope (and its store), and the matching engram is credited as a recurrence. #1228's rule on the remote route stands; #1275's shared↔shared absorb goes. | **#1275** (drop the absorb in `learn()`/`learnRouted()`, update `cross-scope-recurrence-review` finding 1). The credit-only `_teamValidationMatch` added on this branch belongs in #1275 too. |
| **B** | **A2 = both** | A team engram still queued for its store records the recurrence on its own row (#1228 D3) **and** the promotion goes to a linked global copy (#1275 copy-on-promote). | **#1275** (`_promoteTeamCopy` also bumps the queued row's `recurrence_count`); #1228's D3 test then holds unchanged. |
| **C** | **A3 = allow, as a policy setting, default `locked` allowed** | Whether team validation may escalate to `locked` becomes a setting; by default it may, so #1228's tension lock-gate expectation holds by default. | **#1275** (the setting and its default; its own ladder tests pin the capped variant under the non-default value). |
| **D** | **D1 = ignore-ask** | A scope/domain hint in an untrusted `.plur.yaml` is ignored (#1228 E3) until the folder is trusted; the folder map asks once (Q-A), and yes trusts it. | **#1348** (regenerate the `plur-yaml` goldens for the E3 notice; wire Q-A); #1228's E3 code stays. |
| **E** | **H1 = payload** | One shared helper keys all Claude Code hook state: payload `session_id` → `CLAUDE_SESSION_ID` → ppid; readers also try the legacy forms. | **Applied on this branch** (below). Carry: **#1276** (holds #1301's key) takes `hookSessionKey`/`legacyHookSessionKeys` in `lib/session-key.ts` and hook-inject's marker reader; **#1277** (holds #1314) takes the hook-session-end reader; **#1228** switches its hook-inject and hook-learn-check writers to the helper (its `injectSessionKey` becomes a legacy reader form) and takes the updated `formal-r2-cli-checkpoint` expectation. |
| **F** | **H2 = prefix** | Init recognises any `hook-*` subcommand behind PLUR's own launcher (the `plur-hook` shim as a whole path segment, or the `@plur-ai/cli` npx command); no allow-list. User hooks such as `plur-hook-backup.ps1` stay untouched. | **#1270** (`lib/hook-command.ts`), **#1300** (its mcp copy); the `hook-auto-rate` allow-list entries added during integration become unnecessary. |
| — | **H3 = plan** | Windows hook shell: exec form for Claude Code, unquoted short path elsewhere, and a Windows CI job before #1270 merges. | **#1270** |

### H1 applied here (conflict E)

- `packages/cli/src/lib/session-key.ts`: `hookSessionKey(payloadSessionId)`
  (payload → CLAUDE_SESSION_ID → ppid, `safeSessionKey`, ≤ 64 chars) and
  `legacyHookSessionKeys(payloadSessionId)` (reader-only: #1228's
  `sid-<id>`, the uncapped #1301 form, the env-first stripped key main and
  #1228 used for checkpoint/counter, the stripped payload id).
- `hook-inject.ts`: the key is `hookSessionKey`; the marker reader falls back
  to a legacy-keyed marker so a session started before the upgrade is not
  re-injected. Writers (marker, reminder, lock) use the current key only.
  `injectSessionKey` is documented as legacy.
- `hook-learn-check.ts`: counter and checkpoint keyed by `hookSessionKey`.
  The stop counter is not migrated (an orphaned counter delays one nudge).
- `hook-session-end.ts`: checkpoint reader tries `hookSessionKey`, then
  `legacyHookSessionKeys`, then its previous per-candidate forms (superset).
- Not changed: `plur_session_end` in mcp `tools.ts` (cannot import the cli
  helper); it already tries payload/env/ppid in both sanitisations.
- Tests: new `packages/cli/test/session-key-h1.test.ts` (5 tests; all 5
  failed before the change). Changed `formal-r2-cli-checkpoint.test.ts`
  › "the checkpoint writer honours --path…" — H1 changes the pinned key
  from env-first `path-sess` to payload-first `p` (the `--path` property it
  pins is unchanged).

## Suites on this branch

Machine load average 220–290 (other agents); spawn and PGLite failures were
rerun alone.

- `pnpm -r build` exit 0; `tsc --noEmit` exit 0 in core, migrate, ui, claw,
  cli, dsh, mcp, opencode.
- core + mcp (PLUR_PATH/HOME in scratch): 356/365 files passed, 5 skipped, 4
  failed. After the `learnRouted` credit fix, the affected files were rerun:
  3 failures remain — OPEN CONFLICTS A, B, C.
- core-pglite: 11 passed, 10 skipped; 115 tests passed.
- cli + cli-spawn (HOME in scratch, PLUR_PATH unset): 99/112 files passed in
  the loaded run. Rerun alone, 9 of those 13 files pass; after the snapshot
  and envelope updates the remaining failures are OPEN CONFLICTS D (2 tests)
  and E (1 test).
- After H1 (conflict E applied): cli + cli-spawn 111/113 files, 1116 passed,
  3 failed, 4 skipped. `hook-auto-rate` (1) was a load timeout and passes
  alone (9/9); the 2 `plur-yaml-fixture` failures are conflict D, which
  #1348 carries under D1. Targeted H1 set (8 files) 59/59.
