# Embedder Bake-Off — Sprint 0 PR 4 (2026-05-30)

Four candidate embedders, one harness, one LongMemEval-S subset. Goal: pick
the default for `@plur-ai/core` v0.10.

## TL;DR

EmbeddingGemma is the provisional default unless a Phase C 500-iter run upsets
the ordering. BGE-small is the steady-state fallback (current production
embedder, smallest acceptable footprint, lowest latency). MiniLM ships as the
historical baseline for traceability. BGE-base is parked — it costs 2-3x the
RAM and 2-3x the latency of BGE-small for no meaningful R@5 gain at this N.

This is a small-N report (N=5 per category, 30 scenarios total). Headline
numbers will move at the Phase C run; the model ranking on this fixture
should be treated as directional, not final.

## Setup

| Knob | Value |
|---|---|
| Date | 2026-05-30 |
| Commit | feat/embedder-bake-off @ 0b92e31 |
| Harness | benchmark/run.ts (PR 3 substrate) |
| Search mode | hybrid (BM25 + embeddings RRF) |
| Iterations | 5 per category (30 scenarios) |
| Seed | 1337 (deterministic per-category sampling) |
| Backend | YAML primary store (no PGLite) |
| Host | macOS, Node 22 |

All four adapters live in `packages/core/src/embedders/`. Each one wraps the
`@huggingface/transformers` feature-extraction pipeline; EmbeddingGemma works
through the same runtime — no direct `onnxruntime-node` call was needed.

The harness sets `PLUR_EMBEDDER=<name>` and calls `resetEmbedder()` between
runs so back-to-back invocations actually swap the live model rather than
sticking to whichever loaded first.

## Headline

| Embedder | Dim | R@5 | R@1 | Accuracy | p50 ms | p95 ms | p99 ms | Peak RSS | Disk | License |
|---|---|---|---|---|---|---|---|---|---|---|
| minilm | 384 | 80.0% | 50.0% | 80.0% | 18.04 | 22.93 | 338.08 | 585 MB | 97 MB | Apache-2.0 |
| bge-small | 384 | 80.0% | 46.7% | 80.0% | 18.74 | 26.17 | 555.03 | 689 MB | 128 MB | MIT |
| bge-base | 768 | 83.3% | 53.3% | 76.7% | 46.65 | 240.22 | 2574.90 | 1035 MB | 417 MB | MIT |
| embedding-gemma | 768 | 80.0% | 43.3% | 83.3% | 71.99 | 226.65 | 6116.36 | 1684 MB | 325 MB | Apache-2.0 |

Notes on the metrics:

- **R@5 / R@1**: percentage of queries with the right engram in top 5 / at rank 1.
- **Accuracy**: percentage of queries where every expected keyword appears in the top-10. Catches partial-match failures the rank metrics miss.
- **p50 / p95 / p99**: per-query end-to-end latency including hybrid RRF.
- **Peak RSS**: process RSS after the run finishes — includes the model weights resident in memory plus Node + transformers WASM runtime overhead.
- **Disk**: bytes written to `node_modules/@huggingface/transformers/.cache/<modelId>/` after the first cold load. EmbeddingGemma is the q8-quantised ONNX variant from `onnx-community/embeddinggemma-300m-ONNX`.

## Per-embedder per-category (raw JSON in `benchmark/results/bakeoff/`)

### minilm

| Category | R@5 | R@1 | MRR | p95 ms |
|---|---|---|---|---|
| knowledge_updates | 60.0% | 0.0% | 0.300 | 338.08 |
| multi_session_reasoning | 60.0% | 40.0% | 0.470 | 22.93 |
| single_session_assistant | 100.0% | 20.0% | 0.600 | 18.56 |
| single_session_preference | 100.0% | 100.0% | 1.000 | 18.70 |
| single_session_user | 100.0% | 100.0% | 1.000 | 18.66 |
| temporal_reasoning | 60.0% | 40.0% | 0.529 | 17.40 |

### bge-small

