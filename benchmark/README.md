# PLUR Benchmarks

Two benchmark suites for PLUR development.

## 1. LongMemEval (`run.ts`) — Retrieval Quality

Tests PLUR's memory retrieval across 6 categories. Two corpora ship with the harness:

- **`fixture`** (default) — 30-scenario hand-curated set (`data/scenarios.yaml`).
  Backward-compatible with everything written before Sprint 0.
- **`longmemeval-s-smoke`** — 30-scenario subset (5/category) of the *real*
  LongMemEval-S. Committed; sessions trimmed to keep YAML <3 MB.
- **`longmemeval-s`** — the full official LongMemEval-S corpus (500 questions,
  Wu et al, 2024 — [arxiv.org/abs/2410.10813](https://arxiv.org/abs/2410.10813)).
  Gitignored because the converted YAML is ~260 MB; regenerate locally with:

  ```bash
  huggingface-cli download xiaowu0162/longmemeval --repo-type dataset \
    --local-dir benchmark/data/longmemeval-source/
  npx tsx benchmark/scripts/import-longmemeval.ts
  ```

```bash
npx tsx benchmark/run.ts                                          # fixture (default), hybrid
npx tsx benchmark/run.ts --search-mode bm25                       # BM25 only
npx tsx benchmark/run.ts --search-mode semantic                   # embeddings only
npx tsx benchmark/run.ts --category temporal_reasoning            # single category
npx tsx benchmark/run.ts --corpus longmemeval-s --iterations 5    # real corpus, 5/category
npx tsx benchmark/run.ts --corpus longmemeval-s-smoke             # committed real subset
```

## 2. Micro-benchmark (`micro.ts`) — Per-Operation Latency

Measures `learn()`, `recall()`, `recallHybrid()`, `inject()` latency for regression detection between branches.

```bash
# Run on each branch you want to compare:
git checkout main
npx tsx benchmark/micro.ts --label main --iterations 100

git checkout other-branch
npx tsx benchmark/micro.ts --label other-branch --iterations 100

# Compare two labeled runs:
npx tsx benchmark/micro.ts --compare main other-branch
```

Outputs mean, p95, p99, min, max for each operation. Tests:
- `learn()` write-path latency
- `recall()` BM25 latency
- `recallHybrid()` BM25+embeddings latency
- `inject()` latency + token count
- Dedup decisions on intentional near-duplicates (tests `learnAsync()` if available)

**Use this BEFORE merging any branch that touches the core API.**

## Categories

| Category | Tests |
|----------|-------|
| single_session_user | Personal facts from one conversation |
| single_session_preference | Stated preferences |
| single_session_assistant | What the assistant said/did |
| temporal_reasoning | Time-based queries, event ordering |
| knowledge_updates | Newer facts override older ones |
| multi_session_reasoning | Connecting info across conversations |

## Metrics

- **Hit@K**: Is the correct engram in the top K results?
- **MRR**: 1/rank of the first correct result
- **Accuracy**: All expected keywords found in top 10 results

## Results

Saved to `benchmark/results/YYYY-MM-DD-{mode}.json`.

Compare runs: check the per-category breakdown for regressions.
