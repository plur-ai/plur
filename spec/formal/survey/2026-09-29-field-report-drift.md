# Field report × formal models — drift and conflict report (2026-09-29)

Branch `formal/field-report-2026-09-29` =
`integration/field-report-2026-09-29` @ `baf6df61` (the 15 field-report PRs;
merge notes in `docs/audits/2026-09-29-integration-notes.md`) merged
`--no-ff` with #1228 `verify/formal-lean` @ `420f4f25`. No PR branch was
touched. This is a workspace for auditing the two bodies of work together,
not a candidate for main.

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
