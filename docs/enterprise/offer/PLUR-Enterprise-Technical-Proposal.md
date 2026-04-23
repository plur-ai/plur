# PLUR Enterprise — Gap Analysis & Solution Architecture

**Document type**: Technical proposal
**Date**: 2026-04-21
**Status**: Draft

---

## 1. What PLUR Is Today

PLUR is an open-source persistent memory system for AI coding agents. It solves a fundamental problem: AI assistants forget everything between sessions. PLUR gives them durable, searchable, feedback-trained memory.

### Core capabilities (production-ready)

- **Engram engine** — Structured knowledge units (behavioral, procedural, architectural, terminological) with activation modeling based on ACT-R cognitive science. Engrams strengthen with use and decay when neglected.

- **Hybrid search** — BM25 keyword search + BGE local embeddings merged via Reciprocal Rank Fusion. Zero external API calls. Fully private, fully local.

- **Feedback-trained retrieval** — Positive/negative signals tune which engrams surface. The system gets sharper with use, not just bigger.

- **Knowledge packs** — Curated, portable collections of engrams. Install domain expertise in seconds. Export and share team knowledge.

- **Multi-platform integration** — Works with Claude Code (hooks + MCP), OpenClaw (ContextEngine plugin), Hermes Agent (Python plugin). Any MCP-compatible client can connect.

- **Open format** — Engrams stored as structured YAML with Zod-validated schemas. No vendor lock-in. Your memory is yours.

### Architecture

```
@plur-ai/core    — Engine: storage, search, injection, decay, feedback
@plur-ai/mcp     — MCP server: 32 tools for agent interaction
@plur-ai/cli     — Command-line interface: 12 commands
@plur-ai/claw    — OpenClaw ContextEngine plugin
plur-hermes      — Hermes Agent plugin (Python)
```

### Current deployment model

PLUR runs **locally on the developer's machine**. Each developer has their own `~/.plur/` directory with their engrams, episodes, and configuration. The MCP server communicates via stdio (one process per session). Sync across devices is git-based.

This model is excellent for individual developers. It is insufficient for organizations.

---

## 2. Enterprise Requirements

Your organization has specific needs that go beyond individual developer tooling:

| Dimension | Your reality |
|-----------|-------------|
| **Scale** | ~1,400 repositories across ~300 groups |
| **Team size** | ~50 developers, likely growing |
| **Source platform** | GitLab (self-hosted or cloud) |
| **AI tooling** | Multiple models and AI solutions in use |
| **Primary IDE** | VS Code (majority), likely others too |
| **Core need** | Shared AI memory + reliable AI orchestration, respecting organizational boundaries |

The fundamental shift: memory and orchestration must move from **per-developer local tools** to **shared organizational infrastructure** — while preserving privacy, performance, and the permission model your teams already rely on.

---

## 3. Gap Analysis

### 3.1 Server Architecture

| | Current | Enterprise requirement | Gap |
|---|---------|----------------------|-----|
| **Transport** | stdio (one process per session) | HTTP/SSE (shared server, concurrent clients) | No HTTP transport exists |
| **Concurrency** | Single user, single session | 50+ concurrent users | No connection management |
| **Deployment** | Local process per developer | Centralized server (your infrastructure) | No server deployment model |

**What this means**: Today, PLUR starts a new process for each developer session and communicates through standard I/O. Enterprise needs a long-running server that multiple developers connect to simultaneously over HTTP, using Server-Sent Events for real-time updates — the same pattern used by MCP-compatible IDEs.

### 3.2 Storage & Knowledge Graph

| | Current | Enterprise requirement | Gap |
|---|---------|----------------------|-----|
| **Primary store** | YAML files (`~/.plur/engrams.yaml`) | Database with graph + relational + vector | YAML doesn't scale for concurrent access |
| **Engram relations** | Adjacency lists in flat files | Native graph traversal | Relations exist but traversal is in-memory JS |
| **Embeddings** | In-process BGE model | Centralized vector index | Each client loads its own model |
| **Knowledge graph** | Not available | Graph queries across engrams, projects, people | No graph layer |

**What this means**: Engrams already have rich relationships (broader/narrower/related/conflicts) and weighted associations (co-access edges). These are stored as arrays in YAML and traversed in JavaScript. At organizational scale with 50 users and thousands of engrams across 1,400 repos, this data is naturally a graph: engrams connect to projects, projects belong to groups, groups contain people, people create engrams. A graph-capable database makes these queries native rather than simulated.

**Proposed solution — PostgreSQL with Apache AGE + pgvector**: Apache AGE is a PostgreSQL extension that adds Cypher graph query support. Combined with pgvector for embeddings, this gives us graph traversal, relational queries, and vector search in a single, familiar database.

