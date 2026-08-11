# PLUR Roadmap

_Last updated: 2026-08-11_

PLUR is persistent, local-first memory for AI agents. This roadmap captures the major workstreams currently active. For day-to-day status, see [open issues](https://github.com/plur-ai/plur/issues).

## Now

### Stability and instrumentation

- **Doctor / ONNX reliability** — [#197](https://github.com/plur-ai/plur/issues/197)
- **Tension regression coverage** — [#182](https://github.com/plur-ai/plur/issues/182)
- **OpenClaw activation path** — [#51](https://github.com/plur-ai/plur/issues/51)

### Benchmark and competitive position

- **Phase 2 benchmarking harness** — [#46](https://github.com/plur-ai/plur/issues/46) — reproducible LongMemEval + latency + footprint comparison across local-first memory systems.

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

## Next: Verifiable Memory

_Added 2026-08-11. Driven by the auditability research read ([arXiv:2604.05485](https://arxiv.org/abs/2604.05485), IETF `draft-sato-soos-gar-01`, EU AI Act Art. 12/18/26). Full analysis: `5-plur/3-knowledge/literature/auditable-agents-usc-fortis-strategic-read-2026-08-10.md`._

**The gap we are taking.** The literature defines agent auditability over five dimensions — action recoverability, lifecycle coverage, policy checkability, responsibility attribution, evidence integrity — all of which are defined over actions inside a *single execution*. None makes an agent's **beliefs** answerable. In a stateless agent that distinction does not exist; in a memory-bearing agent it does, and every enterprise agent worth deploying is memory-bearing. The most complete standards proposal in the space (`draft-sato-soos-sov`) is explicitly session-scoped and names cross-session memory linking as out of scope.

> The five dimensions make an agent's **actions** answerable. None of them makes an agent's **beliefs** answerable.

**Where we actually are** (verified against code, 2026-08-11 — not aspirational):

| Component | Integrity Strength | Note |
|---|---|---|
| PLUR core `~/.plur/engrams.yaml` | **Level 0** | mutable YAML; `content_hash` lives in the same file, so it is a corruption check, not a tamper check. `provenance` never written; `sources[].session_id` null. |
| PLUR Enterprise audit chain | **Level 2** | HMAC is symmetric → not third-party verifiable. Chains *operations on* engrams, not engram *state*. Issue #287. |
| Datacore v2 ledger | **Level 2** | hash-chained; Ed25519 `keys.py` built but dormant behind `DATACORE_LEDGER_SIGN`. No memory event type. |

Appendix B.8 of the paper sets the urgency, and it is not rhetorical: post-hoc signing *"cannot retroactively certify that the record was unmodified before the signing event."* Every day at Level 0 is permanently unauditable memory.

**Sequence** (ordering is load-bearing — chain the state *before* anchoring it; anchoring an unverified store manufactures false assurance):

| # | Work | Priority |
|---|---|---|
| 1 | Back the shipped provenance claim — decide the ICE one-pager wording | #A |
| 2 | Make the Datacore v2 ledger verifier actually run and emit a dated artifact | #A |
| 3 | Integrate provenance; Swarm as WORM for demo proofs | #A |
| 4 | Chain engram **state** per scope (Level 0 → 2); Enterprise HMAC → Ed25519 (→ 3) | #A |
| 5 | Execute the sovereign-memory plan: `fds-identity.ts`, `anchor.ts`, client-side verification, mainnet, audit | #B |
| 6 | **Read-time verification** with consequence-tiered verification | #A |

**Item 6 is the differentiated one.** Tier verification by consequence — a `behavioral` engram with commitment `firm` entering a session authorised for a gated effect gets full verification; a `terminological` engram at low retrieval strength does not. Only PLUR can build this, because only PLUR has typed engrams with commitment levels. Its real output is not a boolean but an audit record: *"this action was taken on a context containing 11 verified engrams and 1 unverified engram, injected under session key K, delegated from principal P."* That sentence is cross-session responsibility attribution, and nobody has it.

**Success criteria:**
- Every claim on the Auditability Card is defensible against the code on its publication date.
- A prospect's own security team can verify a store snapshot offline, with no shared secret and no network path to us.
- Read-time verification measurably does not damage the injection hot path (it must not tax the token-efficiency wedge to serve the compliance upsell).
- An explicit decision on whether PLUR claims **non-suppressibility** (`draft-sato-soos-gar-01`) — testable, and most competitors cannot claim it.

**Strategic frame:** the maturity ladder (tamper-evident observability → full agent GRC) is right, but the ladder is commodity and **the object is the moat**. Competitors will run tier 1 on tool calls; running it on the *memory store* is differentiated on day one. Memory lands, GRC upsells — sequencing unchanged.

## Later

- **Provenance verification for knowledge packs** — [#11](https://github.com/plur-ai/plur/issues/11) — supply chain trust for shared/community packs. Now downstream of the Verifiable Memory track above: the paper's OP2 ("minimal provenance for a dynamically selected skill") and its adoption path #4 ("skill ecosystems should require card-level provenance metadata as a publication prerequisite") are effectively a written spec for what a pack listing must carry.

---

This file is hand-maintained. Items move from "Next" to "Now" as they're picked up; closed work drops off. Open an issue to propose additions.
