# Local-first AI memory: feature comparison

**Status:** Draft, Phase 1 (feature matrix). Performance benchmarks tracked separately — see [Issue #8 Phase 2](https://github.com/plur-ai/plur/issues/8).

**Last updated:** 2026-04-22 (LangMem row verified — 2 `?` cells resolved + search cell recategorized from "Background manager" to retrieval primitive)

## Scope

This page compares PLUR against the 10+ credible local-first (or local-capable) AI memory systems that emerged through early 2026. The goal is a verifiable feature map, not a beauty contest: every claim links to the competitor's own docs or source. Where we cannot verify a claim from public material, the cell is marked `?` rather than guessed.

Phase 1 deliberately excludes performance numbers (LongMemEval, latency, footprint). Those need a reproducible harness and are tracked as Phase 2.

## Why this comparison exists

The local-first memory space went from "a few projects" to "a credible category" in roughly 90 days. PLUR's positioning thesis is that **local-first plus team-shareable** is the underexplored combination — most systems pick one. This table is intended to make that claim falsifiable.

## Column legend

| Column | Meaning |
|---|---|
| **Local-first** | Primary data path runs without a cloud service. "Hybrid" means cloud is optional; "cloud-only OSS" means self-host is possible but cloud is the default. |
| **Team-shareable** | First-party mechanism to share memory across users while keeping data under team control (not just "you can rsync the directory"). |
| **Sync mechanism** | How memory propagates between machines/agents. |
| **Storage** | Underlying store(s). |
| **Search** | Retrieval primitives (keyword, vector, graph, hybrid). |
| **Feedback loop** | First-party mechanism for the system to learn from corrections over time (not just manual edits). |
| **Temporal** | Tracks when facts were true / handles conflicting updates over time. |
| **Encryption at rest** | First-party encryption (not just "put it on an encrypted disk"). |
| **Cross-tool (MCP)** | Works across ≥2 AI tools via MCP (Claude Code, Cursor, Windsurf, etc.). |
| **Pack format** | Portable, shareable knowledge bundles as a first-class artifact. |
| **License** | SPDX identifier where known. |

## Matrix

### Direct competitors — local-first + MCP + cross-tool

| System | Local-first | Team-shareable | Sync mechanism | Storage | Search | Feedback loop | Temporal | Encryption | Cross-tool (MCP) | Pack format | License |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **PLUR** ([source](https://github.com/plur-ai/plur)) | Yes | **Yes (git-backed `plur sync`)** | Git, planned exchange protocol | Filesystem + SQLite FTS5 | Hybrid (BM25 + embeddings) | Yes (engram feedback, relevance training) | Per-engram timestamps | No (filesystem-level only) | Yes (Claude Code, Cursor, Windsurf, OpenClaw, Hermes) | Yes (knowledge packs) | Apache-2.0 |
| **Mem0 / OpenMemory MCP** ([source](https://github.com/mem0ai/mem0)) | Hybrid (local + cloud sharing) | Cloud only | Cloud (local mode is single-user) | Vector + Neo4j graph | Hybrid ([BM25 + entity linking](https://github.com/mem0ai/mem0)) | [Auto-conflict resolution](https://docs.mem0.ai/core-concepts/memory-operations) (`infer=True`: "duplicates or contradictions [resolved] so the latest truth wins") | No first-class temporal (timestamps only; no validity windows / "what was true when") | Not in OSS (cloud tier: SOC 2) | Yes | No (app-level) | Apache-2.0 |
| **Hindsight** ([source](https://github.com/vectorize-io/hindsight)) | Yes ([embedded Python or self-hosted Postgres; cloud optional](https://hindsight.vectorize.io/guides/2026/04/16/guide-run-hindsight-as-a-local-mcp-server)) | No (per-user isolation; no multi-user team-sharing mechanism documented) | — | Postgres + KG | [Hybrid (vector + BM25 + graph + temporal)](https://hindsight.vectorize.io/) | Auto-consolidation ([Reflect op](https://hindsight.vectorize.io/) generates observations from memories; no explicit user correction/rating API documented) | [Time-range filter + evidence-based trend tracking](https://hindsight.vectorize.io/) (stable / strengthening / weakening / stale); no bi-temporal validity windows | Not documented | **Yes** ([first-party MCP server](https://hindsight.vectorize.io/developer/mcp-server); Claude Code, Claude Desktop, Cursor, Windsurf) | No (not documented) | MIT |
| **Basic Memory** | Yes | Manual (`git` by hand) | User-managed git | Markdown + SQLite | Keyword | No | File mtime | No | ? | No | MIT |
| **Engram (Go)** (Gentleman-Programming) | Yes | No | — | SQLite + FTS5 | Keyword (FTS5) | ? | ? | ? | ? | No | MIT |
| **Engram (E2EE)** (EvolvingLMMs-Lab) | Yes | No | — | SQLite + AES-256-GCM | ? | ? | ? | **Yes (AES-256-GCM)** | ? | No | ? |
| **MCP Memory Service** (doobidoo) | Yes (optional Cloudflare backend) | Via Cloudflare backend | Cloudflare sync (optional) | KG + embeddings | Hybrid | Auto-consolidation | ? | ? | Yes (MCP) | No | ? |
| **Cognee** ([source](https://github.com/topoteretes/cognee)) | Yes ([self-host, 1-click](https://github.com/topoteretes/cognee)) | No (multi-tenant isolation only; no first-party team-sharing mechanism) | — | Pluggable: vector ([LanceDB / Qdrant / PGVector](https://docs.cognee.ai/llms.txt)) + graph ([Neo4j / FalkorDB / Kuzu](https://docs.cognee.ai/llms.txt)) + relational | Graph + vector (auto-routing); no BM25/keyword documented | Yes (`improve` op; "Continuously learns to provide the right context") | [Time-aware queries / temporal mode](https://docs.cognee.ai/llms.txt) | ? (not documented) | Yes ([first-party `cognee-mcp`](https://github.com/topoteretes/cognee/tree/main/cognee-mcp); exposes `remember` / `recall` / `cognify` / `search`) | No | Apache-2.0 |

### Adjacent — local or local-capable, not fully MCP-native

| System | Local-first | Team-shareable | Sync mechanism | Storage | Search | Feedback loop | Temporal | Encryption | Cross-tool (MCP) | Pack format | License |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Claude Code built-in memory** | Yes | No | — | Markdown in `~/.claude/` | Keyword | No | File mtime | No | **No (Claude Code only)** | No | Proprietary |
| **Letta / MemGPT** ([source](https://github.com/letta-ai/letta)) | Hybrid | [Shared memory blocks](https://docs.letta.com/guides/agents/memory) (multi-agent, not multi-user) | Cloud | Postgres + pgvector | Self-managing recall | Yes (sleep-time compute) | No (editable [memory blocks](https://docs.letta.com/guides/agents/memory); no validity windows / "what was true when") | Not first-party ([deploy-layer only, e.g. Postgres/Aurora encryption](https://aws.amazon.com/blogs/database/how-letta-builds-production-ready-ai-agents-with-amazon-aurora-postgresql/)) | [MCP client only](https://docs.letta.com/guides/mcp/overview) (consumes external MCP tools; memory exposed via SDK, not MCP) | No | Apache-2.0 |
| **Graphiti** ([source](https://github.com/getzep/graphiti)) | Yes (self-hosted OSS) | No (single-instance OSS) | — | Neo4j / FalkorDB / Kuzu / Neptune (pluggable) | [Hybrid (semantic + BM25 + graph traversal)](https://github.com/getzep/graphiti#why-graphiti) | [Auto-invalidation of contradicting facts](https://github.com/getzep/graphiti#why-graphiti) (temporal; old facts invalidated, not deleted) | **Yes (bi-temporal validity windows)** | Not in OSS (backend-dependent) | **Yes ([first-party MCP server](https://github.com/getzep/graphiti/tree/main/mcp_server))** | No | Apache-2.0 |
| **Zep** ([source](https://www.getzep.com/)) | Hybrid (managed cloud; self-host via Graphiti OSS) | **Yes (managed users/threads)** | Cloud | Managed (Graphiti-backed) | Hybrid (semantic + BM25 + graph) | [Auto-invalidation](https://blog.getzep.com/state-of-the-art-agent-memory/) (inherited from Graphiti) | **Yes (bi-temporal)** | [Enterprise security](https://docs.getzep.com/deployment/security/) (cloud tier) | Yes (via [Graphiti MCP server](https://help.getzep.com/graphiti/getting-started/mcp-server)) | No | Apache-2.0 (Graphiti core) / Proprietary (Zep platform) |
| **LangMem** ([source](https://github.com/langchain-ai/langmem)) | Hybrid (any [LangGraph BaseStore](https://langchain-ai.github.io/langmem/): InMemoryStore local, AsyncPostgresStore self-host) | No | — | [Pluggable (any LangGraph BaseStore)](https://langchain-ai.github.io/langmem/) | [Semantic + exact match](https://langchain-ai.github.io/langmem/reference/tools/) via vector index (e.g. `openai:text-embedding-3-small`, 1536 dims) | Yes ([background memory manager](https://langchain-ai.github.io/langmem/); extracts/updates memories from conversations) | Not documented | Not documented (deploy-layer only if using Postgres) | SDK only (no first-party MCP server) | No | MIT |
| **Google Always-On Memory Agent** | Yes | No | — | Agent-internal | LLM-driven (no vectors) | ? | ? | ? | ? | No | MIT |
| **MemOS** (MemTensor) | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |

## Provisional findings (to be firmed up as `?` cells resolve)

1. **Team-shareable + local-first is still a narrow combination.** Of the 15 systems above, PLUR is currently the only one with first-party team-sharing that stays on the team's own infrastructure (git-backed). Mem0, Letta, and Zep offer team features but only via their cloud tier; Graphiti OSS and Cognee are explicitly single-instance / multi-tenant-isolation-only. Basic Memory can be shared via git but only by manual user work — it's not a supported flow.
2. **Temporal reasoning is rare but growing.** Graphiti (and Zep, which uses Graphiti as its core) treats temporal as central via bi-temporal validity windows and automatic fact invalidation. Cognee advertises a "time-aware queries / temporal mode" (exact semantics not yet verified against Graphiti's bi-temporal model). Hindsight adds time-range filtering and evidence-based trend tracking (stable / strengthening / weakening / stale) but also stops short of bi-temporal validity windows. Most others, PLUR and Mem0 included, rely on timestamps without first-class "what was true when" semantics. Mem0's `infer=True` extract-resolve flow gives auto-conflict-resolution at write-time ("latest truth wins"), but no temporal validity windows over time.
3. **Encryption at rest is mostly absent.** Only Engram (E2EE) ships first-party encryption. For enterprise team use, this is a gap across the category.
4. **Pack format as a first-class artifact is PLUR-specific in this set.** Other systems expose memory as a store, not as portable shareable bundles.

These are provisional because `?` cells may overturn them. This file should be updated (not rewritten) as each cell is sourced.

## Contributing

If you maintain one of the systems above, or know one of the `?` cells cold, PRs against this file are welcome. Cell-level changes only; each change must link to the system's own docs or source. If you spot an inaccurate claim about PLUR, please open an issue — the positioning claim above is only useful if it holds up under adversarial checking.

## Out of scope for Phase 1

- Performance numbers (LongMemEval, retrieval latency, RAM/disk footprint) — see [Issue #8 Phase 2](https://github.com/plur-ai/plur/issues/8). Requires a reproducible harness that doesn't yet exist.
- Subjective UX comparison — deliberately excluded to keep the matrix verifiable.
- Pricing / commercial tier comparison — tracked separately under the enterprise positioning doc.