```sql
-- Relational: standard user/audit queries
SELECT * FROM audit_log WHERE user_id = 42 ORDER BY created_at DESC;

-- Graph: permission traversal (Cypher via AGE)
SELECT * FROM cypher('plur', $$
  MATCH (u:User {gitlab_id: '12345'})-[:MEMBER_OF]->(g:Group)-[:OWNS]->(p:Project)
        <-[:SCOPED_TO]-(e:Engram)
  RETURN e
$$) as (engram agtype);

-- Graph: spreading activation (3-hop related engrams)
SELECT * FROM cypher('plur', $$
  MATCH (seed:Engram {id: 'ENG-2026-0421-001'})-[r*1..3]-(related:Engram)
  WHERE related.status = 'active'
  RETURN related, length(r) as distance
  ORDER BY distance, related.retrieval_strength DESC
$$) as (engram agtype, distance agtype);

-- Vector: semantic search filtered by accessible scopes
SELECT id, statement, embedding <=> $query_embedding AS distance
FROM engrams
WHERE scope = ANY($accessible_scopes)
ORDER BY distance
LIMIT 20;
```

**Maturity caveat**: AGE is an Apache Incubator project (not yet graduated). We need to validate three things before committing: (1) performance under concurrent load with realistic data, (2) compatibility with managed PostgreSQL providers the client uses, and (3) that AGE Cypher queries and pgvector can compose in the same transactions. Phase 1 includes a validation spike for this. If AGE proves insufficient, the fallback is standard PostgreSQL with recursive CTEs for graph-like queries and relational JOINs for permission resolution — functional but less elegant. The architecture is designed so this fallback requires changing the query layer only, not the data model.

### 3.3 Authentication & Identity

| | Current | Enterprise requirement | Gap |
|---|---------|----------------------|-----|
| **Authentication** | None | GitLab SSO (OAuth2/OIDC) | Nothing exists |
| **User model** | Implicit (one user = one machine) | Explicit users mapped from GitLab | No user concept |
| **Session management** | Local process lifecycle | JWT/token-based sessions | No session auth |

**What this means**: PLUR currently has no concept of "who is using it." Every engram operation is anonymous and local. Enterprise needs every request authenticated against your existing GitLab identity provider, so developers log in with the credentials they already use.

**UX challenge — authentication from within IDEs**: OAuth flows from inside MCP clients are not a solved problem across the ecosystem. Different IDE extensions (Continue, Cline, Copilot Chat, Cursor) handle authenticated MCP connections differently — some support it, some may not. The authentication UX will need to be validated per client:

| IDE/Client | Likely auth approach |
|-----------|---------------------|
| Claude Code CLI | Device code flow or pre-provisioned token |
| VS Code extensions | Browser popup OAuth or token from settings |
| Cursor | Token-based (configured in settings) |
| JetBrains | Token-based |

For the pilot, we start with the simplest mechanism that works: **pre-provisioned API tokens** (admin generates a token per developer, developer pastes it into their MCP config). This gets 10 people running immediately. Full OAuth flow is built for Phase 2 once we know which clients support it natively.

### 3.4 Authorization & Permissions

| | Current | Enterprise requirement | Gap |
|---|---------|----------------------|-----|
| **Engram access** | All engrams visible to the user | Scoped by group/project membership | Scope fields exist but are not enforced |
| **Permission model** | None | GitLab group/project membership | No enforcement layer |
| **Visibility** | `private/public/template` field exists | Enforced per-user based on role | Field exists, enforcement does not |
| **Admin controls** | None | Manage org-wide engrams, policies | No admin concept |

**What this means**: PLUR's engram schema already has `scope` (e.g., `project:myapp`, `team:backend`) and `visibility` fields — but they're metadata only. Nobody checks them. Enterprise needs these enforced: when a developer queries engrams, they see only what their GitLab group and project memberships authorize.

**Simplifications and edge cases**: GitLab's permission model is more complex than what we implement in Phase 1. We need to be explicit about what we support and what we defer:

| GitLab feature | Phase 1 | Phase 2 | Notes |
|---------------|---------|---------|-------|
| Group membership (Member/Owner) | Yes | Yes | Core permission model |
| Subgroup inheritance | Simplified | Full | Phase 1: flat group list. Phase 2: proper hierarchy traversal |
| Project membership (Developer+) | Yes | Yes | Core permission model |
| Role levels (Guest/Reporter/Developer/Maintainer/Owner) | No — all members see engrams | Yes — role-based visibility | Phase 1 treats membership as binary |
| Shared projects (project shared with external group) | No | Evaluate | Complex — may defer to Phase 3 |
| Forked projects | No | No | Fork creates a new project scope, no engram inheritance |
| Deploy tokens / CI job tokens | No | Yes | Needed for CI/CD-triggered orchestration |

This means Phase 1 permissions are simpler than GitLab's: if you're a member of a project or group, you see its engrams. Role-level granularity (can a Guest see engrams but not create them?) comes in Phase 2.

### 3.5 AI Orchestration

| | Current | Enterprise requirement | Gap |
|---|---------|----------------------|-----|
| **Task management** | None in PLUR | Reliable multi-step AI workflows | No orchestration layer |
| **Agent routing** | None | Route tasks to appropriate AI agents | No agent registry |
| **Execution tracking** | Session episodes (local) | Centralized execution audit trail | No execution management |
| **Failure handling** | None | Retry, escalation, human-in-the-loop | No reliability layer |
| **Workflow definition** | None | Configurable multi-step pipelines | No workflow engine |

**What this means**: Memory alone isn't enough. Your organization needs AI agents that can reliably execute multi-step tasks across repositories — code review, documentation generation, migration assistance, onboarding workflows. This requires orchestration: knowing which tasks need to run, which agent handles them, tracking execution, handling failures, and auditing results.

