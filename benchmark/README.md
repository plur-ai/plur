# LongMemEval Benchmark

Tests PLUR's memory retrieval quality across 6 categories (30 questions total).

## Usage

```bash
npx tsx benchmark/run.ts                          # hybrid (default)
npx tsx benchmark/run.ts --search-mode bm25       # BM25 only
npx tsx benchmark/run.ts --search-mode semantic    # embeddings only
npx tsx benchmark/run.ts --category temporal_reasoning  # single category
```

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
