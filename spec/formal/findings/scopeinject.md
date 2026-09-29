# ScopeInject findings

Model: `spec/formal/PlurSpec/ScopeInject.lean` (namespace `PlurSpec.ScopeInject`).
Check: `cd spec/formal && lake env lean PlurSpec/ScopeInject.lean`.
Replay scripts: `$SCRATCH/replay*.ts` where `$SCRATCH=<session scratchpad, not committed>/`,
run with `cd packages/core && npx tsx $SCRATCH/replayN.ts`.

## 1. Injection scope visibility bypass (core-retrieval#1) — CONFIRMED+FIXED

`scoreEngram` returns 0 for both "excluded by scope" and "no keyword hits"; `selectAndSpread`
revived a 0 via (a) the pinned exemption `raw > 0 || pinned`, (b) the semantic-only embedding
boost `raw === 0 && embBoost > 0.5`, (c) spreading activation, whose `engramMap` held every
active engram regardless of scope. The fix is local to inject.ts: no index.ts change needed
(injectHybrid boosts are harmless once the gate precedes them).

Replay (pre-fix, `replay1.ts`, calls `selectAndSpread` from src):
```
(a) pinned project:a: [ 'ENG-2026-0920-002', 'ENG-2026-0920-001' ]   # 002 is group:acme/other, pinned
(a2) pinned global: [ 'ENG-2026-0920-003', 'ENG-2026-0920-004' ]     # 003 is user:x under scope=global
(b) emb boost: [ 'ENG-2026-0920-005', 'ENG-2026-0920-001' ]          # 005 group:acme/other, boost 0.9
(c) spread: [ 'ENG-2026-0920-007', 'ENG-2026-0920-006' ]             # 006 group:acme/other via association
```
(a2) contradicts INJECT_GLOBAL_IS_TARGETED. Bounded by the `options.scopes` authorization
allow-list when a caller passes one; without it (the single-user default) the scope filter is the
only gate.

Fix (packages/core/src/inject.ts): new exported `isInjectVisible(engramScope, scopeFilter, grants)`
— the same decision as `scoreEngram`'s gate — checked in both the personal and the pack loop
BEFORE `engramMap.set` and scoring. Excluded ids go into `scopeExcludedIds`; a spreading edge to
one is skipped without counting as `dropped_unresolvable`/`dropped_retired` (it is neither).

Theorems: `selected_visible` (every delivered id is visible, for every visibility oracle,
filter and budget choice), `global_is_targeted`, `good_case_reachable` (non-vacuity: visible
pinned / semantic-only / associated engrams still arrive), counterexamples on the pre-fix model
`old_pinned_leaks`, `old_global_not_targeted`, `old_embedding_leaks`, `old_spread_leaks`.

Tests: `packages/core/test/formal-scopeinject-visibility.test.ts` (6 tests; 5 failed before the
fix, all pass after). Regression run: inject.test, inject-scopes, read-side-scope-visibility,
pinned-quota, pack-double-injection, supersedes-inject, feedback-vs-traffic, draft-approval-gate,
remote-integration, validity-instants, pglite-recall-wiring — all pass (223 tests).

Mutation-check: removing the gate from `admitNew` (Mut1a) or from `mapNew` (Mut1b) makes
`selected_visible` fail to prove.

## 2. Pinned origin priority across the three selection passes (core-retrieval#3) — CONFIRMED+FIXED

`pinnedOriginRank` + `skippedRank` enforced "no pack pin ahead of the user's own" inside ONE
`fillTokenBudget` call; `selectAndSpread` made three calls (constraints floor, directives, slack)
with a shared ledger but a fresh `skippedRank` and disjoint candidate sets. inject.ts:236-238 calls
the ordering "a security control"; 551-553 claims budget pressure can never let a pack pin in first.

Replay (pre-fix, `replay2.ts`): maxTokens 1000, primary pinned `dont` engram P (450 tokens), pack
pinned `do` engram Q (300 tokens):
```
costs 450 300
delivered [ 'ENG-2026-0920-102' ]                                   # the pack pin
omitted [ { id: 'ENG-2026-0920-101', cost: 450, reason: 'total-budget' } ]   # the primary pin
```
(P > 400 floor in pass 1; Q admitted in pass 2, ledger 300; pass 3 refuses P for 300+450 > 500.
The reported reason `total-budget` is also wrong — 700 tokens of budget remained.)