**What we bring**: PLUR's sister project (Datacore) has battle-tested orchestration **patterns** running in production:

- **Task queuing**: Priority-based queue with dependency resolution
- **Agent routing**: Specialized agents matched to task types by capability
- **Execution lifecycle**: Full state tracking with audit trails
- **Failure analysis**: Root cause analysis, retry eligibility assessment
- **Quality gates**: Multi-persona evaluation before delivery
- **Human-in-the-loop**: Results staged for human review when confidence is below threshold

These are proven patterns, not portable code. Datacore's orchestrator is deeply coupled to a single-user, single-model workflow (org-mode files, Claude Code subagents, systemd timers). The enterprise orchestrator will be **rebuilt from these patterns** for multi-user, multi-model operation. This is new development, not a packaging exercise.

**What we need to learn from you**: "Reliable orchestration" can mean many things. Before building, we need to understand your specific workflows:

- What are the 2-3 AI workflows you'd want to automate first? (e.g., MR code review, documentation generation, onboarding guides)
- How do these workflows trigger? (developer request, GitLab webhook, scheduled)
- What models/tools do your developers currently use for these tasks?
- What does "reliable" mean in your context? (SLA targets, failure tolerance, approval gates)

Phase 1 includes structured discovery sessions to define these workflows before building.

### 3.6 GitLab Integration

| | Current | Enterprise requirement | Gap |
|---|---------|----------------------|-----|
| **Group/project mapping** | Manual scope strings | Auto-mapped from GitLab API | No GitLab integration |
| **Membership sync** | N/A | Real-time or periodic sync | No external identity sync |
| **Repo-level config** | `.plur.yaml` (manual) | Auto-configured from GitLab context | Exists but not GitLab-aware |
| **CI/CD integration** | None | AI tasks triggered from pipelines | No pipeline integration |

**What this means**: When a developer opens a repository, PLUR should automatically know which GitLab project and groups it belongs to, and scope engram access accordingly. Membership changes in GitLab (someone joins/leaves a group) should propagate to PLUR permissions without manual intervention. Optionally, GitLab CI/CD pipelines can trigger orchestrated AI tasks (e.g., automated code review on merge request).

### 3.7 Multi-Model Compatibility

| | Current | Enterprise requirement | Gap |
|---|---------|----------------------|-----|
| **Protocol** | MCP (model-agnostic standard) | MCP | Aligned |
| **Search** | Local BM25 + embeddings (no LLM needed) | Must work regardless of model | Aligned |
| **LLM features** | Optional (dedup, meta-extraction) | Must work with any model endpoint | Needs endpoint abstraction |

**What this means**: PLUR's core is already model-agnostic — search and injection work without any LLM. The optional LLM-assisted features (deduplication, meta-engram extraction) currently expect OpenAI-compatible endpoints. These need to be configurable to support whatever models your developers use. The orchestration layer must also be model-agnostic — agents should work with any LLM backend. This is a small gap.

### 3.8 IDE Integration

| | Current | Enterprise requirement | Gap |
|---|---------|----------------------|-----|
| **Claude Code** | Full integration (hooks + MCP) | Works | No gap |
| **VS Code** | Via MCP-compatible extensions | Needs validation | Testing gap |
| **Other IDEs** | MCP is the universal protocol | Should work with any MCP client | Testing gap |

**What this means**: MCP is supported by most AI coding tools in VS Code (Continue, Cline, Copilot Chat, Cursor). With a centralized HTTP server, any MCP client connects to the same PLUR instance. The main work is validation and documentation, not new development. However, each client may handle authenticated MCP connections differently (see section 3.3).

### 3.9 Observability & Administration

| | Current | Enterprise requirement | Gap |
|---|---------|----------------------|-----|
| **Usage metrics** | `plur_status` tool (local stats) | Org-wide dashboard | No multi-user analytics |
| **Audit trail** | Session episodes (local) | Who learned/recalled what, when | No centralized audit log |
| **Orchestration monitoring** | None | Task execution dashboard, success rates | No execution monitoring |
| **Health monitoring** | CLI `doctor` command | Server health, alerts | No server monitoring |
| **Knowledge coverage** | Pack statistics | Which repos/teams have engrams | No org-level reporting |

**What this means**: Operations teams need visibility into adoption, health, and usage patterns — for both memory and orchestration. Currently all telemetry is local and per-user. Enterprise needs centralized logging and an admin interface that shows: who's learning what, which AI tasks are running, success/failure rates, and knowledge coverage across the organization.

### 3.10 Knowledge Quality at Scale

| | Current | Enterprise requirement | Gap |
|---|---------|----------------------|-----|
| **Curation** | Single user manages own engrams | 50 developers creating shared engrams | No quality control |
| **Contradictions** | Rare (one person) | Inevitable (multiple perspectives) | No conflict resolution |
| **Authority** | Implicit (one user = one authority) | Who decides what's true for a project? | No authority model |
| **Noise filtering** | Manual feedback | Organizational signal-to-noise ratio | No automated quality gates |

**What this means**: This is not a feature gap — it's a **product design challenge** that determines whether organizational memory becomes valuable or becomes a junk drawer.

