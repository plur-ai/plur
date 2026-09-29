# Integration branch `integration/field-report-2026-09-29` — merge notes

Built on `origin/main` @ `524530e0` so that the open field-report PRs can be
audited and formally checked together. Every PR head was merged with
`git merge --no-ff`. Nothing was rebased, and no PR branch was changed. This
branch is not for merging into main: each fix below also has to land in the
PR named for it.

## Merge order and heads

| # | PR | Branch | Head merged |
|---|----|--------|-------------|
| 1 | #1272 | feat/1265-stores-add-url | 49d406a1 |
| 2 | #1273 | fix/1264-learn-delivery | 3cdb9321 |
| 3 | #1275 | fix/1268-shared-recurrence | cae030ff |
| 4 | #1318 | feat/1310-auto-rate | 46d0e69f |
| 5 | #1334 | fix/1319-duplicate-primary-store | 9ea8747f, then aae95574* |
| 6 | #1340 | fix/1317-secret-token-prefixes | f76c52f7 |
| 7 | #1348 | feat/1347-folder-map-core | f59e7d43 |
| 8 | #1270 (+#1315) | fix/1267-windows-init | 2b18228c |
| 9 | #1276 (+#1301) | fix/1274-inject-delivery | e29aabf6 |
| 10 | #1300 | fix/1279-mcp-init-postcompact | d0f16777 |
| 11 | #1341 | feat/1313-sync-first-inject | f6846dab |
| 12 | #1342 | feat/1312-correction-in-inject | 78eccc32 |
| 13 | #1277 (+#1314) | fix/1269-hook-outbox-flush | 44e49231 |
| 14 | #1307 | fix/1299-outbox-needs-action | 8e8c7fa0 |
| 15 | #1309 | fix/1308-breaker-4xx | 17442441 |

Not merged separately:

- #1271 and #1316 were already merged into main.
- #1315 was merged into #1270's branch, #1301 into #1276's branch and #1314
  into #1277's branch, so each arrives with its parent. I checked this with
  `git merge-base --is-ancestor`.

\* #1334 was force-updated while this branch was being built. Its new head,
aae95574 ("move trust matching out of this PR"), reverts its `trust.ts` and
`trust.test.ts` changes. I merged that head on top of the first one, so the
branch carries the final state of #1334: the canonicalize fix and the
duplicate-primary-store fix, and no trust changes. Some PR branches were
pushed during the build: #1300 and #1307 each moved twice. The table lists
the exact heads that were merged.

## Refresh — 2026-09-29, heads as of the start of the refresh