| Category | R@5 | R@1 | MRR | p95 ms |
|---|---|---|---|---|
| knowledge_updates | 60.0% | 0.0% | 0.322 | 555.03 |
| multi_session_reasoning | 40.0% | 40.0% | 0.429 | 26.17 |
| single_session_assistant | 100.0% | 20.0% | 0.600 | 20.37 |
| single_session_preference | 100.0% | 100.0% | 1.000 | 19.36 |
| single_session_user | 100.0% | 60.0% | 0.800 | 18.56 |
| temporal_reasoning | 80.0% | 60.0% | 0.669 | 19.10 |

### bge-base

| Category | R@5 | R@1 | MRR | p95 ms |
|---|---|---|---|---|
| knowledge_updates | 60.0% | 0.0% | 0.300 | 2574.90 |
| multi_session_reasoning | 60.0% | 40.0% | 0.460 | 240.22 |
| single_session_assistant | 100.0% | 20.0% | 0.600 | 98.41 |
| single_session_preference | 100.0% | 100.0% | 1.000 | 38.51 |
| single_session_user | 100.0% | 100.0% | 1.000 | 39.46 |
| temporal_reasoning | 80.0% | 60.0% | 0.729 | 49.34 |

### embedding-gemma

| Category | R@5 | R@1 | MRR | p95 ms |
|---|---|---|---|---|
| knowledge_updates | 60.0% | 0.0% | 0.320 | 6116.36 |
| multi_session_reasoning | 60.0% | 40.0% | 0.440 | 83.36 |
| single_session_assistant | 100.0% | 20.0% | 0.600 | 226.65 |
| single_session_preference | 100.0% | 100.0% | 1.000 | 71.99 |
| single_session_user | 100.0% | 60.0% | 0.800 | 73.02 |
| temporal_reasoning | 60.0% | 40.0% | 0.556 | 64.99 |

## Reading the numbers

A few warnings before drawing conclusions from N=30:

- Single-session categories (user / preference / assistant) are at the
  ceiling for every embedder — they're easy retrievals where BM25 alone
  already wins. R@5 = 100% on these adds no signal between models.
- `knowledge_updates` and `temporal_reasoning` are the hard categories. The
  R@5 gap is where the model really matters and where Phase C (N=500) will
  produce signal. At N=5 per category we are reading 1-2 query swings as
  big movements; trust the direction, not the magnitude.
- The p99 spikes (BGE-base 2.5s, EmbeddingGemma 6.1s) include the cold
  load of the first per-category query — the pre-warm in the harness only
  loads one model, not the full per-scenario cache. Steady-state p50 is the
  more useful number for production planning.

## Decision

**Provisional**: EmbeddingGemma remains the planned default for the
post-PR-4 substrate. It (a) ties BGE-small at R@5 on this small N, (b) wins
on Accuracy (full-keyword coverage in top 10), and (c) has the most upstream
headroom of the four (Matryoshka, multilingual, recent training data, larger
parameter count). The latency and RSS cost is real but the Phase C run will
tell us whether it's worth the swap on the actual workload.

**Fallback**: BGE-small stays as the conservative pick. If Phase C shows
EmbeddingGemma underperforming or producing unstable rank behavior, BGE-small
ships as the v0.10 default and EmbeddingGemma stays opt-in via PLUR_EMBEDDER.

**Out of scope this PR**: BGE-base is dropped from contention. R@5 gain is
within the noise floor at this N, but latency and RSS are 2-3x BGE-small —
a bad trade for laptop users on the path to a 1M-engram store.

## What changes on PR 5

PR 5 (`feat/embedding-gemma-default`) wires EmbeddingGemma as the engine
default, runs LongMemEval-S full (N=500 per category) for both EmbeddingGemma
and BGE-small, and publishes a follow-up report. If the small-N ordering
reverses, the PR 5 spec changes accordingly — the spec defers to the data.

## Files referenced

- Adapter implementations: `packages/core/src/embedders/{minilm,bge-small,bge-base,embedding-gemma}.ts`
- Factory: `packages/core/src/embedders/index.ts`
- Engine wiring: `packages/core/src/embeddings.ts` (routes via factory)
- PGLite vector dim: `packages/core/src/storage-pglite.ts` (configurable via constructor)
- Raw run output: `benchmark/results/bakeoff/0b92e31-2026-05-30T11-*.{json,md}`
