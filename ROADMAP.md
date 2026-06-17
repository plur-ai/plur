# PLUR Roadmap

_Last updated: 2026-06-17_

PLUR is persistent, local-first memory for AI agents. This roadmap captures the major workstreams currently active. For day-to-day status, see [open issues](https://github.com/plur-ai/plur/issues).

## Now

### Stability and instrumentation

- **Doctor / ONNX reliability** — [#197](https://github.com/plur-ai/plur/issues/197)
- **Tension regression coverage** — [#182](https://github.com/plur-ai/plur/issues/182)
- **OpenClaw activation path** — [#51](https://github.com/plur-ai/plur/issues/51)

### Benchmark and competitive position

- **Phase 2 benchmarking harness** — [#46](https://github.com/plur-ai/plur/issues/46) — reproducible LongMemEval + latency + footprint comparison across local-first memory systems.

### Ecosystem integrations

- **OmniGent memory adapter** — make PLUR the memory layer for [OmniGent](https://github.com/omnigent-ai/omnigent), Databricks' open-source meta-harness (Apache-2.0, Python 3.12+, launched 2026-06-13). OmniGent ships policies, sandboxing, egress secret injection, and live session sharing but **no memory** — exactly PLUR's wedge. Two routes: **(1)** PLUR-as-MCP-tool works *today* with zero adapter code (just an agent-YAML `tools: {type: mcp}` block pointing at `@plur-ai/mcp` or `plur.datafund.io/sse`); **(2)** a native `omnigent-plur` Python package — auto-recall via `per_request_instructions`, auto-learn via a response/tool_result policy — wrapping the PLUR MCP/remote store (PLUR stays the engine; the adapter is orchestration, not a port). First-mover visibility while the ecosystem is new. Task + full codebase analysis: `5-plur/org/next_actions.org` → `org-20260617-plur-omnigent-adapter`. Engrams: ENG-2026-0616-021.

## Next: Relational Memory

Adopt the Kumo Online Serving / KumoRFM-2 architecture pattern: offline relational model produces cached embeddings; online shallow reranker uses cached embeddings + live session signals. Reposition PLUR as a *relational* memory engine — differentiated from flat-RAG memory systems (Letta, MemGPT, Zep, Cognee).

**Epic:** [#205 — Relational memory](https://github.com/plur-ai/plur/issues/205)

| Issue | Title |
|-------|-------|
| [#200](https://github.com/plur-ai/plur/issues/200) | Two-stage retrieval: deep offline relational model + shallow online reranker |
| [#201](https://github.com/plur-ai/plur/issues/201) | Treat engram store as a relational graph, not a flat vector index |
| [#202](https://github.com/plur-ai/plur/issues/202) | Closed-loop training of retrieval relevance from `plur_feedback` |
| [#203](https://github.com/plur-ai/plur/issues/203) | Tension-aware retrieval |
| [#204](https://github.com/plur-ai/plur/issues/204) | Reposition packs as pretrained foundation memory |

**Success criteria:**
- PreToolUse hot path: parity latency with current BM25-only, recall quality ≥ current hybrid.
- Lift over flat-vector baseline on the Phase 2 benchmark harness ([#46](https://github.com/plur-ai/plur/issues/46)).
- "Relational memory" surfaced in positioning.
- Feedback events translate into measurable retrieval improvement over time.

**References:**
- [Kumo Online Serving announcement](https://kumo.ai/company/news/low-latency-high-throughput-predictions-with-kumorfm-2-fine-tuning/)
- [KumoRFM-2 paper (arxiv:2604.12596)](https://arxiv.org/abs/2604.12596)

### Related — complementary, not duplicated

- [#109](https://github.com/plur-ai/plur/issues/109) — Background compaction and sleep-cycle consolidation (maintenance pipeline)
- [#111](https://github.com/plur-ai/plur/issues/111) — Transparent SDK interception (signal collection for closed-loop training)
- [#113](https://github.com/plur-ai/plur/issues/113) — Engram time-travel (versioned timelines)

## Later

- **Provenance verification for knowledge packs** — [#11](https://github.com/plur-ai/plur/issues/11) — supply chain trust for shared/community packs.

---

This file is hand-maintained. Items move from "Next" to "Now" as they're picked up; closed work drops off. Open an issue to propose additions.
