# PLUR Benchmark — 0b92e31 (2026-05-30T11:10:36.607Z)

Embedder: `bge-base`
Search mode: `hybrid`
Scenarios: 30 (N=5/category, seed=1337)

## Headline

| Metric | Value |
|---|---|
| R@5 | 83.3% |
| R@1 | 53.3% |
| Accuracy | 76.7% |
| Latency p50 | 46.65 ms |
| Latency p95 | 240.22 ms |
| Latency p99 | 2574.90 ms |
| Peak RSS | 1035.45 MB |
| Store size | 1123684 bytes |

## Per Category

| Category | N | R@5 | R@1 | Hit@10 | MRR | Accuracy | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|---|---|
| knowledge_updates | 5 | 60.0% | 0.0% | 60.0% | 0.300 | 60.0% | 69.16 | 2574.90 | 2574.90 |
| multi_session_reasoning | 5 | 60.0% | 40.0% | 80.0% | 0.460 | 40.0% | 78.64 | 240.22 | 240.22 |
| single_session_assistant | 5 | 100.0% | 20.0% | 100.0% | 0.600 | 100.0% | 46.65 | 98.41 | 98.41 |
| single_session_preference | 5 | 100.0% | 100.0% | 100.0% | 1.000 | 100.0% | 36.49 | 38.51 | 38.51 |
| single_session_user | 5 | 100.0% | 100.0% | 100.0% | 1.000 | 100.0% | 38.56 | 39.46 | 39.46 |
| temporal_reasoning | 5 | 80.0% | 60.0% | 100.0% | 0.729 | 60.0% | 42.07 | 49.34 | 49.34 |