`origin/main` was still `524530e0` (#1271 and #1316 already in it), so merging
it changed nothing. PR heads taken at the start (`gh pr list`), then merged
`--no-ff` in the original order, only where the head had moved:

| PR | Head at refresh | Merged now? |
|----|-----------------|-------------|
| #1272 | 49d406a1 | unchanged |
| #1273 | 3cdb9321 | unchanged |
| #1275 | b05b4e8b | yes (clean) |
| #1318 | 46d0e69f | unchanged |
| #1334 | 5885ca62 | yes (clean) |
| #1340 | f76c52f7 | unchanged |
| #1348 | f59e7d43 | unchanged |
| #1270 | 815e125a | yes — conflict in doctor.ts |
| #1276 | e29aabf6 | unchanged |
| #1341 | cbbb4fdb | yes — conflict in hook-inject.ts |
| #1300 | b82ef274 | yes (clean) + allow-list fix |
| #1342 | 78eccc32 | unchanged |
| #1277 | d1205021 | yes — conflicts in core index.ts, stub-server.ts |
| #1307 | 8e8c7fa0 | unchanged |
| #1309 | 8e8cf450 | yes (clean; already contained #1307's head) |

The #1301, #1314 and #1315 merges into their parent branches were already in
the first build (checked with `merge-base --is-ancestor`).

### Refresh resolutions

- **doctor.ts (#1270 @815e125a vs #1307):** the report object keeps both
  #1270's new `codexCmdShimMcp` and #1307's `outbox`. `overall` unchanged
  (both conditions from the first build). Carry in: whichever of #1270/#1307
  lands second.
- **hook-inject.ts (#1341 @cbbb4fdb vs #1318):** #1341 now destructures
  `hybrid` from `injectForHook` (to await the abandoned search before exit);
  #1318's `recordInjected` call stays right after it. Carry in: whichever of
  #1318/#1341 lands second (same as before).
- **packages/mcp/src/hook-command.ts (#1300 @b82ef274 x #1318) — code change:**
  #1300 now ships a copy of the cli's hook allow-list for `plur-mcp init`,
  whose test checks parity with the cli copy. Added `hook-auto-rate` so the
  two copies stay identical (the cli copy got it in the first build). Carry
  in: #1300, or #1318 if it lands after #1300 (then it must update both
  copies).
- **core index.ts `flushOutbox` (#1277 @d1205021 vs #1307/#1309) — code
  change:** #1277's review rework moves the budget clock after the local load
  (`startBudget`), adds `in_doubt` handling and returns `skipped`; #1307 adds
  `force` and `held`. Combined: `flushOutbox({ timeoutMs, force })`,
  `_flushOutbox(budget, force, startBudget)`, return type and every return
  site `{ flushed, failed, deferred, held, skipped, expired_warnings }`, the
  outbox record type carries both `last_status` (#1307) and `in_doubt`
  (#1277), doc comment carries both paragraphs. Carry in: #1307 must rebase
  onto #1277's new head (it is stacked on it) and make exactly this merge.
- **core/test/helpers/stub-server.ts (#1277 vs #1307):** kept #1307's
  `appendCalls` and #1277's `appendDropWhileDelayed` /
  `lastAppendIdempotencyKey`, fields and resets. Carry in: #1307 (same rebase).

### Refresh verification

Load average on the machine was 220–290 during these runs (other agents).

- `pnpm -r build` exit 0; `tsc --noEmit` exit 0 in all 9 packages.
- `@plur-ai/core` + `@plur-ai/mcp` (PLUR_PATH + HOME in scratch): 277 files
  passed, 5 skipped; 4411 tests passed, 1 expected fail, 36 skipped.
- `@plur-ai/cli` + `cli-spawn` (HOME in scratch, PLUR_PATH unset — see
  below): 96/96 files, 1018 passed, 4 skipped.
- `core-pglite`: 9 passed, 2 failed, 10 skipped files; 113 passed, 2 failed.
  Both failures were timeouts (208s and 139s against a 120s limit) under the
  load above. Rerun alone: `pglite-adapter` + `pglite-scope-pushdown` 2/2
  files, 47/47 tests.

## Conflicts and resolutions (first build)

### CHANGELOG.md (every merge after the first)
Kept every entry from both sides, with no rewording. I checked for duplicate
`###` headings in `## Unreleased` and found none.

### packages/core/src/index.ts
- #1272 vs #1273: the export block `AddRemoteStoreError` conflicted with
  `LearnDelivery`. Both are kept.
- #1277, #1307 and #1309 each conflicted with #1318 on the
  `./store/remote-store.js` import line (`RemoteAbortedError`,
  `RemoteHttpError` vs `FEEDBACK_SOURCE_CAPABILITY`) and on the
  `./outbox-health.js` import (`NEEDS_ACTION_STATUSES`). The fix is one import
  that lists the names from both sides.

### packages/core/src/trust.ts (#1334 vs #1348)
Once #1334 was taken at its final head, `trust.ts` did not conflict. #1348's
folder-map trust (`folders.ts`) is the only place trust is decided, and
`trust.ts` is a thin wrapper over it. #1334's `canonicalize` fix in
`project-config.ts` merged cleanly, and #1348's `folders.ts` calls it. The
trust check still fails closed: `isTrustedInMap` uses `lax=false`, so an
entry matches only as written or with its parent canonicalised. `untrust`
also removes an entry stored under the raw spelling, which is what #1334
wanted, through #1348's `clearFolderTrust`. #1334's duplicate-primary-store
fix (`_loadConfig`, `addStore`, `autoDiscoverStores`) merged cleanly.

### packages/cli/src/lib/hook-command.ts (#1270 x #1318), a code change
#1270's `PLUR_SETTINGS_SUBCOMMANDS` allow-list did not include
`hook-auto-rate`. #1318's `plur init` writes
`<shim> hook-auto-rate claude` into Claude Code's `Stop` hooks. Without the
entry, `isPlurHookCommand` does not treat that hook as PLUR's, so every rerun
of `plur init` would add another auto-rate hook, and uninstall would leave it
behind. I added `'hook-auto-rate'` to the list.

### packages/cli/src/commands/init.ts (#1270 / #1276 / #1318 / #1341)
- Imports: #1270's `hook-command.js` import and #1341's
  `CLAUDE_INJECT_TIMEOUT_S` import are both kept.
- Merged without conflict and checked by hand:
  - #1276 moves the rehydrate hook from `PostCompact` to `SessionStart` with
    matcher `compact`.
  - #1341 makes `UserPromptSubmit` and the rehydrate hook synchronous, with a
    20s timeout.
  - #1318's Stop hook `hook-auto-rate claude` is still there.
  - #1270's shim quoting and hook-by-hook stripping are still there.

### packages/cli/src/commands/hook-inject.ts (#1276 / #1301 / #1318 / #1341 / #1342)
- Imports: `recordInjected` (#1318), `safeSessionKey` (#1301) and the
  `codex-hook-io` helpers (#1341) are all kept.
- `injectSession`: I took #1341's bounded `injectForHook` in place of the old
  try-hybrid-then-catch-BM25 block. This is a code change: #1318's
  `recordInjected('claude', …)` used to be called in both branches of the old
  block. It is now called once, right after `injectForHook` returns, so it
  records whichever mode ran.
- #1342's correction reminder merged cleanly on top.

### packages/cli/src/commands/doctor.ts (#1270 vs #1307), a code change
The `overall` condition now requires all three:
- `brokenNodeMcp.length === 0` (#1270/#1315)
- `(!cursorProjectDetected || cursorWired)`
- `(outbox?.ok ?? true)` (#1307)

Each side had dropped the other's condition.

### packages/migrate/test/method-list.test.ts (#1272 vs #1307)
Both `addRemoteStore` and `outboxSummary` are kept in `ALWAYS_ASYNC`.

### docs/runbooks/hook-timeouts.md (#1318 vs #1341)
- Budget table: I kept #1341's Claude Code row (sync, 20s, the hook exits
  itself at 15s) and dropped the old "90s (async)" row. #1318's auto-rate row
  is kept.
- Both explanatory paragraphs are kept.

## Changes needed only because the PRs meet (tests and fixtures)

These failed only once the PRs were combined. Each PR passes on its own.

| File | Why it failed | Change | Carry in |
|---|---|---|---|
| `packages/mcp/src/index.ts` + `packages/mcp/test/init-hooks.test.ts` | #1300's parity test requires `plur-mcp init`'s rehydrate entry to equal the cli's. #1341 changed the cli's entry to sync with a 20s timeout. | MCP rehydrate entry changed to `timeout: 20`, no `async`. The literal expectation is updated to match. | Whichever of #1300 and #1341 lands second. If #1300 lands first, #1341 must update `packages/mcp/src/index.ts`. |
| `packages/cli/test/init-windows-1267.test.ts` | Its assertions assumed one PLUR entry per matcher and four Cursor hooks. #1318 adds a second `Stop '*'` entry and Cursor's `afterAgentResponse` auto-rate hook, and #1276 adds `SessionStart 'compact'`. | Cursor now expects 5 hooks, and the extra one must be `hook-auto-rate cursor`. No-duplicate checks are keyed on (matcher, command). Legacy-cleanup checks count per subcommand. | #1270 (rebase onto #1318 and #1276), or whichever lands last |
| `packages/cli/test/__snapshots__/init-windows-1267.test.ts.snap` | The darwin/linux snapshot from #1270 predates #1276, #1318 and #1341. | Regenerated. The differences are the SessionStart `compact` rehydrate entry, the sync 20s timeouts, no `PostCompact`, and the Stop `hook-auto-rate claude` hook. | Whichever of #1270, #1276, #1318 and #1341 lands last |
| `packages/cli/test/fixtures/plur-yaml/*.txt` (3 goldens) | #1348's goldens were captured from main before #1276. #1276 wraps hook output in `{"hookSpecificOutput":{"hookEventName":…}}`. | Regenerated with `PLUR_UPDATE_GOLDEN=1`. A word diff shows that only the envelope changed; the context text is byte-identical. | Whichever of #1348 and #1276 lands second |

## Noted, not changed

- `plur-mcp init` (#1300) still registers `UserPromptSubmit` `hook-inject` with
  a 15s timeout. The cli registers it with #1341's 20s, and the hook's own
  ceiling is 15s. The test does not guard this, but the two builders now
  disagree. #1341 should decide whether it changes too.
- `plur-mcp init` does not register #1318's `hook-auto-rate`. This is
  unchanged behaviour, but it is a gap between the two builders.

## Verification

Results on this branch:

- `pnpm install --frozen-lockfile`: completed. `pnpm -r build`: exit 0.
- `tsc --noEmit`: exit 0 in core, migrate, ui, examples, claw, cli, dsh, mcp
  and opencode.
- Test runs used HOME and PLUR_PATH in a scratch directory, never the real
  `~/.plur`:
  - `@plur-ai/core`: 232 files passed, 5 skipped. 3843 tests passed, 1
    expected fail, 36 skipped.
  - `core-pglite`: 11 files passed, 10 skipped. 115 tests passed, 121
    skipped.
  - `@plur-ai/mcp`: 43 files and 489 tests passed.
  - `@plur-ai/cli` + `cli-spawn`: 93 of 94 files passed. 999 tests passed, 1
    timed out at 5s under load, 4 skipped. The timed-out test is
    `learn-provenance-flags` › "accepts every claim class". It passed alone:
    6 of 6.
  - `hook-learn-check` fails 3 checkpoint tests when PLUR_PATH is exported
    into the run. The spawned CLI inherits it and writes the checkpoint away
    from the test's HOME, so the failure comes from the harness, not the
    code. With PLUR_PATH unset and HOME in scratch, it passed 10 of 10.
