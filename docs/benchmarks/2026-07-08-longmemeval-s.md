# PLUR v0.9.x benchmark baseline — 2026-07-08

**Commit:** `5a0ea11` | **Embedder:** `minilm` (local, all-MiniLM-L6-v2) | **Corpus:** PLUR fixture (hand-curated, n=30)

> This is the PLUR v0.9.x baseline published in response to gbrain's 2026-05-07 benchmark.
> The gbrain hero metric (R@5 = 97.60%) is a **retrieval-only** score using a commercial
> cloud embedder on the full 500-question LongMemEval-S corpus. The numbers below use the
> same question taxonomy (six categories: single-session, preference, assistant, temporal,
> updates, multi-session) on PLUR's 30-question hand-curated fixture. Full LongMemEval-S
> corpus run (500 questions) is pending corpus import into plur-bench (#336).

---

## What these numbers mean

| Term | Definition |
|------|-----------|
| **R@K** (Recall@K) | Fraction of questions where the correct memory appears in the top-K retrieved results. Measures retrieval quality, not answer quality. |
| **MRR** | Mean Reciprocal Rank — average of 1/rank across all queries. Rewards finding the right memory higher. Range: 0–1. |
| **nDCG@5** | Normalized Discounted Cumulative Gain at K=5. Binary relevance, single relevant item (IDCG=1). Penalizes relevant items appearing lower in the list. Range: 0–1. |
| **Accuracy** | Fraction of questions where *all* expected keywords appear in the top-10 retrieved statements. End-to-end proxy for answer quality. |
| **Cost / 1k** | Estimated USD cost per 1 000 queries (embedding + retrieval). $0.00 for fully local models. |

R@K and MRR measure the *retrieval pipeline* (did PLUR find the right memory?). Accuracy measures *answer completeness* (are all needed facts present in the context window?). A system can score high on R@5 but low on Accuracy if the relevant memory is present but incomplete. A system can score high on Accuracy but low on R@1 if the answer requires assembling multiple memories.

---

## Table 1 — Overall Metrics

| Metric | PLUR (minilm hybrid) | gbrain (zembed-1) |
|--------|---------------------|--------------------|
| R@1 | 53.3% | — |
| R@3 | 80.0% | — |
| **R@5** | **80.0%** | **97.60%** |
| R@10 | 90.0% | — |
| MRR | 0.6685 | — |
| nDCG@5 | 0.6929 | — |
| Accuracy | 80.0% | — |
| Cost / 1k queries | $0.0000 | commercial (undisclosed) |
| Latency p50 | 101 ms | — |
| Latency p95 | 152 ms | — |
| Latency p99 | 162 ms | — |
| Peak RSS | 503 MB | — |
| Corpus size (n) | 30 (fixture) | 500 (full) |

> **Baseline comparison:** gbrain R@5 = 97.60% (2026-05-07, ZeroEntropy zembed-1, LongMemEval-S full 500-question corpus).
> PLUR results use the 30-question fixture subset on a local embedder. Full 500-question results pending corpus import (#336).

---

## Table 2 — Per Question Type (R@5 and Accuracy)

| Question type | N | R@1 | R@3 | R@5 | R@10 | MRR | nDCG@5 | Accuracy |
|--------------|---|-----|-----|-----|------|-----|--------|----------|
| single_session_user | 5 | 100% | 100% | 100% | 100% | 1.000 | 1.000 | 100% |
| single_session_preference | 5 | 100% | 100% | 100% | 100% | 1.000 | 1.000 | 100% |
| single_session_assistant | 5 | 40% | 100% | 100% | 100% | 0.700 | 0.779 | 100% |
| temporal_reasoning | 5 | 40% | 60% | 60% | 100% | 0.522 | 0.500 | 60% |
| knowledge_updates | 5 | 0% | 60% | 60% | 60% | 0.300 | 0.379 | 60% |
| multi_session_reasoning | 5 | 40% | 60% | 60% | 80% | 0.489 | 0.500 | 60% |

---

## Analysis: Where PLUR wins and where it doesn't

### Strengths

**Perfect single-session recall.** All three single-session categories score 100% R@5. When a fact was stated once in a recent conversation, PLUR's hybrid BM25+embedding search retrieves it reliably. MRR = 1.0 for user and preference categories means the right memory consistently lands at rank 1.

**Zero infrastructure cost.** $0.00 per 1 000 queries. All embedding and retrieval happens locally on CPU. The gbrain comparison requires a cloud API (ZeroEntropy zembed-1) with undisclosed pricing. At scale, this cost difference compounds: 1M queries/day = $0 vs potentially thousands of dollars monthly.

**Sub-200ms latency.** p50 = 101ms, p99 = 162ms. This is fully local: no network round-trip, no API rate limit, no cold start. With reranker on (BGE cross-encoder), p50 rises to ~3s — that config is better for offline/agentic work where quality matters more than speed.

### Weaknesses

**Temporal and multi-session reasoning: 60% R@5.** These categories require matching a *conclusion* derived from conversation history (e.g., "what was true on date X?"). BM25+embedding retrieves the closest lexical/semantic match, but the answer may be spread across several turns or require temporal ordering. The reranker improves temporal_reasoning to 100% R@5 (see v0.9.13 CLAUDE.md numbers) at the cost of latency.

**Knowledge updates: 60% R@5, 0% R@1.** When a fact was updated ("I moved from NYC to Paris"), PLUR stores both the old and new statement. The updated fact lands in the top-5 but not consistently at rank 1 because the old statement has higher activation (was seen more times). ACT-R decay helps over time but the fixture tests immediate post-update recall. This is the #1 improvement target.

**Corpus size: 30 vs 500.** The fixture is a 30-question hand-curated subset. gbrain tested against the full 500-question LongMemEval-S. Our 30-question score is directionally valid but has higher variance (each question = 3.3% of total). Full corpus import is blocked on #336 (plur-bench setup).

---

## Counter-positioning: what gbrain's 97.60% doesn't show

gbrain's benchmark report leads with R@5 = 97.60%. This is a strong retrieval number. But the comparison is structured to favour commercial embedders:

1. **ZeroEntropy zembed-1 is a cloud API.** It produces higher-quality embeddings than local models, but at cost and latency that make it unsuitable for edge, offline, or high-frequency use. PLUR's local minilm is free and always available. Comparing them on R@5 alone conflates retrieval quality with infrastructure accessibility.

2. **R@5 is retrieval recall, not answer quality.** A system that retrieves the right document at rank 5 still requires the LLM to read 4 irrelevant documents first, consuming context window and increasing hallucination risk. PLUR's MRR (0.67) and R@1 (53%) tell a more complete story: the right memory reaches rank 1 more than half the time, even with a local embedder.

3. **No cost, latency, or footprint disclosure.** gbrain's report publishes R@5 only. PLUR publishes R@1/3/5/10, MRR, nDCG@5, accuracy, latency p50/p95/p99, peak RSS, store size, and cost. Benchmark credibility requires full disclosure — cherry-picking one favourable metric is a yellow flag.

4. **Single-config snapshot vs multi-adapter sweep.** gbrain published one number for one embedder. PLUR can sweep four adapter configs (BM25, semantic, hybrid, hybrid+reranker) in a single command. This sweep is reproducible, open-source, and runnable by anyone with the corpus.

5. **Cross-vendor neutrality.** PLUR is Apache-2.0, has no token, and runs identically in every AI agent environment. Commercial memory systems require API keys, usage-based billing, and vendor lock-in. The missing token is a credibility asset: any competitor that adds a token retroactively loses the cross-vendor neutrality claim.

---

## Next runs planned

| Config | Expected R@5 | Status |
|--------|-------------|--------|
| minilm hybrid (this report) | 80% | **Published** |
| minilm hybrid+reranker | ~90% | Pending #220 merge |
| bge-small hybrid | TBD | Pending corpus import (#336) |
| Full 500-question corpus | TBD | Pending corpus import (#336) |

Delta reports will be published as each configuration becomes available.

---

*Generated by PLUR benchmark harness — commit `5a0ea11`, 2026-07-08.*
