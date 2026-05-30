# PLUR Benchmark — 0b92e31 (2026-05-30T11:09:37.696Z)

Embedder: `minilm`
Search mode: `hybrid`
Scenarios: 30 (N=5/category, seed=1337)

## Headline

| Metric | Value |
|---|---|
| R@5 | 80.0% |
| R@1 | 50.0% |
| Accuracy | 80.0% |
| Latency p50 | 18.04 ms |
| Latency p95 | 22.93 ms |
| Latency p99 | 338.08 ms |
| Peak RSS | 585.27 MB |
| Store size | 618370 bytes |

## Per Category

| Category | N | R@5 | R@1 | Hit@10 | MRR | Accuracy | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|---|---|
| knowledge_updates | 5 | 60.0% | 0.0% | 60.0% | 0.300 | 60.0% | 16.93 | 338.08 | 338.08 |
| multi_session_reasoning | 5 | 60.0% | 40.0% | 80.0% | 0.470 | 60.0% | 21.80 | 22.93 | 22.93 |
| single_session_assistant | 5 | 100.0% | 20.0% | 100.0% | 0.600 | 100.0% | 18.31 | 18.56 | 18.56 |
| single_session_preference | 5 | 100.0% | 100.0% | 100.0% | 1.000 | 100.0% | 18.08 | 18.70 | 18.70 |
| single_session_user | 5 | 100.0% | 100.0% | 100.0% | 1.000 | 100.0% | 17.47 | 18.66 | 18.66 |
| temporal_reasoning | 5 | 60.0% | 40.0% | 100.0% | 0.529 | 60.0% | 17.25 | 17.40 | 17.40 |
