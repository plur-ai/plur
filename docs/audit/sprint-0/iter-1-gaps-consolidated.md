# Sprint 0 Audit — Iter 1 Consolidated Gaps

## Verdicts

| Evaluator | Verdict | Severity Tally |
|---|---|---|
| Dijkstra | SHIP_WITH_FIXES | 0 BLOCKER · 5 MAJOR · several MINOR/NIT |
| CTO | SHIP_WITH_FIXES | 2 BLOCKER · 7 MAJOR · 6 MINOR · 3 NIT |
| Data | SHIP_WITH_FIXES | 0 BLOCKER · 4 MAJOR · several MINOR |
| Archivist | SHIP_WITH_FIXES | 0 BLOCKER · 4 MAJOR · several MINOR |
| Critic | **BLOCK** | many concrete failure scenarios |

**Decision**: Critic blocks, two BLOCKERs from CTO converge on the same root causes, four of five evaluators agree on the failure modes. Mandatory iter 2.

## Root causes (the three issues every evaluator hit)

### RC-1 — PGLite is a write-only ghost

- CTO F-CTO-001, Data F-DATA-002, Critic concern #1, Dijkstra F-DIJK-003, Archivist F-ARCH-001 spirit drift.
- `_filterEngrams` (`packages/core/src/index.ts:1224-1262`) never reads `pgliteAdapter`.
- `learn()` never auto-calls `upsertEmbedding`. The substrate is mirrored on write and never queried.
- `PLUR_BACKEND=pglite` today is strictly worse (extra I/O, zero read-path benefit).

### RC-2 — Default embedder flip is unsafe and unjustified

- CTO F-CTO-002, Critic concern #3, Archivist F-ARCH-003.
- Bake-off ran on 30-scenario fixture with replacement sampling. N=500 just resamples the 30. Not real LongMemEval-S.
- EmbeddingGemma loses on R@1 (43.3% vs MiniLM 50%), ties on R@5, costs 2.4x peak RSS and 11x p99 latency.
- Plan's gate "≥2pp R@5 at or below CPU cost" not met; PR 5 spec exit "R@5 ≥ 95% local" not met.

### RC-3 — Production embeddings cache is dim-unaware

- Data F-DATA-003, Critic concern #2.
- `.embeddings-cache.json` is keyed by `engramId + statementHash`. No embedder or dim metadata.
- `cosineSimilarity` iterates `Math.min(a, b)` — mixed dims silently return garbage.
- `plur sync --reembed` is a no-op when `PLUR_BACKEND` isn't pglite. The default user (~99% of installs) has no migration story.

## Must-fix list (iter 2 scope)

### BLOCKERs

1. **B-1 (closes RC-1, RC-3)** — Wire PGLite into recall AND/OR make production cache dim-safe.
   - Either: route `recallHybrid` through `pgliteAdapter.searchVector` when PGLite is active, plus auto-call `upsertEmbedding` on `learn()`. Then make PGLite the default per ADR-0001.
   - And/Or: stamp `.embeddings-cache.json` with `embedder_name + dim`; on mismatch, invalidate and rebuild.
   - Either path closes the "switch backends or embedders without breaking recall" gap. Both is even better.

2. **B-2 (closes RC-2)** — Revert default embedder to `bge-small` until Phase C real LongMemEval-S evidence justifies otherwise.
   - This is a 1-line factory change. `bge-small` is the current production default; reverting is zero-risk.
   - Document the deferred decision in `docs/benchmarks/embedder-bake-off-2026-05.md` and CHANGELOG.

3. **B-3 (closes RC-3 for default users)** — Make `plur sync --reembed` work for the legacy `.embeddings-cache.json` path.
   - Detect dim mismatch in the JSON cache, invalidate on mismatch, rebuild from active embedder.
   - Wire `plur doctor` warning to fire for the JSON cache path too, not just PGLite.

### MAJORs (do in iter 2 if not large)

4. **M-1** — Make YAML-truth tests actually exercise PGLite: parameterize Test A + B over `PLUR_BACKEND` and assert both backends pass.
5. **M-2** — Add an adversarial Test B variant: insert directly into PGLite, confirm no public method surfaces it.
6. **M-3** — Default `backend` in `Plur` constructor: change `'sqlite'` to `'pglite'` (Archivist F-ARCH-001, ADR-0001 alignment).
7. **M-4** — `vectorLiteral` (`storage-pglite.ts:544`) — throw on NaN / Infinity instead of substituting 0.
8. **M-5** — `percentile()` in `benchmark/run.ts:196` — fix off-by-one: `floor((p/100)*(len-1))`.
9. **M-6** — Reembed transactionality: instead of dropping the column first, create a new column populated, then atomic swap. Or add a resume marker for crash recovery.
10. **M-7** — Doc drift — `PGLiteAdapterOptions.vectorDim` JSDoc says default 384, code says 768. Multiple places still mention `bge-small` as default (which becomes correct again after B-2). Update doctor.ts:577 ("BGE-small-en-v1.5 ~130MB" wording).

### MINORs / NITs

- M-8: EmbeddingGemma pooling — model trained with task prompts + last-token pooling. Verify the adapter matches the model card. Less urgent if B-2 reverts the default.
- M-9: OpenAI adapter — add timeout + retry + 8191-token input length check.
- M-10: AsyncMutex.run order-of-operations clarity (Dijkstra F-DIJK-002) — comment-level fix.
- M-11: `Plur.sync({reembed})` swallows errors; CLI reports success on failure.
- M-12: 10s embedder probe timeout in doctor too short for 325MB cold download.

## Methodology fix (separate from code fixes)

**F-ARCH-002** — Per-feature micro-benchmarks missing for PRs 1-4. The Phase D "per-feature contribution decomposition" required by the plan cannot be computed without them. **Decision**: run micro-benchmarks retroactively on each merged feature commit and capture in `benchmark/results/sprint-0/<feature>.json`. Cheap if the harness's micro mode works against arbitrary commits.

**F-ARCH-003 + Critic spec-drift** — Phase C needs real LongMemEval-S 500/category. Either fetch from the source dataset or run 100 reps of the 30-scenario fixture with explicit "n=30 source, 100 reps" framing in the report. The first is correct, the second is honest. Defer choice to Phase C kickoff.

## Recommended iter 2 plan

Single coordinated implementation agent handles B-1 through M-7. Smaller MAJORs (M-8 through M-12) are filed as follow-on issues unless cheap. M-3 and B-2 land first because they're surgical and unblock everything else. B-1 is the heaviest item.

After iter 2 lands, re-run all 5 evaluators (iter 3). Continue until SHIP consensus or iter cap (10).