With one person using PLUR, quality is controlled by one brain. With 50 developers:

- **Contradictions are inevitable**: Developer A learns "always use microservices for payment flows." Developer B learns "monolith for payment, keep it simple." Both are active engrams with high confidence. Which surfaces when a third developer asks about payment architecture?
- **Not every correction is worth sharing**: "Semicolons required in this project" is useful project-scoped knowledge. "I forgot to save the file" is noise. The system needs to distinguish.
- **Authority matters**: A tech lead's architectural decision should outweigh a junior developer's preference. But PLUR currently treats all learning signals equally.
- **Decay alone won't help**: Without active curation, the graph accumulates low-quality engrams faster than decay removes them at organizational scale.

**Our approach**:

| Mechanism | Description | Phase |
|-----------|-------------|-------|
| **Scope-based isolation** | Personal engrams don't pollute project scope. Each developer's corrections stay personal unless promoted. | 1 |
| **Promotion workflow** | Engrams must be explicitly promoted from personal → project → group → org scope. Promotion requires appropriate role (Developer+ for project, Maintainer+ for group). | 2 |
| **Contradiction detection** | When a new engram contradicts an existing one in the same scope, flag both for review. Uses PLUR's existing `conflicts` relation edges. | 2 |
| **Confidence weighting by role** | Tech lead engrams start with higher base confidence than junior developer engrams within the same project scope. Not hard gating — just ranking. | 2 |
| **Automated noise filtering** | Engrams that receive consistent negative feedback across multiple users are auto-demoted. Engrams with zero recalls after N days are flagged for review. | 2 |
| **Knowledge steward role** | Per-project or per-group role for curating shared engrams. Can merge, retire, or promote. Maps to GitLab Maintainer role. | 2 |

This is an ongoing product design challenge, not a one-time feature. We'll learn what works through the pilot.

---

## 4. Enterprise Architecture

### 4.1 Deployment topology

```
Developer workstations                    Your infrastructure
========================                  =====================

VS Code + Continue  ─────┐
VS Code + Cline     ─────┤
VS Code + Copilot   ─────┤               ┌──────────────────────┐
Claude Code CLI     ─────┤   HTTPS/SSE   │   PLUR Enterprise    │
Cursor              ─────┼──────────────→ │                      │
JetBrains + MCP     ─────┤               │   ┌───────────────┐  │
Other MCP clients   ─────┘               │   │ HTTP Server    │  │
                                          │   │ (MCP + Admin)  │  │
GitLab webhooks     ─────────────────────→│   └───────┬───────┘  │
CI/CD pipelines     ─────────────────────→│           │          │
                                          │   ┌───────┴───────┐  │
                                          │   │ Background     │  │
                                          │   │ Workers        │  │
                                          │   └───────────────┘  │
                                          └──────────┬───────────┘
                                                     │
                                          ┌──────────┴───────────┐
                                          │                       │
                                   ┌──────┴───────┐    ┌────────┴────────┐
                                   │ PostgreSQL    │    │ GitLab API      │
                                   │ + AGE (graph) │    │ (SSO + groups   │
                                   │ + pgvector    │    │  + webhooks)    │
                                   └──────────────┘    └─────────────────┘
```

**Operational reality**: This is not a single binary. The enterprise deployment consists of:

| Component | Purpose |
|-----------|---------|
| **HTTP server** | MCP protocol (memory + orchestration tools), admin API, SSE connections |
| **Background workers** | Embedding generation, GitLab membership sync, orchestration task dispatch, decay computation |
| **PostgreSQL** | With AGE and pgvector extensions — requires non-default Postgres setup or compatible managed provider |
| **Job queue** | Redis or PostgreSQL-based (SKIP LOCKED) for worker coordination |

All components are containerized (Docker Compose for pilot, Kubernetes-ready for production). The operational burden is comparable to running a typical web application with a background worker — not a distributed system, but not a single process either.

### 4.2 The unified knowledge graph

With Apache AGE, all data lives in one PostgreSQL instance as both relational tables and a graph:

```
                        ┌─────────────┐
              ┌────────→│   :Group     │←──────────┐
              │         └─────────────┘            │
        [:MEMBER_OF]          │               [:SUBGROUP_OF]
              │          [:OWNS]                    │
        ┌─────┴─────┐        │            ┌───────┴───────┐
        │   :User    │   ┌───┴─────┐      │    :Group     │
        └─────┬─────┘   │ :Project │      └───────────────┘
              │         └───┬─────┘
        [:CREATED]          │
              │      [:SCOPED_TO]
              ▼             │
        ┌─────────────┐    │       ┌──────────────┐
        │   :Engram    │←──┘  ┌───→│   :Agent     │
        └──┬───┬───┬──┘      │    └──────┬───────┘
           │   │   │          │      [:HAS_CAPABILITY]
  [:RELATED] │ [:BROADER]    │           │
           │   │   │    [:ASSIGNED_TO]   ▼
           ▼   ▼   ▼         │    ┌──────────────┐
     (other engrams)    ┌────┴──┐ │ :Capability   │
                        │ :Task │ └──────────────┘
                        └───┬───┘
                            │
                      [:DEPENDS_ON]
                            │
                            ▼
                       (other tasks)
```