Fix (inject.ts `selectAndSpread`): ONE pinned pre-pass over every pinned candidate of both sections
(`fillTokenBudget(pinned, maxTokens, maxTokens, ledger)`), origin-sorted, so the rule is global.
Pinned constraints/directives are then committed to their sections; the three section passes see
only unpinned engrams, with budgets reduced by the pinned tokens (pinned constraints still draw on
the constraints floor first). `fillTokenBudget` gained an optional `seed` parameter so committed pins
still count toward per-pack/per-domain caps of their section, as before. `omitted_pinned` now comes
from the pre-pass only. After fix the same replay prints `delivered [101]`, `omitted [102
pinned-sub-budget]`.

Theorems: `pinned_priority` (for any costs/budgets, a single origin-sorted pass admits nothing of
a lower origin than something it omits; proof via invariant `PInv`, `pstep_inv`, `prun_inv`),
`old_pack_pin_displaces_primary` (three-pass pre-fix model, decided on the replayed input),
`new_primary_wins`, `pinned_both_fit` (non-vacuity).

Tests: `packages/core/test/formal-scopeinject-pinned-origin.test.ts` (2 tests; the priority test
fails on HEAD inject.ts — checked by temporarily restoring `git show HEAD:` — and passes after).
Regression: every core test file calling inject/selectAndSpread/fillTokenBudget, run one by one
(23 files, 516 tests incl. plur.test, pinned-quota, inject.test) + mcp e2e/session/receipt-tool
(39 tests) — all pass.

Mutation-check: making `blockedBy` always false (dropping the skippedRank rule) breaks
`pinned_priority` (Mut2.lean: omega fails).

Behaviour note for the owner: pins are now committed before any unpinned engram in either section.
Previously a pinned directive competed only inside the directives pass. Totals and section floors
are unchanged; the only observable difference is in over-budget cases like the one above.

## 3. Scope-family predicate drift (core-policy#12 umbrella, #1) — CONFIRMED (catalogue) + NEEDS-OWNER; #1's consumer claim DOWNGRADED

Model: one classification (`isShared`, `isPersonal`, `isLocalOnly`, `leakGuard`, `autoRouteAllowed`,
`withheld`, ground truth `leaves = shared ∨ remote-backed`), scopes as `List Char` so the kernel
evaluates the real string rules.

Replay (`replay3.ts`, real predicates from src):
```
s               shared personal localOnly
primary         false  true     true
global          false  true     true
project:plur    true   false    true     <- local-only AND shared
Project:plur    true   false    false    <- case drift (isShared folds, isLocalOnly does not)
GLOBAL          false  true     false
user:alice      false  true     false
assert Project:plur (store project:plur): refused              <- fails closed
assert project:plur/sub (store project:plur url): accepted -> localOnly true
autoRoute user:alice (url-backed): route                       <- unscoped write may leave the machine
autoRoute group:acme: refuse-shared
```

Proved consistent: `leakGuard_eq_leaves`, `autoRoute_leaving_is_scanned` (anything auto-routed that
leaves the machine is still secret-scanned, since the guard is `shared ∨ remote-backed`),
`local_family_personal`.
Drift catalogue (decided on the real rules): `project_localOnly_and_shared`, `case_drift`,
`autoRoute_can_leave`, `provenance_global_not_withheld`.

Lead #1 as stated ("forget/feedback naming a url-backed project:x cannot reach it") is DOWNGRADED:
both `forget` (index.ts ~6442) and `feedback` (~5701) look up an exact url-store match BEFORE the
`isLocalOnlyScope` guard, so `project:x` with a url store is reached. The residue is a DESCENDANT
scope: an engram from url store `project:plur` whose own scope is `project:plur/sub` — naming that
scope passes `assertScopeNamesATarget` (local-only) and then throws "not found in the local store …
pass the remote scope to target it directly", which is fail-closed but misleading.
Case drift fails closed everywhere checked (`assertScopeNamesATarget` refuses `Project:plur`;
the visibility predicate hides `Group:acme` under a project filter just as it hides `group:acme`).

