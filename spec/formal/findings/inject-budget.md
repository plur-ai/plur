# inject-budget — findings

Model: `spec/formal/PlurSpec/ScopeInject.lean` §8 (new), §5 (`tokens_used_bound` restated).
Checked: `cd spec/formal && ~/.elan/bin/lake env lean PlurSpec/ScopeInject.lean` — no errors, no sorry.

## 1. The whole injection stays within its budget (INJ-2, INJ-6) — CONFIRMED+FIXED

The code says `directives + consider ≤ maxTokens` (`InternalInjectionResult`, `selectAndSpread` CAP-SUM).
The old Lean bound (`maxT + 200 + spreadB`) was stale, and `total_le_budget` took the section spend
`S ≤ maxT` as a hypothesis. Modelling the section passes branch for branch exposed the gap: the
constraints-floor pass got `floor − pinnedConstraintTokens` whatever the pins had left. `injection.pinned_ratio`
is configurable up to 1 (config schema `min(0).max(1)`), so with a pinned share above 0.6 the pins and the
floor together overran `maxTokens`.

- Counterexample (model): `old_sections_exceed` — budget 1000, pins 1000, floor pass 400 → 1400.
- Replay (real code, before the fix): `pnpm exec vitest run packages/core/test/formal-inject-budget-sections.test.ts`
  → `expected 1341 to be less than or equal to 1000` (pinned_ratio 1); `ratio 0.7 budget 500: expected 508 ≤ 500`.
- Fix (inject.ts `selectAndSpread`): the floor-pass budget is `max(0, min(floor − pc, maxTokens − pinned spend))`.
  Same test now 3/3 passing.
- Proved:
  - `pinned_within_share`: the two-tier pinned pass never spends more than `maxT`, never more than the pinned
    share in total, and the hard tier never more than its cap. Needs `hardCap ≤ pinB`, which the clamp in
    `pinnedHardCap` guarantees.
  - `sections_le_budget`: the four section passes stay ≤ `maxT` once pins are.
  - `pools_le_budget`: the consider pool (sliced to 5) and spreading (stopped at the count cap) fit what is left.
  - `tokens_used_bound` (restated, same name): the composed claim, for every pinned share, hard cap, floor,
    spread budget, count cap, fairness-cap oracle and candidate list.
  - Non-vacuity: `pinned_tiers_admitted`, `soft_cannot_spend_reserve`, `sections_keep`, `sections_replay`.
- Mutation check (scratch copies, each breaks a proof):
  - floor pass without the `min` → `sections_le_budget` fails;
  - soft budget `pinB` instead of `pinB − R` → `tstep_inv` / `pinned_within_share` fail;
  - hard check without `hardCap` → `tstep_inv` fails;
  - spreading given all of `rem` → `pools_le_budget` fails;
  - spread loop without its skip → `spreadRun_le` fails.
- Left out: the per-pack and per-domain caps are oracles (they only skip). Token costs are abstract numbers;
  `estimate_covers_render` (§5) covers that the charge covers the rendered text.

## 2. plur/injection.ts unbacked rules — TESTED

These are I/O and recording rules, so they are backed by tests, not Lean
(`packages/core/test/formal-inject-budget-injection.test.ts`, 7 tests):
- `recordedSessionId`: an inject with `NO_SESSION` records no session id; a real id is recorded.
- `remotePromise.session`: `dial_session` is never recorded as a session.
- `st`: with embeddings disabled, `injectHybrid` reports `bm25-only` with no degraded reason or error.
- `InjectionMethods`: `_remoteOnlyStatus` reports not served for no result, no outcome, a failed outcome, another
  host's outcome, or a folder with no scope; served only for an ok outcome from the folder's own store.
- `modelMissing`: already covered by `recall-model-missing-1587.test.ts` (that test also calls `injectHybrid`
  and checks there is no spawn and no fetch). Mapped in the inventory only.
- Mutation check (temporary edits to injection.ts, then restored; `diff` empty): recording the raw session id,
  recording `dial_session`, always reporting `hybrid`, and reporting served for any outcome. Each one fails a test.

## 3. inject.ts `originLines` — DOWNGRADED (comment fixed)

A scope line is shown only for a non-empty scope string. The schema requires `scope: z.string()`, so every loaded
memory has one; only `''` (accepted by the schema) and bare cost-estimate wires (MCP `_estimatePinnedCost`) have none.
Neither has a scope to name, so the behaviour is intended, but the comment claimed it for every entry. The comment
now states the exception. `formal-inject-budget-origin.test.ts` checks the scope line in directives, constraints and
consider, and that an empty scope gets no line.

## 4. tensions.ts `TensionScanResult.skipped` — CONFIRMED + DECIDED (c)

The comment said every policy skip is counted. In fact only measured-under skips are counted. Snapshot pairs dropped
by `snapshot_pairs: 'skip'` (reachable only when `temporal_domains` is configured), expired windows and supersedes
links leave no trace. Counting snapshot skips would change the result shape, and two existing tests pin it exactly
(`tensions-measured-under-gate.test.ts` `toEqual({ measured_under, measured_under_pairs })`), so the code was not
changed. The comment now names what is counted and what is not. `formal-inject-budget-tensions.test.ts` pins the
current behaviour.

DECIDED: should snapshot-pair skips be reported?
(a) keep as is, with the comment corrected;
(b) add `skipped.snapshot` and `skipped.snapshot_pairs`, an additive field shown by the CLI and MCP (the existing exact-shape tests would need updating);
(c) treat every configured gate (snapshot, measured-under) as reportable and leave the structural ones (expired, supersedes, recorded) out.

Decision: (c) "gates". `skipped` keeps `measured_under` and `measured_under_pairs` and adds `snapshot` and
`snapshot_pairs` (type `TensionSkips`); a pair both gates match counts once, as snapshot. Structural skips
stay uncounted. The CLI `--json` output and the MCP scan result pass `skipped` through whole. Tests:
`formal-inject-budget-tensions.test.ts` (5; the snapshot-skip test that pinned "not counted" now pins
"counted"), and the two exact-shape assertions in `tensions-measured-under-gate.test.ts` gained the new
fields.