This graph enables queries that would be complex or impossible with flat relational tables:

| Query | Graph approach |
|-------|---------------|
| "What does the backend team know about authentication?" | Traverse group→projects→engrams, filter by domain |
| "Who has expertise in payment processing?" | Aggregate engrams by creator, ranked by activation strength |
| "What knowledge paths connect this error to past decisions?" | `shortestPath()` between engram nodes |
| "Which ready tasks have all dependencies met?" | Pattern match on task dependency subgraph |
| "If we retire this engram, what depends on it?" | Impact traversal across related edges |
| "What did the AI learn from last week's code reviews?" | Time-filtered traversal: executions→produced engrams |

### 4.3 Authentication flow

**Phase 1 (pilot)**: Token-based authentication.

```
Admin generates API token per developer in PLUR admin
        │
        ▼
Developer adds token to their MCP client config
  (e.g., VS Code settings, Claude Code .mcp.json)
        │
        ▼
Every MCP request includes token in headers
        │
        ▼
Server validates token → resolves user → scoped access
```

This works immediately with every MCP client. No browser popups, no OAuth complexity, no per-client compatibility concerns.

**Phase 2 (production)**: Full GitLab OAuth2/OIDC.

```
Developer opens IDE → MCP client connects to PLUR server
        │
        ▼
Server returns auth challenge with GitLab OAuth URL
        │
        ▼
Developer authenticates via browser (OAuth redirect or device code flow)
        │
        ▼
Server receives GitLab token → resolves identity + memberships
        │
        ▼
Session token issued → MCP tools available with scoped access
```

The specific OAuth mechanism (browser redirect vs. device code flow) will be determined per IDE client during Phase 1 validation. Token-based auth remains available as a fallback for clients that don't support interactive authentication.

### 4.4 Permission model

The permission model maps directly to GitLab's existing structure, represented as graph edges:

| GitLab concept | Graph representation | Access rule |
|---------------|---------------------|-------------|
| User (personal) | `(:User)-[:OWNS]->(:Engram)` | Only the user sees their personal engrams |
| Project | `(:User)-[:MEMBER_OF]->(:Group)-[:OWNS]->(:Project)` | Project members see project-scoped engrams |
| Group | `(:User)-[:MEMBER_OF]->(:Group)` | Group members see group-scoped engrams |
| Subgroup | `(:Group)-[:SUBGROUP_OF]->(:Group)` | Inherits: parent group members see child engrams |
| Organization-wide | `(:Engram)-[:SCOPED_TO]->(:Org)` | All authenticated users (admin-curated) |

**Inheritance**: A developer in group `backend` who works on project `backend/payments-api` sees:
- Their personal engrams
- All `group:backend` engrams
- All `project:backend/payments-api` engrams
- All org-wide engrams (company-wide knowledge)

**Write rules**: By default, developers can create engrams scoped to projects they have Developer+ access to and groups they belong to. Admins can create org-wide engrams. The orchestrator creates engrams scoped to the project where the task originated.

**What we deliberately simplify**: See section 3.4 for the full Phase 1 vs. Phase 2 permission matrix. Phase 1 treats membership as binary (member or not); role-level granularity (can a Guest see engrams but not create them?) comes in Phase 2.

### 4.5 Memory data flow

When a developer uses PLUR through their IDE:

**Learning** (developer corrects AI, AI captures the correction):
1. MCP tool `plur_learn` called with statement + context
2. Server authenticates request (token or JWT)
3. Server resolves scope from active repository → GitLab project
4. Engram node created in graph with scope edges + relation edges
5. Embedding generated asynchronously by background worker
6. Audit log entry written

**Recall** (AI searches for relevant knowledge):
1. MCP tool `plur_recall_hybrid` called with query
2. Server authenticates request
3. Graph traversal resolves user's accessible scopes
4. BM25 + pgvector search filtered by accessible scopes
5. Results ranked by activation strength, returned to client
6. Usage metrics updated

**Injection** (session start, relevant engrams auto-loaded):
1. MCP tool `plur_session_start` called with task description
2. Graph traversal resolves all accessible scopes for user
3. Hybrid search across accessible engrams within token budget
4. Spreading activation traverses relation edges (native graph operation)
5. Layered context returned (high/medium/low priority)

### 4.6 Orchestration data flow

When an AI task needs to be executed:

**Task creation**:
1. Task created via MCP tool, GitLab webhook, or CI/CD trigger
2. Task node added to graph with scope, dependencies, and required capabilities
3. If dependencies exist, edges created to blocking tasks

