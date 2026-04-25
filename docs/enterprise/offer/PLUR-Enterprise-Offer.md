# PLUR Enterprise — Founding Partner Proposal

**Prepared for:** [Client Name]
**Date:** May 2026
**From:** Datafund d.o.o.

---

## The Problem

Your 50 developers work across 1,400 repositories and 300 GitLab groups. Every AI tool they use today starts every session from zero. No memory of your conventions, your architectural decisions, or the mistakes your team already made.

**What this costs you:**

- Developers spend **1.8 hours/day** searching for information (McKinsey)
- Context switching costs **~EUR 50,000/year per developer** (multiple studies)
- Fortune 500 companies lose **$31.5 billion/year** failing to share knowledge
- New hires take 3-6 months to learn "how we do things here"
- Post-mortem knowledge dies in Confluence pages nobody reads

AI tools are powerful. But without organizational learning, they're amnesiac assistants that treat every conversation like the first.

---

## The Solution: Organizational Learning

PLUR Enterprise gives your AI tools persistent, shared, permission-aware memory that **learns from your team and gets smarter over time**.

This is not shared storage. This is organizational learning:
- A developer corrects the AI on Monday — every teammate's AI knows it on Tuesday
- Conventions captured once persist across all sessions, all IDEs
- Knowledge compounds instead of resetting
- Scoped to your GitLab permissions — teams only see what they should

### What makes this different from Copilot, Cursor, or any other AI tool

| | Generic AI tools | PLUR Enterprise |
|---|---|---|
| Memory between sessions | None or 28-day expiry | Persistent, no expiry |
| Learns from corrections | No | Yes — correction-based learning |
| Shares knowledge across team | No | Yes — org-wide knowledge graph |
| Respects your org structure | No | GitLab group/project permissions |
| Gets smarter over time | No | Feedback-trained retrieval |
| Works with any IDE | Single vendor lock-in | MCP protocol — works with all |

No competitor has correction-based learning, spreading activation retrieval, or organizational knowledge sharing. This is validated by a16z's April 2026 thesis: "user corrections and feedback loops are the future of AI learning" — which is exactly what PLUR does.

---

## What You Get

### 1. PLUR Enterprise — Organizational Learning (subscription)

Your AI tools connected to shared organizational memory.

**Includes:**
- PLUR Enterprise server (HTTP/SSE MCP, multi-user)
- PostgreSQL + AGE (knowledge graph) + pgvector (semantic search)
- GitLab SSO (OAuth2/OIDC + PKCE)
- Scope-based access control + role-level permissions
- MCP tool security (allowlist, write enforcement, audit)
- Admin dashboard (usage, health, audit log)
- Deployment, TLS, CI/CD, monitoring & alerting
- Infrastructure hosting & AI compute (included)
- Security patches, platform upgrades
- Priority bug fixes (< 24h response, < 72h resolution)
- Weekly check-ins + quarterly strategic reviews

**Pricing:**
- List price: EUR 70/seat/month
- **Founding Partner price: EUR 49/seat/month (30% discount)**
- 50 seats = EUR 2,450/month
- 12-month commitment starting at go-live

### 2. Knowledge Engineering (one-time custom project)

We scan your codebase, extract your conventions, and build your custom ingest pipeline.

**Phase A — 30 Active Repos (high-touch):**
- Start with first 5 repos, present results, get feedback, tune
- Iterate on next batches with refined pipeline
- Convention extraction, engram generation, knowledge pack curation
- Multiple passes with your tech leads
- Custom ingest pipeline development (reusable for Phase B)

**Phase B — 1,370 Repos (automated):**
- Run tuned pipeline on all remaining repos
- Quality review and outlier handling
- New project hook — every new repo auto-bootstrapped on creation
- Coverage report and handover

**Deliverables:**
- Custom ingest pipeline tuned to your codebase (reusable, automated)
- 30 active repos: curated knowledge packs, reviewed with your tech leads
- 1,370 repos: auto-processed, coverage report
- New project hook: every new repo auto-bootstrapped on creation

**Pricing:** Standard consulting rate, invoiced on actuals with weekly reporting. See cost breakdown for detail.

### 3. Datacore Enterprise — AI Development Team (Q3/Q4 2026)

Autonomous AI agents powered by your organizational learning. Separate product, same partnership.

**Three AI roles (scoped together after PLUR is in place):**

