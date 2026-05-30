# PLUR Benchmark — 0b92e31 (2026-05-30T11:11:08.451Z)

Embedder: `embedding-gemma`
Search mode: `hybrid`
Scenarios: 30 (N=5/category, seed=1337)

## Headline

| Metric | Value |
|---|---|
| R@5 | 80.0% |
| R@1 | 43.3% |
| Accuracy | 83.3% |
| Latency p50 | 71.99 ms |
| Latency p95 | 226.65 ms |
| Latency p99 | 6116.36 ms |
| Peak RSS | 1683.7 MB |
| Store size | 1130890 bytes |

## Per Category

| Category | N | R@5 | R@1 | Hit@10 | MRR | Accuracy | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|---|---|
| knowledge_updates | 5 | 60.0% | 0.0% | 80.0% | 0.320 | 80.0% | 115.24 | 6116.36 | 6116.36 |
| multi_session_reasoning | 5 | 60.0% | 40.0% | 60.0% | 0.440 | 60.0% | 74.70 | 83.36 | 83.36 |
| single_session_assistant | 5 | 100.0% | 20.0% | 100.0% | 0.600 | 100.0% | 116.44 | 226.65 | 226.65 |
| single_session_preference | 5 | 100.0% | 100.0% | 100.0% | 1.000 | 100.0% | 67.79 | 71.99 | 71.99 |
| single_session_user | 5 | 100.0% | 60.0% | 100.0% | 0.800 | 100.0% | 68.67 | 73.02 | 73.02 |
| temporal_reasoning | 5 | 60.0% | 40.0% | 100.0% | 0.556 | 60.0% | 63.52 | 64.99 | 64.99 |