**Execution**:
1. Orchestrator queries graph for ready tasks (no unmet dependencies, within user's scope)
2. Agent matched by capability edges: `(:Task)-[:REQUIRES]->(:Capability)<-[:HAS]->(:Agent)`
3. Agent receives task + relevant engrams (injected from knowledge graph)
4. Execution tracked as graph node with edges to task, agent, and produced artifacts
5. On completion: task state updated, output engrams created, audit logged
6. On failure: failure analyzed, retry eligibility assessed, human escalation if needed

**Workflow**:
1. Multi-step workflows defined as connected task subgraphs
2. Completion of one task triggers readiness check on downstream tasks
3. Full execution lineage queryable: "Show me everything that happened for this workflow"

### 4.7 Data isolation and multi-org readiness

Even in Phase 1 (single organization), the database schema is designed for multi-tenant operation from day one:

- **Schema-per-org**: Each organization gets its own PostgreSQL schema with its own AGE graph. This is not a Phase 3 bolt-on — it's the architecture from the start.
- **Org context**: Every request is executed within an org context. Phase 1 simply has one org.
- **Configuration**: Org-level settings (injection budget, decay policy, orchestration rules) are per-schema.

This means Phase 3 (white-label / multi-tenant) requires adding onboarding workflows and admin UI, not re-architecting the database.

---

## 5. Bootstrapping: The Cold Start Problem

On day one, the knowledge graph is empty. Fifty developers connecting to an empty memory system get zero value. This is a real risk — if the first two weeks feel useless, adoption dies.

### Bootstrapping strategy

| Phase | Action | Result |
|-------|--------|--------|
| **Pre-pilot** | Import existing documentation from GitLab (README files, wiki pages, CONTRIBUTING guides) as seed engrams per project | Developers immediately see project-relevant knowledge on session start |
| **Pre-pilot** | Install domain-relevant knowledge packs (language conventions, framework patterns, security best practices) | General programming knowledge available from day one |
| **Week 1** | Focus the pilot 10 developers on 3-5 active projects where they'll make frequent corrections | Concentrated learning in high-activity areas builds useful knowledge fast |
| **Week 2-4** | Weekly review of accumulated engrams with pilot team — promote high-quality ones to project/group scope | Quality curation from the start, establishes promotion workflow |
| **Ongoing** | Every new project gets a seed engram pack generated from its README + CI config | No project starts completely cold |

### Realistic value timeline

| Timeframe | What the team should expect |
|-----------|---------------------------|
| Day 1 | Seed knowledge available — documentation and best practices. Value: modest but non-zero. |
| Week 2 | Active projects have 20-50 developer-created engrams. AI starts giving project-specific context. |
| Month 1 | Knowledge graph has meaningful connections. Developers notice AI "remembering" team decisions. |
| Month 2+ | Compound value — new developers get onboarded with organizational knowledge that took months to accumulate. |

We should be honest with the pilot team: the system gets more valuable over time. The first week is about feeding it, not extracting value from it.

---

## 6. Open Core Model

PLUR is and remains open source. The enterprise capabilities are a separate layer on top of the open core.

### What stays open source (PLUR)

Everything an individual developer needs:

- Engram engine (storage, search, injection, decay, feedback)
- All storage backends (YAML, SQLite, PostgreSQL + AGE)
- MCP server (stdio transport — single-user)
- CLI (all 12 commands)
- Knowledge packs (create, install, export, discover)
- Platform plugins (Claude Code, OpenClaw, Hermes)
- Hybrid search (BM25 + local embeddings)
- Git-based sync

### What's in the enterprise tier (PLUR Enterprise)

Everything an organization needs to run PLUR for a team:

- **Server**: HTTP/SSE MCP server (multi-user, centralized)
- **Identity**: SSO integration (GitLab, GitHub, generic OIDC)
- **Permissions**: Scope-based access control with graph-enforced boundaries
- **Orchestration**: Task queuing, agent routing, execution tracking, failure handling
- **Quality**: Engram promotion workflows, contradiction detection, knowledge stewardship
- **Administration**: Dashboard, audit logging, usage analytics, configuration
- **Support**: SLA, priority issue resolution

### Why this boundary

The line is drawn at **coordination**. A solo developer never needs SSO, RBAC, orchestration queues, or an admin dashboard. These capabilities only matter when multiple people and agents share a system. This is the same boundary drawn by GitLab (CE vs. EE), Grafana (OSS vs. Enterprise), and most successful open-core companies.

Storage backends (including PostgreSQL + AGE) stay open source. A solo developer might want graph queries for their personal knowledge. That choice shouldn't be paywalled — and keeping it open drives adoption of the engine that the enterprise tier builds on.

---

## 7. White-Label & Reseller Model

PLUR Enterprise can be deployed as a white-label solution, branded under your organization's identity. This enables a reseller model where you offer AI memory and orchestration as part of your services portfolio.

### What white-label includes

- **Custom branding**: Your logo, colors, and name on the admin dashboard and documentation
- **Custom domain**: `ai-platform.yourcompany.com` instead of `plur.ai`
- **Your identity provider**: Your clients authenticate through your systems
- **Multi-organization tenancy**: Each of your clients is a separate tenant with full isolation

### Architecture for reseller deployment

```
Your client organizations            Your infrastructure
============================         =====================

Client A developers  ─────┐
  (their GitLab)           │
                           │         ┌───────────────────────┐
Client B developers  ─────┼───────→ │  [Your Brand] Server   │
  (their GitLab)           │         │  (PLUR Enterprise)     │
                           │         │                        │
Client C developers  ─────┘         │  Memory + Orchestration │
                                    └──────────┬────────────┘
                                               │
                                    ┌──────────┴────────────┐
                                    │                        │
                             ┌──────┴───────┐     ┌────────┴─────────┐
                             │ PostgreSQL    │     │ Identity          │
                             │ + AGE + pgvec│     │ Federation        │
                             │ (per-org     │     │ (multi-IdP)       │
                             │  schemas)    │     └──────────────────┘
                             └──────────────┘
```

### Multi-organization isolation

| Layer | Isolation method |
|-------|-----------------|
| **Data** | Separate PostgreSQL schemas per client organization — each org gets its own graph |
| **Identity** | Each client organization connects their own IdP (GitLab, GitHub, OIDC) |
| **Configuration** | Per-organization settings (injection budget, decay policy, orchestration rules, agent capabilities) |
| **Billing** | Per-organization usage tracking (your billing, your pricing) |

Your clients' data never mixes. Organization A cannot see Organization B's engrams or tasks, even at the database level. Each organization is a self-contained knowledge graph.

Because multi-org isolation is built into the schema from Phase 1 (section 4.7), the white-label model doesn't require re-architecting. It requires onboarding automation, admin UI, and identity federation — new features, not structural changes.

### What this means for you

- You deploy one PLUR Enterprise instance
- You onboard client organizations as tenants
- Each client connects their own identity provider
- You set your own pricing and terms
- PLUR provides the engine; you provide the service
- Each client gets memory + orchestration + admin scoped to their organization

---

## 8. Implementation Phases

### Phase 1 — Pilot (10 developers, your organization)

**Goal**: Prove value with a small team on real repositories.

**Duration**: 3 months

**Scope**:
- AGE validation spike (week 1-2): benchmark graph queries under realistic load, validate managed Postgres compatibility. Go/no-go decision for AGE vs. recursive CTE fallback.
- Centralized PLUR server with HTTP/SSE transport
- PostgreSQL + AGE + pgvector backend (schema-per-org from day one)
- Token-based authentication (admin-provisioned)
- GitLab API integration for membership import
- Basic scope enforcement (personal + project-level)
- Memory: learn, recall, inject working across the team
- Bootstrapping: seed engrams from existing documentation
- Orchestration: basic task queuing and execution tracking for 1-2 defined workflows
- VS Code compatibility validated with 2-3 MCP clients
- Orchestration discovery: structured sessions to define target workflows

**Success criteria**:
- 10 developers using PLUR daily in their IDE
- Engrams accumulating for active projects
- At least one orchestrated AI workflow running (defined during discovery sessions)
- Measurable improvement in onboarding or code review quality
- AGE validated or fallback path confirmed

### Phase 2 — Production (50 developers, full feature set)

**Goal**: Roll out to the full organization with complete access control and orchestration.

**Scope**:
- Full GitLab OAuth2/OIDC SSO (with token fallback for incompatible clients)
- Full GitLab group/project permission model with role-level granularity
- Membership sync (periodic or webhook-based)
- Full orchestration: multi-step workflows, agent routing, failure handling, human-in-the-loop
- Knowledge quality: promotion workflows, contradiction detection, knowledge steward role
- Admin dashboard (usage, health, audit, orchestration monitoring)
- Team knowledge features (org-wide packs, coverage reporting)
- CI/CD integration (GitLab pipelines can trigger orchestrated tasks)
- Monitoring and alerting

**Success criteria**:
- All 50 developers onboarded
- Permission model correctly reflects GitLab structure
- Multiple orchestrated workflows in production
- Knowledge quality metrics trending positive (fewer contradictions, healthy promotion rate)
- Admin team can manage org-wide knowledge and monitor orchestration
- AI tasks completing reliably with full audit trail

### Phase 3 — White-label & Multi-tenant (your clients)

**Goal**: Offer AI memory and orchestration as a service to your client organizations.

**Scope**:
- Multi-organization management (create/configure/monitor org tenants)
- Identity federation (each client's IdP — GitLab, GitHub, OIDC, SAML)
- White-label branding (dashboard, docs, domain)
- Per-organization configuration and billing hooks
- Reseller admin panel (manage client orgs, monitor cross-org health)
- Self-service client onboarding
- Client-specific bootstrapping (seed from their documentation sources)

**Success criteria**:
- First client organization onboarded through your platform
- Full data isolation verified (security audit)
- Self-service client onboarding operational
- Revenue model validated

---

## 9. Competitive Landscape

We should be transparent about alternatives and our differentiation.

### Memory alternatives

| Product | Approach | Differentiation from PLUR |
|---------|----------|--------------------------|
| **Supermemory** | Cloud-hosted memory service | Requires sending all data to their cloud. PLUR is self-hosted — data stays on your infrastructure. |
| **mem0** | Memory API (cloud + open source) | General-purpose memory, not optimized for code/development workflows. No orchestration. |
| **Zep** | Long-term memory for AI apps | Focused on chatbot/RAG use cases, not developer tooling. No IDE integration. |

### Orchestration alternatives

| Product | Approach | Differentiation from PLUR |
|---------|----------|--------------------------|
| **Temporal** | Durable workflow execution | General-purpose workflow engine. Not AI-native — no memory injection, no engram-informed routing. |
| **LangGraph / CrewAI** | Multi-agent frameworks | Framework, not infrastructure. Each developer runs their own agents with no shared memory or organizational orchestration. |
| **GitLab CI/CD** | Pipeline automation | Already in use. PLUR complements it — AI tasks can be triggered from pipelines but execute with organizational memory. |

### Our position

PLUR's differentiation is the **combination**:
- Memory + orchestration in one system (competitors offer one or the other)
- Graph-based knowledge that connects people, projects, and knowledge (not just a key-value store)
- Open source core with self-hosted enterprise tier (data sovereignty)
- Model-agnostic via MCP (works with whatever tools the team already uses)
- Designed for development workflows, not generic AI applications

### Our weakness

- Small team, no enterprise track record. This partnership builds that credibility.
- No managed SaaS offering (yet). The client must host or we host on their behalf.
- New product. The open source version is used in production, but enterprise features are greenfield.

---

## 10. Design Partnership

This is a partnership proposal, not a vendor pitch. We're proposing to build PLUR Enterprise together.

### What you get

- Enterprise-grade AI memory and orchestration before it's generally available
- Direct influence on the roadmap — your needs are built first
- White-label rights to resell under your brand
- Priority support from the team building the engine

### What we get

- A real enterprise deployment driving real requirements
- A reference customer for future enterprise sales
- Distribution into organizations we wouldn't reach alone
- Feedback that shapes the product correctly

### How it works

- **Phase 1** is a design partnership — we build and iterate together, including orchestration discovery sessions
- **Phase 2** transitions to a service agreement with committed terms
- **Phase 3** is a reseller agreement with revenue sharing
- Case study and reference rights are agreed upfront

### Open source commitment

Everything we build for the PLUR engine (storage backends, search improvements, protocol enhancements) goes back to the open source project. The enterprise tier (auth, permissions, orchestration, multi-tenant, admin) is a separate commercial product. Your investment improves the ecosystem for everyone while giving you exclusive early access to the enterprise capabilities.

---

## Appendix A: Technology Decisions

### Why PostgreSQL + AGE (not a separate graph database)

We evaluated Neo4j, Memgraph, SurrealDB, and FalkorDB. PostgreSQL with Apache AGE was selected for the enterprise backend because:

| Factor | PostgreSQL + AGE | Separate graph DB |
|--------|-----------------|-------------------|
| **Operational familiarity** | Your team already knows Postgres | New system to learn and operate |
| **Infrastructure** | One database instance | Two databases to manage |
| **Tabular queries** | Native SQL | Awkward or requires a second store |
| **Graph queries** | Cypher via AGE extension | Native Cypher |
| **Vector search** | pgvector (mature, battle-tested) | Varies by vendor |
| **Licensing** | PostgreSQL + AGE: fully open source | Neo4j Enterprise: commercial license |
| **Risk** | Drop the extension, keep Postgres | Migration project if it doesn't work out |
| **Managed hosting** | Every cloud provider | Limited options |

**Maturity risk**: AGE is in Apache Incubator (not graduated). Phase 1 includes a dedicated validation spike to confirm it meets our needs. If not, the fallback is standard PostgreSQL with recursive CTEs for graph-like queries — less elegant but functionally equivalent for our use cases. The data model is the same either way; only the query layer changes.

### Why graph capabilities matter

PLUR's engram schema already models a graph (relations, associations, scopes). The orchestration layer adds task dependencies, agent capabilities, and execution lineage. The permission model maps organizational hierarchy to data access. All of these are graph problems being solved with flat-file workarounds today. AGE makes them native.

---

## Appendix B: Current PLUR Metrics

| Metric | Value |
|--------|-------|
| Engram schema version | 2 |
| MCP tools | 32 |
| Search modes | 4 (BM25, semantic, hybrid, agentic) |
| Platform integrations | 3 (Claude Code, OpenClaw, Hermes) |
| LongMemEval benchmark | 86.7% Hit@10 |
| LoCoMo benchmark | 60% accuracy (agentic), 100% retrieval |
| Storage backends | 2 (YAML, SQLite) + factory pattern for new backends |
| CLI commands | 12 |
| License | Open source |

---

## Appendix C: Orchestration Patterns (from Datacore)

The orchestration layer is built from patterns proven in a production system running autonomous AI tasks nightly. These are **design patterns**, not portable code — the enterprise orchestrator is purpose-built for multi-user, multi-model operation.

| Pattern | Description | Enterprise adaptation |
|---------|-------------|----------------------|
| **Priority queue with dependency resolution** | Tasks queued by priority, only dispatched when dependencies are met | Graph-based dependency traversal replaces file-based scanning |
| **Capability-based agent routing** | Tasks matched to agents by type (research, content, code review, data analysis) | Agent registry as graph nodes, capability matching via traversal |
| **State machine execution** | Pending → in_progress → completed/failed with full state tracking | Execution nodes in graph with lineage edges |
| **Multi-persona quality gates** | Output evaluated by multiple assessment criteria before delivery | Configurable per workflow, per organization |
| **Failure analysis and retry** | Root cause analysis of failed tasks, retry eligibility assessment | Failure patterns accumulated as engrams — system learns from its mistakes |
| **Human-in-the-loop escalation** | Results staged for human review when confidence is below threshold | Notification via GitLab comments, Slack, or dashboard |
| **Context injection** | Relevant engrams automatically injected into agent context before execution | Native: orchestrator queries knowledge graph for task-relevant engrams |
| **Cost tracking** | Token usage and execution cost monitoring per task | Per-organization, per-project, per-agent cost attribution |