- **AI Chief of Staff** — organizational intelligence. Answers any question about your 1,400 repos, decisions, and team activity.
- **Insight Agent** — proactive pattern detection. Surfaces what you didn't know to ask across teams and projects.
- **Onboarding Companion** — interactive guide for new developers, built from your actual conventions and decisions.

Priced as monthly AI roles. Exact scope determined together based on your workflows and priorities.

---

## Timeline

| When | Milestone | Details |
|------|-----------|---------|
| Early May | Contract signed | |
| May W1-2 | Integration + first 5 repos | GitLab SSO, deployment + scanning first 5 repos in parallel |
| May W2-3 | Feedback loop | Present results to tech leads, tune extraction pipeline |
| May W3-4 | Test run + next batch | Infra live, 10-15 users collecting memories. Next 10-15 repos scanned. |
| June | Onboarding — subscription starts | 50 users, setup workshop. 20-30 repos curated, packs deployed. |
| June-July | Phase A completes | Remaining active repos, pipeline refinement |
| July-Aug | Phase B | 1,370 repos automated, new project hook, handover |
| Q3/Q4 2026 | Datacore Enterprise | AI Development Team scoped together |

**Subscription starts at go-live (June), not at contract signing. Integration and test run (May) are included — no charges before go-live.**

---

## The Business Case

**Conservative estimate: saving 15 minutes/day per developer.**

| Metric | Value |
|--------|-------|
| Recovered time (50 devs x 15 min x 220 days) | 2,750 hours/year |
| Recovered value (at EUR 85/hour) | ~EUR 234,000/year |
| First-year investment | ~EUR 45,000 |
| **ROI** | **~5x** |
| **Break-even** | **~2.5 months** |

Studies show 25-55% developer productivity gains with AI tools (GitHub/Accenture). We're using a conservative 15 min/day — less than 4% of a developer's day.

---

## Founding Partner Benefits

- **30% discount** on PLUR Enterprise subscription (Founding Partner rate)
- **Guaranteed best rate** — you will never pay more than any future customer
- Influence on product roadmap — your requirements built first
- White-label & reseller rights (pre-negotiated for future)
- Partnership continues with Datacore Enterprise on same terms
- Case study & reference customer agreement
- Integration phase included — no charges before go-live
- Weekly check-ins + quarterly strategic reviews

---

## Market Context

| Product | Price/seat/month | What it offers |
|---------|-----------------|----------------|
| GitHub Copilot Enterprise | $39-60 | Code completion, 28-day memory, no learning |
| Augment Code Standard | $60 | Project memory, no correction-based learning |
| Sourcegraph Cody Enterprise | $59 | Code search, no persistent memory |
| JetBrains AI Enterprise | $60+ | IDE AI features, no org memory |
| **PLUR Enterprise (list)** | **EUR 70** | **Persistent org learning, knowledge graph** |
| **PLUR Enterprise (Founding Partner)** | **EUR 49** | **Same — 30% Founding Partner discount** |

---

## Architecture

```
Developer IDEs                        Your Infrastructure
================                      ====================

VS Code + Continue  ───┐
VS Code + Cline     ───┤
Cursor              ───┤  HTTPS/SSE   ┌──────────────────┐
Claude Code         ───┼─────────────>│  PLUR Enterprise  │
JetBrains + MCP     ───┤              │  (MCP Server)     │
Other MCP clients   ───┘              └────────┬─────────┘
                                               │
GitLab webhooks     ──────────────────>        │
                                      ┌────────┴─────────┐
                                      │ PostgreSQL        │
                                      │ + AGE (graph)     │
                                      │ + pgvector        │
                                      └──────────────────┘
```

- **Self-hosted** — your data stays on your infrastructure
- **MCP protocol** — works with any AI tool that supports Model Context Protocol
- **GitLab SSO** — developers log in with existing credentials
- **No vendor lock-in** — open source core, open data format

---

## Team

| Name | Role | Focus |
|------|------|-------|
| **Gregor** | Project Director, Lead Dev | Architecture, AI agent design, orchestration |
| **Tadej** | CTO, Tech Lead | Backend, auth, permissions, production readiness |
| **Marko** | DevOps | Infrastructure, CI/CD, monitoring, deployment |
| **Crt** | PM, Data Scientist | Knowledge engineering, onboarding, client coordination |

---

## Next Steps

1. Review this proposal and the detailed cost breakdown
2. Schedule a meeting to discuss your priorities
3. Agree on Founding Partner terms
4. Begin integration + first 5 repos (May)

---

**Contact:** Gregor Zavcer, gregor@datafund.io
**Web:** plur.ai
