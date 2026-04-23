# PLUR Enterprise — Design Partnership Proposal

**Prepared for:** [Client Name]
**Date:** April 2026
**From:** Datafund d.o.o.

---

## The Problem

Your 50 developers work across 1,400 repositories and 300 GitLab groups. Every AI tool they use today — Copilot, Cursor, Claude — starts every session from zero. No memory of your conventions, your architectural decisions, or the mistakes your team already made.

The result:

- **Developers re-explain the same things** to AI tools, session after session
- **Tribal knowledge lives in people's heads** — when they leave, it leaves with them
- **New hires take months** to understand "how we do things here"
- **The same mistakes repeat** because post-mortem knowledge never reaches the next developer who touches that code
- **Teams duplicate work** across 300 groups without knowing someone already solved the problem

AI tools are powerful. But without organizational memory, they're amnesiac assistants that treat every conversation like the first.

---

## The Solution

PLUR Enterprise gives your AI tools persistent, shared, permission-aware memory.

**Phase 1 — Shared Memory**
Every developer's AI tools connect to a shared knowledge server. Corrections persist. Decisions stick. A developer learns something on Monday, and every teammate's AI knows it on Tuesday. Scoped to your GitLab permissions — teams only see what they should.

**Phase 2 — Knowledge Engineering**
We scan your 1,400 repositories and extract the conventions, patterns, and rules that currently live only in people's heads. Packaged as living knowledge packs that update when your code changes. New projects get bootstrapped automatically.

**Phase 3 — AI Development Team**
Three AI roles that use your organizational memory to do real work:

### AI Chief of Staff
Operational intelligence across your entire org. Ask it anything:
- "What's happening across the backend group this sprint?"
- "Why did we build the payment service this way?"
- "Which teams are working on similar problems?"

It knows — because it has access to the accumulated knowledge from every team, every project, every decision. Today, no single person can hold this context across 1,400 repos. The Chief of Staff can.

### Insight Agent
Doesn't wait for questions. Proactively surfaces what you didn't know to ask:
- "Team A and Team C are solving the same auth problem differently"
- "This architectural decision from January correlates with 30% of recent CI failures"
- "Three repos drifted from your deployment convention this month"

Runs continuously against your knowledge graph. Turns accumulated memory into actionable intelligence.

### Onboarding Companion
Day 1, every new developer gets an interactive guide that knows every project they'll touch. Not a static wiki — a companion that answers "why do we do it this way?" from actual team decisions, not outdated documentation.

The difference: new hires submitting meaningful MRs in week 1 instead of month 2.

---

## Why This Works (and why generic AI tools can't do it)

These three roles are **impossible without organizational memory**. GitHub Copilot can write code. ChatGPT can answer questions. But neither of them can:

- Tell you why YOUR team chose microservices for payment flows
- Warn you that the last time someone changed THIS config, staging broke for 3 days
- Notice that two teams across different groups are solving the same problem

PLUR's differentiator is the **knowledge graph** — engrams (learned knowledge units) connected to projects, groups, people, and decisions. Powered by PostgreSQL with Apache AGE (graph queries) and pgvector (semantic search). Self-hosted on your infrastructure. Your data never leaves your servers.

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
CI/CD pipelines     ──────────────────>        │
                                      ┌────────┴─────────┐
                                      │ PostgreSQL        │
                                      │ + AGE (graph)     │
                                      │ + pgvector        │
                                      └──────────────────┘
```

- **MCP protocol** — works with any AI tool that supports Model Context Protocol
- **GitLab SSO** — developers log in with existing credentials
- **Permission-aware** — respects your GitLab group/project membership model
- **Self-hosted** — your data stays on your infrastructure

---

## Timeline & Deliverables

| Phase | Duration | Deliverable | Value |
|-------|----------|-------------|-------|
| **Phase 1** | Months 1-2 | Shared Memory for 50 users | AI tools remember across sessions and across your team |
| **Phase 2** | Months 2-4 | Knowledge Engineering | 1,400 repos scanned, conventions extracted, living knowledge packs |
| **Phase 3** | Months 4-6 | AI Development Team | Chief of Staff, Insight Agent, Onboarding Companion |

First value delivered: **working shared memory in weeks, not months.**

---

## Pricing

### Project Delivery

| Phase | Description | Standard | Design Partner |
|-------|-------------|----------|----------------|
| Phase 1 | Shared Memory (50 users) | See cost breakdown | -20% |
| Phase 2 | Knowledge Engineering | See cost breakdown | -20% |
| Phase 3 | AI Development Team | See cost breakdown | -20% |

Detailed cost breakdown with per-person hours: **see PLUR-Enterprise-Cost-Breakdown.xlsx**

### Monthly Support & Maintenance

Starts after Phase 1 delivery:

- Security patches, dependency updates, PLUR core upgrades
- Infrastructure monitoring, 99.5% uptime SLA, incident response
- Knowledge pipeline tuning (extraction quality, pack curation)
- New user onboarding (team growth, offboarding cleanup)
- Priority bug fixes (< 24h response, < 72h resolution)
- Platform evolution (new MCP clients, IDE support, model changes)
- AI compute (token budget for agents, extraction, orchestration)
- Quarterly review & optimization session

### Add-on: GitHub Provider

Available when needed — enables multi-provider SSO for clients using GitHub alongside or instead of GitLab.

---

## The Business Case

**The cost of not having organizational memory:**

Your 50 developers lose time every day to:
- Re-explaining context to AI tools
- Hunting for decisions buried in Confluence
- Answering the same questions from new hires
- Rediscovering solutions that another team already found

**Conservative estimate:** 20 minutes/day per developer recovered = 330 hours/month.

At senior developer rates, **the system pays for itself within the first quarter.**

---

## Design Partnership

This is a partnership, not a vendor contract.

### What you get
- Enterprise-grade AI memory before it's generally available
- Direct influence on the product roadmap
- White-label & reseller rights (pre-negotiated for future phase)
- 20% discount on project delivery
- Priority support with a dedicated team

### What we get
- A real enterprise deployment driving real requirements
- A reference customer for future enterprise sales
- Feedback that shapes the product correctly

### Open source commitment
PLUR's core engine is and remains open source. Your investment improves the ecosystem while giving you exclusive early access to enterprise capabilities.

---

## Team

| Name | Role | Focus |
|------|------|-------|
| **Gregor** | Project Director, Lead Dev | Architecture, orchestration, AI agent design |
| **Tadej** | CTO, Tech Lead | Backend, auth, permissions, production readiness |
| **Marko** | DevOps | Infrastructure, CI/CD, monitoring, deployment |
| **Crt** | PM, Data Scientist | Knowledge engineering, onboarding, client coordination |

---

## Next Steps

1. Review this proposal and the detailed cost breakdown
2. Schedule a meeting to discuss your specific workflows and priorities
3. Agree on design partnership terms
4. Begin Phase 1 — shared memory for your team

---

**Contact:** Gregor Zavcer, gregor@datafund.io
**Web:** plur.ai
