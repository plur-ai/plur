# Apply phase — 2026-09-26

Owner said "apply the decisions". Decisions: `decisions.resolved.yaml` (derived from four principles; `DECISIONS.md` has the full options).
Snapshot of the verified pre-apply tree: session scratchpad `snapshot-verified-2026-09-26/` (tracked.patch + untracked.tar).
Three apply agents, disjoint files. Findings entries get "Decision <id> applied: …".

## ApplyCore — owns packages/core/src/index.ts, scope-routing.ts, scope-util.ts, scope-target.ts, session-scopes.ts, content-fields.ts, store/remote-store.ts, provenance.ts
Rows: E1 me-only · E4 config · E5 fold · E6 leaves · E7 core sentinel · D1 queue-retire · D3 no-widen · D4 like-rescope · I4 rrf
Contract for E7 (ApplySurface builds against it): export `NO_SESSION` from @plur-ai/core (session-scopes.ts). A learn/inject whose context.session === NO_SESSION uses NO session default — neither a keyed registration nor the process-default slot — so an unscoped write falls to the unscoped path (auto-route/unscoped_default, scope_source 'routed'/'default').

## ApplyBudget — owns packages/core/src/inject.ts, memory-block.ts, telemetry-miss-signal.ts, decay.ts, store/async-lock.ts, engrams.ts, backup.ts, packages/claw/src/ (memory-block twin only); may edit packages/core/test/backup.test.ts and telemetry-miss-signal.test.ts where a decision changes pinned behaviour
Rows: I1 cap-sum · I2 drop (claw twin identical) · I3 move · I5 first · I6 above-floor · I7 delete shouldInject · P1 heartbeat · P2 last-written · P3 engram_created only

## ApplySurface — owns packages/mcp/src/, packages/dsh/src/, packages/cli/src/ (commands/scopes.ts, doctor.ts, learn.ts, plur.ts, hook-inject.ts, hook-codex-inject.ts, hook-cursor-session-start.ts, hook-agy-pre-invocation.ts), packages/python/plur_ai/ (bridge.py, client.py); may edit packages/cli/test/scopes.test.ts and packages/mcp/test/server.test.ts where a decision changes pinned behaviour
Rows: E2 reword · E3 opencode rule everywhere · E7 MCP side (uses NO_SESSION) · S1 exit1 · S2 single · S3 hard-cap · S4 apply the three blocked fixes

## Not code (coordinator, owner's go needed before filing): GitHub issues for P4 pack hash v2, P5 pack registry key, D2 outbox lease.

## ApplyBudget — done, verified by coordinator (2026-09-26)
All 9 rows APPLIED. Coordinator re-check: ScopeInject.lean + Persistence.lean `lake env lean` clean, no gaps; 7 new test files 36/36 pass; mutation check (remove the consider/spread caps in inject.ts:912,918) → 3/4 budget tests fail, restored → 4/4.
Existing tests changed by decision: decay.test.ts (shouldInject tests removed, I7), telemetry-miss-signal.test.ts (floor now between 1/61 and 2/61, I3), backup.test.ts (engram_learned → engram_created, P3).
Follow-ups:
- `plur sync` rewrites engrams.yaml via git, not saveEngrams → a pull that removes >10% skips one day's backup until the next PLUR write. Record the count after a pull too? (sync.ts)
- I3 consequence: with embeddings off there is one retrieval leg, so every non-empty recall reports low_score (opt-in telemetry only). Skip low_score in BM25-only mode? (index.ts — after ApplyCore finishes)
- Heartbeat guarantee assumes the 30 s git timeout < staleThreshold − touch interval; warn on a custom staleThreshold below ~45 s?
- heartbeat helpers exported from async-lock.ts but not from the package entry point — intended.

## ApplyCore — done, verified by coordinator (2026-09-26)
APPLIED: E7 (NO_SESSION), E1 me-only, E4, E5, D1, D3, D4, I4. BLOCKED: E6.
Coordinator re-check: WritePath.lean + ScopeInject.lean clean, no gaps; 6 new test files 40/40; mutation check (`_refuseRemotePersonalAutoRoute` → false) → 5/9 me-only tests fail, restored → 9/9.
Existing tests changed by decision: formal-writepath-route (pinned pre-E1 policy), remote-routing "reports routed…" (now answers /me first), pglite-vector-scope-dilution (used topScore===null to detect the pushdown path; I4), formal-writepath-outbox-scope (pre-D4 precondition).
E6 BLOCKED — the coordinator's suggestion ("leaves") was wrong: withholding everything that doesn't leave the machine withholds global/personal engrams marked `public`, so every exported pack's provenance would forbid distributing the pack it ships in, and it reverses two tests that pin sharing on purpose. Row reverted to "keep" (no change); follow-up issue to define `withheld` properly.
E1 own-namespace rule: `user:<username>` or `user:<org_id>:<username>` from /me; consistent with the live `user:<org>:<username>` scope shape. Unknown identity → refused (fail closed).
Follow-ups: rescope's inline local-family check is still case-sensitive (deliberate); list retire-on-remote entries in plur_outbox?; plur_suggest_scope wording for a refused remote personal scope; relabel ScopeInject §7 `pglite_null_is_noResults` as a pre-I4 counterexample.

## Gap closure — 2026-09-26 (coordinator)
- E3 residue: `hook-codex-session-start` now uses `trustedProjectScope` + emits the notice. Test `packages/cli/test/formal-gaps-codex-session-start.test.ts`: untrusted case failed before, 2/2 after.
- S4 residue: `cli/src/index.ts` help/version check stops at `--`. Test `packages/cli/test/formal-gaps-argv-help.test.ts`: 4/5 failed on HEAD's index.ts, 5/5 after.
Owner goal set 2026-09-26: "all gaps are closed and issues from the audit applied".
