# PLUR v0.2.1 on LongMemEval — reference measurement

**Status:** reference write-up for a measurement cited across the project (`CLAUDE.md`, `README.md`, each package `README.md`, `docs/enterprise/plur-enterprise-proposal.md`). Produced to satisfy the Phase 2 self-calibration gate prerequisite in [`docs/benchmarks/phase2-methodology.md`](../benchmarks/phase2-methodology.md) → *Open questions / TBD* → *PLUR v0.2.1 reference write-up*. Tracks [PR #47](https://github.com/plur-ai/plur/pull/47) / [issue #46](https://github.com/plur-ai/plur/issues/46).

**Last updated:** 2026-04-23.

## The number we cite

| Metric | Score | Citations |
|--------|-------|-----------|
| LongMemEval overall (Opus hybrid, n=30) | **86.7%** | `CLAUDE.md`, `README.md`, `packages/*/README.md`, `docs/enterprise/plur-enterprise-proposal.md` |
| Hit@10 (retrieval) | **93.3%** | `CLAUDE.md`, `packages/core/README.md` |

These two numbers are the headline claim for PLUR's retrieval quality. They gate Phase 2's self-calibration rule ([F5](../benchmarks/phase2-methodology.md#f5-self-calibration-gate--proposed-3pp-published-first-fix-harness-before-publish-others)): the Phase 2 harness must reproduce the overall accuracy within 3 percentage points before any competitor number is published.

## Methodology — as originally run

The v0.2.1 number was produced against LongMemEval by the `memorybench` test harness (a sibling repository, not in this repo), invoked as documented in `CLAUDE.md`:

```
# From a memorybench checkout (not in this repo)
PLUR_SEARCH_MODE=hybrid python run.py --provider plur
```

Configuration at time of measurement:
- **PLUR version:** v0.2.1.
- **Corpus:** LongMemEval 30-question sanity subset covering six categories (`single_session_user`, `single_session_preference`, `single_session_assistant`, `temporal_reasoning`, `knowledge_updates`, `multi_session_reasoning`).
- **Search mode:** `hybrid` (BM25 + BGE-small-en-v1.5 embeddings + Reciprocal Rank Fusion).
- **Rerank / judge model:** Anthropic Claude Opus ("Opus hybrid" in `CLAUDE.md`).
- **Embedding model:** BGE-small-en-v1.5 local (no API calls).
- **Hardware:** not recorded at the time. Best-effort recovery flagged under *Gaps* below.

## Reproducibility — where the artifact sits today

The raw run artifact for the 86.7% / 93.3% measurement is **not archived in this repository**. Specifically:

- `benchmark/results/` does not contain a hybrid run whose overall accuracy is 86.7%. Its closest in-repo hybrid run is `baseline-main-hybrid.json` (2026-04-06): **83.33% accuracy, 96.67% Hit@10, n=30**. That is 3.4 pp below the cited overall, which is **just outside the proposed 3 pp self-calibration gate** — so they are not interchangeable.
- `benchmark/run.ts` in this repo supports only `hybrid | bm25 | semantic` modes; an "Opus hybrid" / agentic-rerank mode is not exposed by the in-repo runner. The 86.7% run was produced by the external `memorybench` harness; the in-repo runner is a separate instrument.
- `CLAUDE.md` is the only place inside this repo where the 86.7% / 93.3% pair is stated as a primary claim; every `README.md` copy cites it rather than re-measures it.

In short: the claim is widely propagated, the artifact is not. This document's purpose is to make that state legible, not to paper over it.

## Closest in-repo reproducible number

For readers who want to reproduce *something* today with only this repo checked out:

```
npx tsx benchmark/run.ts --search-mode hybrid
```

| Metric | In-repo hybrid (2026-04-06) | Claimed v0.2.1 (Opus hybrid) | Δ |
|--------|-----------------------------|------------------------------|----|
| Overall accuracy | 83.33% | 86.7% | **−3.4 pp** |
| Hit@10 | 96.67% | 93.3% | +3.4 pp |
| MRR | 0.612 | (not recorded) | — |
| n | 30 | 30 | — |

Observation: the in-repo hybrid run has *higher* Hit@10 and *lower* overall accuracy than the cited Opus-hybrid number. That shape is consistent with agentic rerank moving borderline candidates into the top-1 (raising overall accuracy that measures a stricter match) while the unranked candidate set is already present in the top-10 under pure hybrid RRF. This is suggestive, not confirmation.

Per-category breakdown for the in-repo hybrid run is in [`benchmark/results/baseline-main-hybrid.json`](../../benchmark/results/baseline-main-hybrid.json).

## Gaps to close before the Phase 2 gate activates

The Phase 2 [self-calibration gate](../benchmarks/phase2-methodology.md#f5-self-calibration-gate--proposed-3pp-published-first-fix-harness-before-publish-others) as currently drafted references this document as the prior-measurement citation. For that reference to be safe to gate against, one of the following must land:

1. **Archive the original 86.7% / 93.3% run artifact.** Re-run the `memorybench` / Opus-hybrid invocation against PLUR v0.2.1 on the same 30-Q subset, and commit the raw per-query result JSON into this repo (proposed path: `benchmark/results/v0.2.1-opus-hybrid.json`). This makes the reference number reproducible and gives the harness a concrete target.

2. **Restate the reference against the in-repo hybrid run.** If re-running the Opus-hybrid pipeline is out of scope, update `CLAUDE.md`, each `README.md`, and the enterprise proposal to cite **83.33% / 96.67% (in-repo hybrid, BM25+BGE RRF, n=30)** instead of 86.7% / 93.3%, and update the Phase 2 gate to target the restated number. The 3 pp gate would then be measured against 83.33%.

3. **Narrow the gate to Hit@10 only** and measure the harness against 96.67% (the in-repo number), which is stable and reproducible today. Overall accuracy would become a secondary reporting column rather than the gate.

Option (1) is the cleanest — it keeps the published claim and makes it defensible. Option (2) is the most honest if an Opus re-run is impractical. Option (3) is a middle path and may be attractive if the gap is mostly explained by agentic rerank behavior that Phase 2 will not attempt to reproduce identically.

**Decision required by:** before the Phase 2 harness scaffold PR lands (see PR #47 checklist). Owner: cto role.

## What changed between v0.2.1 and today

This document fixes v0.2.1 as the reference point. Subsequent versions have added features (session enforcement, Exchange, postinstall wiring) that do not change the search pipeline materially. Any measurement of the same subset on a post-v0.2.1 build is expected to be within noise of v0.2.1; deviations >3 pp should be investigated before the number is updated here.

## Open questions

- **LongMemEval subset composition.** The 30-Q subset used for v0.2.1 was constructed for fast iteration; its question-ID list should be archived alongside the raw result JSON so Phase 2 can use the same instance. Current subset is implicitly defined by `benchmark/data/scenarios.yaml`; that file should be referenced as the canonical subset pinned for v0.2.1.
- **Embedding model pin.** `BGE-small-en-v1.5` is the current default; the v0.2.1 run predates any change here. If the local embedding model is swapped, this reference must be re-run.
- **LongMemEval licensing.** LongMemEval's corpus is CC-BY-NC-4.0. We redistribute a *processed derivative* (our `benchmark/data/scenarios.yaml`) under the same non-commercial terms with attribution. The full-set Phase 2 run will carry the same licensing note. A separate TBD item in [`phase2-methodology.md`](../benchmarks/phase2-methodology.md#open-questions--tbd) tracks the full licensing write-up.

## Honest framing (summary)

The 86.7% / 93.3% number is:
- **Cited as a primary claim** across project docs.
- **Not archived as a raw artifact** in this repository.
- **Not identical** to the closest in-repo hybrid run (which is 83.33% / 96.67%).
- **Gate-relevant** — the Phase 2 harness gate needs a defensible reference it can reproduce within 3 pp.

The safest next step is to re-run the Opus-hybrid pipeline against v0.2.1 and archive the raw results here, then revisit this doc with the committed JSON as the single source of truth.