No code changed: every resolution is a policy choice.

NEEDS-OWNER:
- Q3a. `isLocalOnlyScope('project:*')` — should `project:*` stay "local-only" (A: keep; url-backed
  project stores are reached only by exact url-store scope, as now), (B) drop `project:` from the
  local family and require a configured store for project scopes, or (C) resolve local-only by
  config (local iff no url store's scope contains it, via `isScopeWithin`)?
- Q3b. Case: should `isLocalOnlyScope`/`LOCAL_FAMILY` fold case like `isSharedScope` (A) or should
  scopes be normalised to lower case at the API boundary (B), or leave fail-closed as is (C)?
- Q3c. `decideAutoRoute` refuses shared scopes only. Should it also refuse a url-backed personal
  scope (A), allow it (B, current; the leak guard still scans it), or allow only when the url store
  is the user's own `/me` namespace (C)?
- Q3d. provenance `withheld` uses `scope === 'local'` only. Should it be `isLocalOnlyScope(scope)
  && !remote-backed` (A), `!leaves(scope)` (B), or stay (C)? (provenance.ts is not in this cluster.)

## 4. learner.ts polarity inversion (core-retrieval#4) — CONFIRMED+FIXED (plus a second inversion found)

The always/never pattern `((?:always|never)\s+.+)` was unanchored: (a) a negation directly before
the directive word was cut off; (b) new finding: `never` matched inside `whenever`.

Replay (pre-fix, `replay4.ts`, real `extractLearnings`):
```
"Don't always rerun the full suite."               -> ["always rerun the full suite"]
"Do not always trust the cache on CI."             -> ["always trust the cache on CI"]
"Whenever you deploy, run the smoke tests first."  -> ["never you deploy, run the smoke tests first"]
"You should not always rebase onto main."          -> ["always rebase onto main"]
```
After fix:
```
"Don't always rerun the full suite."               -> ["Don't always rerun the full suite"]
"Do not always trust the cache on CI."             -> ["Do not always trust the cache on CI"]
"Whenever you deploy, run the smoke tests first."  -> []            (refusing is safe, per learner.ts E1 note)
"You should not always rebase onto main."          -> ["not always rebase onto main"]
```

Fix (packages/core/src/learner.ts): `/((?:\b(?:don['’]?t|do not|not)\s+)?\b(?:always|never)\b\s+.+)/i`
— word boundaries on the directive word, and a directly preceding negation (incl. curly apostrophe)
captured with it.

Theorems: `extract_preserves_polarity` (for every sentence of shape `filler* [not] (always|never)
filler*`, the extracted statement has the sentence's negation parity; `whenever` is filler),
helper `extractNew_filler`; counterexamples `old_drops_negation`, `old_whenever_is_never`;
`new_whenever_not_matched`.

Tests: `packages/core/test/formal-scopeinject-learner.test.ts` (6 tests; 5 fail on HEAD learner.ts,
all pass after). Regression: core learner.test (41), claw learner.test (12, runs against core dist —
coordinator's build will exercise the new regex), claw pr1-scope-routing (4), opencode learn.test (15)
— all pass.

Mutation-check: dropping the captured negation in `extractNew` (Mut4.lean) breaks
`extract_preserves_polarity`.

## 5a. Token estimator vs formatters (core-retrieval#5) — CONFIRMED+FIXED

`estimateTokens` claimed (inject.ts:265-267, 1086-1088) to stay in step with the formatters; it had
drifted: no charge for `Kind: <claim_class>` (#963), none for the soft-expiry marker, and layer 1
(consider) renders an untruncated `summary` while the estimate charged the statement.

Replay (pre-fix, `replay5.ts`):
```
[ENG-2026-0920-201] ⚠ EXPIRED 2026-09-01 — verify before use: Deploy only from main
  Domain: ops.deploy | Commitment: leaning | Kind: inferred | Confidence: 0.35 | Last active: …
layer3 rendered chars 202 ceil/4 51 estimate 37
layer1 rendered chars 134 ceil/4 34 estimate 25
```
After fix: `estimate 51` and `estimate 34`.

Fix (inject.ts `estimateTokens`): charge `ceil(max(len(formatLayer3), len(formatLayer1)) + 1) / 4`
by rendering through the formatters themselves (placeholder `confidence_score` of the same width),
floored by the previous field sum (`legacyEstimateChars`) so no budget calibrated against the old
over-charge loosens. Without the floor, pinned-quota.test (2 tests, calibrated fixtures) failed by
2 tokens — the floor keeps them green.

Theorems: `estimate_covers_render` (charge ≥ rendered at layer 3 and layer 1),
`estimate_ge_legacy` (never cheaper than before), counterexample `old_estimate_undercharges`.

Tests: `packages/core/test/formal-scopeinject-budget.test.ts` (3 tests; 2 fail on HEAD inject.ts,
pass after). Regression (after all inject.ts changes): pinned-quota 11, inject 51, supersedes-inject 6,
plur 75, sp1-memory-intelligence 45, injection-dedup 21, and the 23-file inject set — all pass.

Mutation-check: `estNew := ceil4 (legacy e)` (Mut5.lean) breaks `estimate_covers_render`.

## 5b. tokens_used over the injection budget (core-retrieval#5 second half) — CONFIRMED, NEEDS-OWNER

Proved `fill_le` (a fill pass never exceeds its own budget) and `tokens_used_bound`: `tokens_used`
≤ maxTokens + 200 (DIP-19 consider) + spread_budget (480). The consider and spreading pools have
their own budgets on purpose (inject.ts comment), so this is by design at the selector; but
`injection_budget` reads as a total. Replay (`replay5.ts`, 40 matching engrams + 40 associated,
maxTokens 500): `tokens_used { directives: 448, consider: 375 } total 823` (65% over).
Counterexample theorem `tokens_used_exceeds_budget`.

- Q5b. Should `injection_budget` bound the whole injection (A: consider + spread carved out of it),
  stay a directives/constraints budget with the extras on top (B: document it — and report
  `tokens_used.directives` against the budget, not the sum), or cap the sum at maxTokens by
  shrinking consider/spread to what is left (C)?

## 6. renderMemoryBlock budget (core-retrieval#6) — CONFIRMED, NEEDS-OWNER

Sections are appended whole when the remaining budget is > 0 (directives) or > 100 (constraints,
consider); their size is never compared. Docstring claims "within the token budget".
Replay (`replay6.ts`): tokenBudget 499, instructions 449 tokens, three 5000-token sections →
`rendered tokens 5469, directives included true`. Theorem `memBlock_exceeds_budget` (model of the
three gates). Not fixed: memory-block.ts says "Behaviour must stay identical to claw's
pre-extraction implementation — claw is a shipped package".

- Q6. (A) drop any section whose own size exceeds what remains (keeps output ≤ budget), (B)
  truncate sections entry-by-entry at the budget, or (C) keep as is and correct the docstring to
  "sections are included while budget remains"?

## 7. Miss-signal classification (core-retrieval#2) — CONFIRMED, comment corrected, behaviour NEEDS-OWNER

(i) `low_score` unreachable at the default floor. Every non-empty RRF result has top ≥ 1/61 ≈
0.01639 > 0.015; the source comment claimed the opposite ("a lone weak match still registers as a
miss"). (ii) PGLite recall always passes `topScore: null` (index.ts:4191/4242) and `classifyMiss`
maps null-with-results to `no_results`, so with telemetry opted in every PGLite recall that returns
results emits a false "no results" miss; also the YAML path with an empty local leg plus remote rows.
(iii) `domain` is sent verbatim (by design per the module's privacy note, but user-defined domains
can carry the same kind of names #312 reduced for scopes).

Replay (`replay7.ts`, real `hybridSearchWithMeta` with PLUR_DISABLE_EMBEDDINGS=1 and `classifyMiss`):
```
mode bm25-only results 1 topScore 0.01639344262295082 1/61 = 0.01639344262295082 threshold 0.015
classify: null                                   <- a lone weak match is a HIT
PGLite-shaped (results, topScore null): no_results
```

Theorems: `lowScore_unreachable` (for any result lists, any non-empty recall is never `low_score`
at k=60, floor 0.015; helper `rrf_head_ge`), `lowScore_reachable_above_floor` (non-vacuity),
`pglite_null_is_noResults`.

Change: comment above `DEFAULT_MISS_SCORE_THRESHOLD` corrected (telemetry-miss-signal.ts). No
behaviour change: `telemetry-miss-signal.test.ts:60` pins "no_results when topScore is null despite a
count" on purpose, and the threshold decides what telemetry emits. telemetry-miss-signal.test: 23 pass.

- Q7a. Default floor: keep 0.015 (A: `low_score` effectively off unless overridden), move it
  between 1/61 and 2/61 (B: single-list matches count as misses), or drop `low_score` (C)?
- Q7b. PGLite null topScore: (A) have `_pgliteHybridRecall` (index.ts, WritePath's file) return an
  RRF top score, (B) make `classifyMiss` treat null-with-results as "unknown — no signal" (changes the
  pinned test), or (C) keep.
- Q7c. `domain`: send verbatim (A, current), reduce to its first segment (B), or omit (C)?

## 8. Decay NaN floor and sub-floor rise (core-policy#8) — NaN: CONFIRMED+FIXED; sub-floor rise and shouldInject: NEEDS-OWNER

The schema accepts any string as `activation.last_accessed`. `daysSince` returned NaN for an
unparseable one (`Math.max(0, NaN)` is NaN), `decayedStrength` then NaN, the injection score NaN, and
`raw > 0` false, so the engram was silently never injected. `confidenceDecay` returned
`Math.max(0.1, NaN) = NaN`, which breaks its documented "Floor at 0.1".

Replay (pre-fix, `replay8.ts`):
```
daysSince("yesterday-ish") NaN
decayedStrength(0.8, NaN) NaN
confidenceDecay(0.8, "garbage") NaN
sub-floor rise: decayedStrength(0, 0) = 0  (0, 30) = 0.03884349199257851  (0.02, 60) = 0.048506387948964086
schema accepts bad last_accessed
injected [ 'ENG-2026-0920-602' ]          # the engram with the bad date (601) is missing
```

Fix (packages/core/src/decay.ts): `daysSince` returns 0 for a non-finite elapsed time ("no known
elapsed time" — the reading `shouldInject` already gives a missing `last_accessed`);
`confidenceDecay` returns the strength unchanged for an unparseable reference (the same as its
existing "no reference" branch).

Theorems: `decay_total` (admission for any stored string once strength and hits are positive),
`old_bad_date_dropped`, `conf_floor`, `old_conf_nan`, `decay_nonincreasing_above_floor` (decay never
raises a strength at or above the floor), `sub_floor_rises` (instance of the replayed rise).

Tests: `packages/core/test/formal-scopeinject-decay.test.ts` (4 tests; 3 fail on HEAD decay.ts, all
pass after). Regression: decay 6, sp1-memory-intelligence 45, inject 51, plur 75 — pass.

Mutation-check: `confNew none => 0` (Mut7.lean) breaks `conf_floor`. (`decay_total` is about
totality; its pre-fix counterpart is the `old_bad_date_dropped` counterexample.)

- Q8a. Sub-floor rise: feedback floors strength at 0.0 but decay's floor is 0.05, so an engram
  voted down to 0 regains strength with time. (A) decay only moves strength toward the floor from
  above (`min(r, formula)`), (B) align feedback's floor to 0.05, or (C) keep (read as "regression to
  the floor")? Docstring "Never reaches zero" is false at d = 0 either way.
- Q8b. `shouldInject` (decay.ts) is exported, has no src caller, and matches scope by family prefix
  (`project:a` admits `project:b`), contrary to `isScopeWithin` (#383). (A) delete it, (B) re-base it
  on `isScopeWithin`, or (C) keep for API compatibility with a deprecation note?

## Final state

- `lake env lean PlurSpec/ScopeInject.lean`: clean, 693 lines, no sorry/admit/axiom/native_decide.
- `npx tsc --noEmit -p packages/core`: clean.
- Final targeted run: formal-scopeinject-{visibility 6, pinned-origin 2, learner 6, budget 3, decay 4}
  = 21 new tests pass; inject 51, pinned-quota 11, inject-scopes 14, read-side-scope-visibility 35,
  supersedes-inject 6, learner 41, decay 6, telemetry-miss-signal 23, memory-block 3, plur 75 pass.
  inject.test failed ONE test once in 11 runs (not reproduced in 10 reruns; other agents were
  running suites at the time) — the coordinator's full run should confirm.
- Not added: a `verify.yaml` models entry (file not owned by this cluster). Suggested entry:
  model `PlurSpec/ScopeInject.lean`, covers the 8 owned src files.

## Apply phase (2026-09-26)

Decision I6 applied: above-floor. `decayedStrength` (packages/core/src/decay.ts) returns a
strength at or below FLOOR (0.05) unchanged; above it, the formula as before. Docstring corrected
("Never reaches zero" was false at d = 0). Model §7: `decOld`/`decNew`, theorems
`decay_never_rises` (for every strength, floor and q ∈ [0, 10^6]), `decay_above_floor_bounded`
and `decay_still_decays` (non-vacuity), `sub_floor_rises` (now stated on `decOld`, the pre-fix
counterexample) and `sub_floor_stays`. Mutation-check: `decNew := decOld` in both branches ⇒
`decay_never_rises` (unsolved goal in the r ≤ F case) and `sub_floor_stays` fail. Test:
packages/core/test/formal-apply-budget-decay.test.ts (I6: 2 of 4 failed before; pass after).

Decision I7 applied: delete. `shouldInject` removed from decay.ts. References checked across every
package, docs and examples: only packages/core/test/decay.test.ts used it — its two
`shouldInject` tests were removed with the function (comment left in place). Not exported from the
package entry point (index.ts imports only `reactivate`). CHANGELOG `## Unreleased` notes it.
Test: formal-apply-budget-decay.test.ts "decay.ts no longer exports shouldInject" (failed before).

Decision I3 applied: move. `DEFAULT_MISS_SCORE_THRESHOLD` (telemetry-miss-signal.ts) is now
0.025, strictly between 1/61 ≈ 0.0164 and 2/61 ≈ 0.0328. Why this value: a top hit only one
retrieval leg found scores ≤ 1/61 → `low_score`; a top hit both legs ranked first scores 2/61 →
hit; a hit both legs found stays a hit while its second-leg rank is ≤ 55 (1/61 + 1/116 ≥ 0.025 >
1/61 + 1/117); 0.025 is near the midpoint 3/122 ≈ 0.0246, so neither boundary is within float
noise. Consequence (documented in the source comment and CHANGELOG): with embeddings off there is
one leg, so every non-empty recall's top hit reports `low_score` when telemetry is opted in.
Model §6: `floorNew`, `floorNew_between`, `singleLeg_is_lowScore` (every rank r, any non-zero
count), `bothLegs_top_is_hit` (non-vacuity); the pre-fix `lowScore_unreachable` (floor 0.015) is
kept as the counterexample. Mutation-check: floorNew := 15000 ⇒ `floorNew_between` and
`singleLeg_is_lowScore` fail; floorNew := 40000 ⇒ `floorNew_between` and `bothLegs_top_is_hit`
fail. Tests: packages/core/test/formal-apply-budget-miss.test.ts (I3: 2 of 4 failed before).
Pre-existing test changed: telemetry-miss-signal.test.ts "DEFAULT_MISS_SCORE_THRESHOLD sits just
under a single top-1 RRF hit (~0.0164)" pinned the old value (< 1/61); now asserts 1/61 < floor <
2/61 (renamed accordingly, comment explains).

Decision I5 applied: first. New exported `domainHead` (telemetry-miss-signal.ts) — first dotted
segment, trimmed; absent/empty → null. `buildMissSignalPayload` sends `domainHead(input.domain)`.
Privacy-invariant comment and payload type docs updated. The existing wire-shape test
('trading' → 'trading') is unchanged and still passes. Not modelled (payload shaping, no state).
Tests: formal-apply-budget-miss.test.ts I5 block (3 tests, all failed before).

Decision I2 applied: drop. `renderMemoryBlock` (packages/core/src/memory-block.ts) appends each
section (directives, constraints, consider) whole only if the block with it still fits the room
left after `usedTokens` and the instructions (ceil(chars/4), including the joining newline); a
section that does not fit is dropped whole and a later, smaller one may still be appended; the
heading is emitted only if it fits. Result: output ≤ `tokenBudget − usedTokens` whenever the
instructions alone fit (they are always rendered). The kept slack gates (> 0 / > 100 left) still
apply. Without a budget, output is unchanged (test "no budget … roomy budget renders the same").
Claw twin: packages/claw/src/assembler.ts has no copy — it calls core's `renderMemoryBlock`
(so does opencode), so claw's behaviour is identical by construction; no claw source change.
Docstring rewritten (it claimed "within the token budget"). Model §5: `addIf`, `memBlockNew`,
theorems `memBlockNew_le` (for every section size and slack-gate outcome), `addIf_ge`,
`memBlockNew_replay` (replayed 5469-token input → instructions + heading), and
`memBlockNew_keeps_fitting` (non-vacuity: an over-size middle section dropped, neighbours kept);
pre-fix `memBlock_exceeds_budget` kept. Mutation-check: removing both the per-section fit check and
the final block check ⇒ `memBlockNew_le` fails and the mutant proves the replay input renders
> 499 (`mut_refutes` by decide); removing only the per-section check ⇒ `memBlockNew_replay` and
`memBlockNew_keeps_fitting` fail. Tests: packages/core/test/formal-apply-budget-memblock.test.ts
(4; 3 failed before), packages/claw/test/formal-apply-budget-memblock.test.ts (2, against the
rebuilt core dist). Regression: memory-block 3, claw assembler + context-engine, opencode (80) pass.

## Decisions applied (2026-09-26, ApplyCore) — section 3

- **Decision E5 applied (fold):** `isLocalOnlyScope` (scope-target.ts) compares case-folded, like `isSharedScope`; values are never rewritten. Model: `isLocalOnly` folds via `lower`; `case_drift` replaced by `case_folded` (+ `old_case_drift` counterexample on `isLocalOnlyOld`). Mutation (no fold) ⇒ `case_folded` fails. Not changed: `rescope()`'s own inline target test (`target === 'local' || 'global' || startsWith('project:')`, index.ts) — it decides a WRITE target and folding it would store `GLOBAL`-style scopes; left case-sensitive (see follow-up).
- **Decision E4 applied (config):** `isLocalOnlyScope(scope, stores?)` — `project:*` is local-only only if no url store's scope equals or segment-contains it (`isScopeWithin`, folded). Stores threaded to the two network guards (`feedback`, `forget` remote walks). `assertScopeNamesATarget` still calls it config-free on purpose: a `project:*` scope always names a target (local, or the covering store), so the residue from §3 — `forget(id, {scope:'project:plur/sub'})` with url store `project:plur` — now reaches the covering store instead of "not found in the local store". Model: `covered`, `within`, `isLocalOnly urls s`; theorems `localOnly_project_uncovered` (general), `project_covered_not_localOnly`, `project_localOnly_and_shared` (uncovered case). Mutation (drop `!covered`) ⇒ both fail.
- **Decision E1 applied (me-only, = Q3c):** see writepath.md "Decision E1 applied". Model here: `autoRouteAllowed remote own s = ¬shared ∧ (¬remote ∨ own)`; `autoRoute_leaving_is_own` (general: anything admitted that leaves is own), `autoRoute_me_only` (refuse foreign / admit own / path-backed unchanged / pre-E1 admitted foreign). Mutation (drop the own clause) ⇒ both fail.
- Tests: `packages/core/test/formal-apply-core-scope-family.test.ts` (14; 8 failed before), `formal-apply-core-me-only.test.ts` (9).
- **Decision E6 (leaves): BLOCKED — not applied.** As stated, provenance `withheld` = private ∨ ¬(shared ∨ remote-backed). Every `global`/personal engram is then withheld, including an explicitly `visibility: 'public'` one — and pack export (packs.ts → `buildProvenanceRecord`) is made of exactly those, so every exported pack member's record would carry `odrl:prohibition distribute` and `maySharePlainly: false`: the machine-readable record would forbid distributing the pack it ships in. It also reverses tests that pin the sharing half on purpose (`provenance-tester-round2.test.ts` "leaves a shareable memory alone", `mcp/test/provenance-tool.test.ts` "honours a public visibility" — written because `may_leave_this_machine` "was a constant false carrying no information"). Question for the owner: (a) apply as stated and accept that packs' provenance forbids redistribution; (b) withheld = private ∨ (¬leaves ∧ visibility ≠ public) — an explicit `public` clears it, the location predicate replaces `scope === 'local'` only for non-public engrams; (c) keep `scope === 'local'`.

Decision I1 applied: cap-sum. `selectAndSpread` (packages/core/src/inject.ts): after the section
passes (pinned, constraints floor, directives, constraint slack — unchanged, so they keep
priority), `remainingAfterSections = max(0, maxTokens − directiveTokens)`; the DIP-19 consider
pool is filled with `min(200, remaining)`, spreading with `min(spread_budget, remaining −
considerTokens)`. `tokens_used` (index.ts sums directives + consider, which is the total) is now ≤
`injection_budget`. Docs: `InjectionContext.maxTokens` and `tokens_used` docstrings; a comment at
the change. Model §5: `totalNew`, theorems `total_le_budget` (every section spend ≤ budget, every
spread budget, every candidate list), `total_le_budget_fill`, `total_replay` (replayed 823-token
input → 448) and `total_keeps_pools` (non-vacuity: consider and spread still delivered with room
left); pre-fix `tokens_used_bound`/`tokens_used_exceeds_budget` kept. Mutation-check: the old pool
budgets (200 and spreadB, not capped by the remainder) ⇒ `total_le_budget` (omega) and
`total_replay` fail, and the mutant proves the replay totals > 500 by decide. Tests:
packages/core/test/formal-apply-budget-inject.test.ts (4; 3 failed before: "expected 823 ≤ 500").
Regression: 33 inject/budget/decay/miss/memory-block/plur files, 481 tests pass. Note: the
rendered text per entry is ≤ its charge (`estimate_covers_render`), so the rendered injection
(entries) is within budget too; section headers added by callers are outside this count.

## Decision I4 applied (2026-09-26, ApplyCore): rrf — answers Q7b

- Code (index.ts `_pgliteHybridRecall`): returns `topScore` = the RRF fusion score of the top merged candidate over the same two lists the merge fused (BM25, pgvector), k = 60, captured before the rerank — the same definition `hybridSearchWithMeta` uses (module helper `rrfScoreOf`; `hybrid-search.ts`'s `rrfMerge` is not exported and is not ApplyCore's file). The early-return branches keep their meaning: an empty candidate set still returns `topScore: null` with no results; the fallbacks return `hybridSearchWithMeta`'s score.
- Test: new `packages/core/test/formal-apply-core-pglite-rrf.test.ts` (1; failed before: "PGLite fusion returned a null top score"). Changed: `pglite-vector-scope-dilution.test.ts` "recallHybrid takes the pushdown path, and does not silently fall back" used `topScore === null` as its probe for "the pushdown branch ran"; it now counts permitted rows returned by the (wrapped) `searchVector` call and additionally asserts the score is non-null. Mutation: removing `scopes: restrict?.scopes` from the k-NN call ⇒ that test fails (1 failed | 4 passed); restored ⇒ 5 passed.
- `telemetry-miss-signal.test.ts:60` ("no_results when topScore is null despite a count") is untouched — classifyMiss is unchanged; PGLite simply no longer feeds it null.
- Model: §7's `pglite_null_is_noResults` describes the pre-decision PGLite input; §7 belongs to ApplyBudget's sections, so it is NOT edited here — the coordinator should re-label it as the pre-I4 counterexample.
