# Field report — final summary (2026-09-29)

An enterprise deployment reported four problems: engrams stayed on laptops without saying so, most
folders had no automatic memory, no editor produced feedback outcomes, and some editors were not set
up. This file records where each item stands at the end of the run. Nothing has been merged or
released by this run. The merge gate is the owner.

## Items

| Item | Merged | Open |
|---|---|---|
| 1 learn result says where the engram went, and warns when it stayed local | — | #1273, #1275 |
| 2 register a url store from the CLI (`plur stores add --url`, `plur remote`) | — | #1272, #1415 |
| 3 folder map (off / on / ask, ask once) — design r3 approved | #1348 | #1403, #1418 |
| 4 auto-rate from end-of-turn hooks (rating on, capture off) | — | #1318 |
| 5 save nudge reaches the model (checked in a real Claude Code session) | #1271, #1300, #1341 | #1276, #1353 |
| 6 opencode set up by default; Claude Desktop was already done | #1315 | — |
| 7 Windows hook and MCP entries | — | #1270 |
| 8a a shared save is never absorbed across scopes | — | #1275 |
| 8b one secret aborting session_end suggestions | #1316 (pinned: already fixed) | #1340 (more token patterns) |
| 8c correction detection runs from the prompt hook | #1342 | — |
| 8d hooks flush the outbox | #1307, #1309 | #1277 |

Follow-ups from the audits and the formal run: #1334, #1349, #1395, #1396, #1398, #1400, #1401,
#1414, #1422, #1424.

## Checks run in this session

- Lean models on the formal branch (`e12df3a6`): build ok, no gaps, 3272 theorems, standard axioms
  only, no drift against the #1228 base. Re-run by the lead, not only by the agent.
- Replays: 18 now pass as plain tests. 3 remain expected failures by owner decision (C4 accepts one
  duplicate on a server that ignores the idempotency key). Two more in the hook replays: one tests
  `run()` directly while #1422's fix sits in the dispatcher, and one (ppid with the session variable)
  is not decided.
- Full suites on the integration branch, one at a time: core-pglite, mcp and cli-spawn clean.
  core has 6 failures (4 pass when run alone), cli has 14 and migrate has 1. All of those come from
  PRs that collide with each other, listed below.

## Cross-PR failures and who carries each

| Failure | Carried by |
|---|---|
| #1228's untrusted-scope notice vs the folder map (8 cli tests) — open conflict J | owner call: #1418 keeps the notice, or #1228 drops those tests |
| `formal-adapters-init-remote` ×4 (code replaced by `plur remote`) | #1228 drops the tests |
| `formal-r2-apply-core-always-store` good case | #1228 updates it to decision A1 |
| `formal-writepath-tension` fixture predates the new ladder | #1275 or #1228 |
| migrate `method-list` does not list `verifyRemoteStore` | #1415 |
| `hook-force-exit-lock`, `init-windows-h3` | #1349 / #1395 (same as the previous refresh) |

Code that must be carried by whichever PR lands second:

- `folders.ts` removes every match and revokes trust — #1334 / #1403.
- folder gate around the outbox flush in the stop and session-end hooks — #1277 / #1418.
- `--warm-embeddings` checked before the folder gate — #1414 / #1418.
- nullable hook-inject paths — #1395 and anything stacked on it.

## Merge order

- #1276 pairs with the merged #1300; land it next.
- #1415 not before #1418.
- whichever of #1422 and #1349 lands second uses `exitWhenStoreIdle`.
- stacked PRs take the null-dir guard from #1395.
- the #1228 side of decisions C3 and F1 waits until #1277 and #1275 are on main.
- #1270 and #1318 reconcile PLUR's hook recognition (decision: any `hook-*` behind PLUR's launcher).

## Done-when

- Every item merged or explicitly rejected: **not yet** — the open PRs above await the merge gate.
- CHANGELOG entry per change: each PR carries its own entry.
- Fresh install on macOS and Windows, in a never-registered folder, asks once, writes an engram that
  reaches the url store on "yes", and produces a feedback outcome: **not verified**. It needs the open
  PRs on one build, then a clean-machine run on each OS against a test store. Windows has only been
  exercised with win32-stubbed tests; the Windows CI job planned for #1270 would settle the hook
  strings before a real machine run.
