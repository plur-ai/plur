# PLUR Benchmarks

Two benchmark suites for PLUR development.

## 1. LongMemEval (`run.ts`) — Retrieval Quality

Tests PLUR's memory retrieval across 6 categories. Three corpora:

- **`fixture`** (default) — 30-scenario hand-curated set (`scenarios.yaml`).
  Backward-compatible with everything written before Sprint 0.
- **`longmemeval-s-smoke`** — 30-scenario subset (5/category) of the *real*
  LongMemEval-S. Sessions trimmed to keep YAML <3 MB.
- **`longmemeval-s`** — the full official LongMemEval-S corpus (500 questions,
  Wu et al, 2024 — [arxiv.org/abs/2410.10813](https://arxiv.org/abs/2410.10813)).
  ~260 MB converted; regenerate locally with:

  ```bash
  huggingface-cli download xiaowu0162/longmemeval --repo-type dataset \
    --local-dir benchmark/data/longmemeval-source/
  npx tsx benchmark/scripts/import-longmemeval.ts
  ```

### Where the data lives (#336)

Corpus files and result runs are **not** committed to this repo — the code repo
is code-only. Canonical home is the private
[`plur-ai/plur-bench`](https://github.com/plur-ai/plur-bench) repo:
fixtures under `corpus/monorepo/`, archived monorepo result runs under
`results/monorepo/`. `benchmark/data/` and `benchmark/results/` here are
gitignored working directories.

The harness resolves a corpus file in this order (first hit wins):

1. `--data-dir <dir>` flag (exclusive — no fallback when set)
2. `PLUR_BENCH_DATA_DIR=<dir>` env var (exclusive)
3. repo-local `benchmark/data/<file>` (dev convenience)
4. a plur-bench checkout: `$PLUR_BENCH_REPO/corpus/monorepo/<file>`, then
   `$PLUR_BENCH_REPO/corpus/<file>`. `PLUR_BENCH_REPO` defaults to the sibling
   checkout `../plur-bench`.

Results go to `--output <dir>`, else `PLUR_BENCH_RESULTS_DIR`, else the
gitignored `benchmark/results/`. Tests do not depend on any of this: they run
against a tiny fixture vendored inline in `run.test.ts`.

```bash
npx tsx benchmark/run.ts                                          # fixture (default), hybrid
npx tsx benchmark/run.ts --search-mode bm25                       # BM25 only
npx tsx benchmark/run.ts --search-mode semantic                   # embeddings only
npx tsx benchmark/run.ts --category temporal_reasoning            # single category
npx tsx benchmark/run.ts --corpus longmemeval-s --iterations 5    # real corpus, 5/category
npx tsx benchmark/run.ts --corpus longmemeval-s-smoke             # real subset (from plur-bench)
npx tsx benchmark/run.ts --data-dir ~/plur-bench/corpus/monorepo  # explicit fixture dir
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

Saved to `--output <dir>`, else `PLUR_BENCH_RESULTS_DIR`, else the gitignored
`benchmark/results/`. Archival runs referenced by published numbers live in
plur-bench under `results/monorepo/`.

Compare runs: check the per-category breakdown for regressions.
