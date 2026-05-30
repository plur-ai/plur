# PLUR Benchmark — 0b92e31 (2026-05-30T11:09:56.896Z)

Embedder: `bge-small`
Search mode: `hybrid`
Scenarios: 30 (N=5/category, seed=1337)

## Headline

| Metric | Value |
|---|---|
| R@5 | 80.0% |
| R@1 | 46.7% |
| Accuracy | 80.0% |
| Latency p50 | 18.74 ms |
| Latency p95 | 26.17 ms |
| Latency p99 | 555.03 ms |
| Peak RSS | 688.61 MB |
| Store size | 619566 bytes |

## Per Category

| Category | N | R@5 | R@1 | Hit@10 | MRR | Accuracy | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|---|---|
| knowledge_updates | 5 | 60.0% | 0.0% | 80.0% | 0.322 | 80.0% | 17.33 | 555.03 | 555.03 |
| multi_session_reasoning | 5 | 40.0% | 40.0% | 60.0% | 0.429 | 40.0% | 20.03 | 26.17 | 26.17 |
| single_session_assistant | 5 | 100.0% | 20.0% | 100.0% | 0.600 | 100.0% | 18.74 | 20.37 | 20.37 |
| single_session_preference | 5 | 100.0% | 100.0% | 100.0% | 1.000 | 100.0% | 18.75 | 19.36 | 19.36 |
| single_session_user | 5 | 100.0% | 60.0% | 100.0% | 0.800 | 100.0% | 18.23 | 18.56 | 18.56 |
| temporal_reasoning | 5 | 80.0% | 60.0% | 100.0% | 0.669 | 60.0% | 18.67 | 19.10 | 19.10 |
