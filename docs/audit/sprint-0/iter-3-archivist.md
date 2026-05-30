# Sprint 0 Audit — Iter 3 — Archivist verification

HEAD: `fbfa870` (merge of audit/iter-2-fixes, PR #274). Verifying that the
iter-2 commits actually closed the iter-1 archivist findings.

## Verdict

**SHIP_WITH_FIXES** — iter-2 closed every iter-1 finding either by code
change or explicit deferral; remaining items are documentation polish and
engram updates that should land before the epic→main PR but don't block
ship. No new architectural drift introduced. No locked engram is violated
by HEAD.

## Iter-1 finding closure

| Finding | Status | Evidence |
|---|---|---|
| F-ARCH-001 default backend = `'sqlite'` contradicts ADR-0001 | **CLOSED** | `packages/core/src/index.ts:255` returns `'pglite'` from `_resolveBackend()` (env → config → default). JSDoc at `index.ts:240-248` explicitly cites ADR-0001 + iter-2 M-3. SQLite path stays opt-in via `PLUR_BACKEND=sqlite`. CHANGELOG "PGLite is the default backend" section (l.13-17) documents the one-minor-version deprecation flag. Commit `38b7c39 fix(audit-iter-2): M-3 default backend = pglite`. |
| F-ARCH-002 missing per-feature micro-benchmarks (PRs 1-4) | **DEFERRED to Phase D** | iter-1-gaps-consolidated.md "Methodology fix" block (l.73-77): "run micro-benchmarks retroactively on each merged feature commit". Not landed in iter-2. `benchmark/results/sprint-0/` still contains only `feat-embedding-gemma-default.json`. Acceptable as iter-2 scope was code BLOCKERs (B-1/B-2/B-3) + surgical MAJORs (M-1..M-7); retro-bench is a Phase D activity. |
| F-ARCH-003 PR 4 bake-off at N=5, treated as Sprint 0 evidence | **CLOSED for now, deferred for real numbers** | The default-flip the N=5 evidence supported is reverted (B-2). Bake-off doc TL;DR (l.7-20) explicitly says "the default-flip to EmbeddingGemma was reverted. BGE-small is the v0.10 default ... the iter-1 audit concluded the N=5 fixture cannot justify the swap". "Decision" section (l.130-141) and "Phase C — deferred" section (l.150-161) both call out the deferral and the methodology fix (real LongMemEval-S import vs honest N=30/100-reps framing). Commit `7b4bc7e fix(audit-iter-2): B-2 revert default embedder to bge-small + M-7 doc drift`. |
| F-ARCH-004 PR 1 TDD red/green not split | **PROCESS — won't fix retroactively** | iter-1 itself notes "PR 1 is 'tests only', which arguably collapses the red/green distinction". The single-commit pattern is now in the git record; rewriting history post-merge would be net negative. The precedent should be documented for the next test-only PR. Filing as a NIT-level engram update (see below) is sufficient. |

## Engram alignment re-check

| Engram | Status now | Notes |
|---|---|---|
| ENG-2026-0530-019 YAML-as-truth invariant | **RESPECTED** | Both backends now run the YAML-truth Test A (`yaml-truth-rebuild.test.ts`) and Test B (`yaml-truth-traceability.test.ts`); iter-2 M-1 parameterized both over `PLUR_BACKEND` so the invariant is policed for `indexed` AND `pglite`. M-2 added adversarial Test B that inserts directly into PGLite and asserts no public method surfaces it. `storage-pglite.ts:1-25` header still names YAML as source of truth. Commit `c445716`. |
| ENG-2026-0530-020 EmbeddingGemma default | **PARTIALLY STALE — needs an update note** | The engram statement still describes EmbeddingGemma as the planned new local default. After iter-2 B-2 the v0.10 default reverted to bge-small. The engram's "Bake-off ... in Sprint 0 confirms or contradicts" clause was met procedurally and the result was *contradiction at the available N* — the engram should be updated (not retired) to record: (a) default deferred to Phase C; (b) EmbeddingGemma remains a first-class adapter; (c) the ≥2pp R@5 gate from the plan is the gate, and N=5 cannot exercise it. Recommend `plur_learn` with `update_engram: ENG-2026-0530-020`. |
| ENG-2026-0530-029 Sprint 0 autonomous pipeline | **RESPECTED** | Stages 1-5 ran end-to-end for all 5 features. Stage 6 (multi-evaluator audit loop) iter 1 + iter 2 + this iter 3 are in `docs/audit/sprint-0/`. Stage 4 (per-feature micro-benchmark) remains the open item — acknowledged in iter-1-gaps-consolidated and deferred to Phase D. The engram's stage list is intact; only the "ran for every PR" expectation has a known exception (PR 1 + PRs 2-4 micro-benchmarks). |
| ENG-UPL-2026-05-30-001 branch-per-feature | **RESPECTED** | iter-2 followed the same model — all fixes landed on `audit/iter-2-fixes` (5 fix commits + 2 test/doc commits), then a single PR (#274) merged into main. No direct-to-main writes. `git log --oneline -20` confirms the merge commit shape. |

## Documentation drift cleanup

- **CHANGELOG**: ✓ **consistent**. "Unreleased / Sprint 0" (l.3-37) accurately describes the iter-2 state: PGLite as default backend, bge-small as default embedder, dim-aware JSON cache, parameterized YAML-truth tests. The bake-off-as-evidence framing from the iter-1 critique is gone — the deferred decision is named explicitly with a pointer to `iter-1-gaps-consolidated.md`.

- **bake-off doc** (`docs/benchmarks/embedder-bake-off-2026-05.md`): ✓ **flags deferred decision**. TL;DR opens with the iter-2 update (l.7-20). "Decision" section (l.130-141) splits "Original (PR 4)" vs "Iter-2 audit (B-2)". "Phase C — deferred" section (l.150-161) calls out both methodology options (real LongMemEval-S vs honest reps framing).

- **PGLiteAdapterOptions JSDoc** (`storage-pglite.ts:100-107`): ✓ **accurate now**. Says "Default: 384 (matches the v0.10 default embedder bge-small per iter-2 audit B-2 revert)". `DEFAULT_VECTOR_DIM = 384` at line 43 with explanatory JSDoc (l.34-42) citing the iter-2 revert. Drift between line 41 (was 768) and the comment (was 384) is fully reconciled.

- **doctor.ts:577 fix-it advice**: ✓ **accurate now**. Lines 580-585 read: "Default is BGE-small-en-v1.5 (~130MB); override with PLUR_EMBEDDER=embedding-gemma (~325MB) or bge-base." Both numbers correct for the current default. Adjacent live-name surface at `doctor.ts:558` ("Active embedder: ${report.activeEmbedder}") names the live name even when the default changes.

- **embeddings.ts:115-117 comment** (was F-ARCH-005 in iter 1): ✓ **accurate now**. Lines 119-122 read: "Default is bge-small (Sprint 0 iter-2 B-2 revert) when the env var is unset". Reconciled with the active default.

- **sprint-0-plan.md**: ⚠ **slightly stale, not blocking**. The plan still reads "PR 5 — EmbeddingGemma-300M (int8) wired as the default" (l.101) and "LongMemEval R@5 ≥ 95% local with EmbeddingGemma default" as exit criteria (l.170). Both are no-longer-true for v0.10 — the default reverted, the exit criterion was not met on real LongMemEval-S. A short "Iter-2 audit revisions" addendum to the plan (or a frontmatter `status:` change from `in-flight` to `iter-2 revised`) would close the loop. Plan also still names yaml-as-truth-tests as PR 1 → correct order (matches what shipped).

- **packages/plur/CLAUDE.md**: Not present in repo (was in iter-1's drift list). The actual file is `CLAUDE.md` at repo root, which still names `BGE-small-en-v1.5` as the embeddings model on `packages/core/src/embeddings.ts` — **accurate again** after B-2 revert.

- **No in-tree plan pointer** (was F-ARCH-011): still open. Plan lives outside the repo. Either copy into `docs/specs/sprint-0-plan.md` or add a permalink note to CHANGELOG. Not blocking.

- **Audit log structure** (was F-ARCH "no iter-N.md index" in iter 1): ✓ **resolved**. iter-1 outputs landed as `iter-1-{archivist,critic,cto,data,dijkstra}.md` plus `iter-1-gaps-consolidated.md`. iter-3 (this file) follows the same convention.

## Phase C readiness

- **Bake-off doc deferral wording**: ✓ The decision is explicitly named "deferred to Phase C" in three places (TL;DR l.10-15, Decision section l.130-141, Phase C — deferred section l.150-161).
- **Methodology fix called out for Phase C kickoff**: ✓ "Phase C must either (a) import the upstream LongMemEval-S dataset into `benchmark/data/longmemeval-s.yaml` and re-run, or (b) honestly publish 'n=30 source, 100 reps' with the bootstrapped confidence intervals." Same wording in `iter-1-gaps-consolidated.md` l.76-77.
- **Default-flip gate restated**: ✓ "Default-flip happens after Phase C produces evidence that meets the gate rule." Maps cleanly to the plan's "≥2pp R@5 at or below CPU cost" criterion.

Phase C kickoff has a clean handoff. Nothing in the iter-2 changes prevents either methodology option from running.

## New findings

- **[F-ARCH-NEW-001] MINOR — `sprint-0-plan.md` PR 5 spec + exit criteria are stale.** The plan still says EmbeddingGemma is the default and that R@5 ≥ 95% local with EmbeddingGemma is the exit criterion. Both contradict iter-2's B-2 revert. Recommend either (a) add a frontmatter `revisions:` block citing the iter-2 audit, or (b) inline-edit PR 5 and the exit-criteria block with strikethrough and the new default. Plan is the single document a future contributor reads to understand "what we said we'd do" — keeping it accurate is institutional context hygiene.

- **[F-ARCH-NEW-002] NIT — ADR-0001 status reconciliation.** iter-1 flagged ADR-0001 saying "Accepted, SQLite dropped" while code shipped sqlite-as-default. After iter-2 M-3 the ADR and code agree again. If ADR-0001 has a v3 status field, it can stay "Accepted" without amendment. If it was redrafted between iter-1 and iter-2, link the new revision from the CHANGELOG so external readers can follow the chain.

- **[F-ARCH-NEW-003] NIT — Plan doc references `engram_suggestions` ENG-UPL-2026-05-30-001 that is not in `~/.plur/engrams.yaml`.** iter-1 cited it as "RESPECTED". Could be in a project store (`5-plur/.plur/`) or a personal store; could also be a typo in iter-1 (intended ENG-2026-0530-001 or similar). Worth a `plur_recall_hybrid "branch-per-feature"` to confirm the engram exists and update the citation if the ID drifted.

## Recommended engram updates (flag — not the archivist's job to write)

1. **Update ENG-2026-0530-020** (`plur_learn` with the existing ID): change "**EmbeddingGemma-300M (int8 quantized)** as the new local default" to acknowledge that the v0.10 default reverted to bge-small pending Phase C real LongMemEval-S evidence, and reaffirm that EmbeddingGemma remains a first-class opt-in adapter. Cite iter-1-gaps-consolidated.md RC-2 + iter-2 audit B-2.

2. **New engram — "Test-only PRs collapse TDD red/green"** (process precedent): one short engram capturing the rule that PRs whose entire content is `*.test.ts` files (no production code change) ship as a single commit; otherwise the per-feature pipeline (ENG-2026-0530-029 stage 2-3) requires distinct red + green commits. Closes F-ARCH-004 as institutional context rather than a fix.

3. **New engram — "Bake-off fixture size gate"** (methodology): no statistical claim against the plan's ≥2pp R@5 gate may be drawn from <100 distinct scenarios per category; the 30-scenario fixture is for smoke tests, not decisions. Belongs in the benchmark methodology pack.

4. **Optional — link engram between ENG-2026-0530-029 and the audit-log convention** in `docs/audit/sprint-0/`. The "Logs: each iteration committed under `docs/audit/sprint-0/iter-<N>.md`" line in the plan now has real artifacts; capture the convention as a separate engram (DIP-style) so future epics inherit it.

## Closing assessment

iter-2 was a clean, surgical close on the iter-1 audit. The two BLOCKERs the consolidated gaps doc named (B-1: PGLite ghost; B-3: dim-unaware JSON cache) plus B-2 (revert default embedder) are resolved in code; M-1, M-2, M-3, M-4, M-5, M-6, M-7 are resolved in code and doc surface; the deferred items (per-feature micro-benchmarks for Phase D, real LongMemEval-S for Phase C) are explicitly named in the bake-off doc and CHANGELOG with the methodology fix called out for the Phase C kickoff.

The architectural intent of the four locked engrams (019 YAML-as-truth, 020 EmbeddingGemma plan, 029 autonomous pipeline, ENG-UPL-2026-05-30-001 branch-per-feature) is now matched by both code and documentation. ENG-2026-0530-020 is the only engram that needs an update — its `statement` predicts a default flip that didn't happen at v0.10; the engram should be amended to record the deferred decision and the gate.

Remaining items are documentation polish (sprint-0-plan.md addendum, ADR-0001 status reconciliation if needed, the missing engram updates flagged above). None block the epic→main PR. The recommended sequence: land an `sprint-0-plan.md` revisions block, then run the three `plur_learn` updates above, then open the epic→main PR.

The Sprint 0 substrate ships. The Phase C bake-off is a separate work item with a clean handoff.
