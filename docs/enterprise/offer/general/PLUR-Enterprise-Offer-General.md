# PLUR Enterprise — Founding Partner Offer

**Document · PLUR-ENT-2026-05**
**Rev. 004 · May 2026**

---

## § 01 · Executive Summary

### Turn every engineer, every agent, and every repository into compounding capital.

PLUR Enterprise is **persistent, correction-based organisational memory and learning** for AI-augmented engineering teams. A developer corrects the AI on Monday — every teammate's AI knows it on Tuesday. Conventions captured once persist across all sessions, all IDEs, all years.

This is the **Founding Partner offer**. The first five companies who help shape the enterprise feature set get 30% off list for life, white-label & reseller rights in their vertical, and best-rate clause that extends to every future PLUR and Datacore product.

> **The offer is one recurring line.** Subscription only. No mandatory integration fees, no consulting bundles. The product self-deploys; you pay for it when you use it.

Optional add-ons (feature requests scoped on actuals; Datacore Enterprise in Q3/Q4 2026) sit outside the subscription and are contracted separately.

---

## § 02 · Scope & System

### What is shipped, in detail.

PLUR Enterprise is a self-hosted, multi-user memory platform. It slots in between your engineers, their agents, and your codebase. Every interaction with the system is scoped, logged, and reversible.

#### § 02.1 · Included in the subscription

| # | Capability | What it does | Surface |
|---|---|---|---|
| 01 | **PLUR server** | HTTP/SSE MCP gateway, multi-user, multi-tenant | MCP clients |
| 02 | **Knowledge graph** | PostgreSQL + Apache AGE — graph over conventions, decisions, entities | SQL + GraphQL |
| 03 | **Semantic memory** | pgvector — embedding store, native SQL | SQL + API |
| 04 | **Correction learning** | Every review / revert / rewrite becomes a first-class signal | Pipeline |
| 05 | **SSO** | OIDC / OAuth2 + PKCE against your IdP | Your IdP |
| 06 | **Access control** | Scope-based + role-based; per project, per group | Admin |
| 07 | **MCP tool security** | Tool allowlist, write enforcement, signed audit log | Admin |
| 08 | **Admin dashboard** | Usage, health, audit — for IT and compliance | Web UI |
| 09 | **Ops** | TLS, CI/CD, monitoring, alerting — operated by Datafund | Managed |
| 10 | **Maintenance** | Security patches, dependency updates, platform upgrades | Managed |
| 11 | **Support SLA** | Priority bug fixes · <24h response · <72h resolution | Contract |
| 12 | **Cadence** | Weekly check-in + quarterly strategic review | Partnership |

---

## § 03 · Architecture

### Self-hosted. Standard parts. Your infrastructure stays yours.

```
Developer IDEs                        Your Infrastructure
================                      ====================

VS Code + Continue  ───┐
VS Code + Cline     ───┤
Cursor              ───┤  HTTPS/SSE   ┌──────────────────┐
Claude Code         ───┼─────────────>│  PLUR Enterprise │
JetBrains + MCP     ───┤              │  (MCP Server)    │
Other MCP clients   ───┘              └────────┬─────────┘
                                               │
SSO + IdP hooks     ──────────────────>        │
                                      ┌────────┴─────────┐
                                      │ PostgreSQL       │
                                      │ + AGE (graph)    │
                                      │ + pgvector       │
                                      └──────────────────┘
```

**§ 03.1 · Data residency.** Deployment on your infrastructure. Source code, graph data and prompts never leave your network. LLM routing is yours — self-hosted, regional-EU, or commercial — through a gateway we configure with you.

**§ 03.2 · Stack.** PostgreSQL, Apache AGE, pgvector, Docker, Linux, OIDC. No proprietary runtime, no exotic vector database. Your ops team reviews it in an afternoon.

**§ 03.3 · Controls.** Scope + role access, tool allowlist, write enforcement, tamper-evident audit log. Maps cleanly to your existing security controls.

---

## § 04 · Pack Economics

### Why agents will pay for memory.

Every agent task today burns API tokens rebuilding the same context — tool schemas, your conventions, prior decisions — from scratch. A pack ships that context once. Loaded once, used forever.

#### § 04.1 · Measured per-task savings (frontier APIs)

| Workload | Without pack | With pack | Saving |
|---|---|---|---|
| **Sonnet 4.6 median task** | $1.48 | $0.45 | **69%** |
| **Opus 4.7 median task** | $7.42 | $2.27 | **69%** |
| Floor (input rebuild alone) | $0.22 | — | — |

#### § 04.2 · The formula

```
pack_value = cost_without − cost_with − pack_price
```

If `pack_value > 0`, the pack should have been installed. Even the irreducible floor ($0.22 of input rebuild) already exceeds the pack price.

#### § 04.3 · The reframe that matters

**3.3× more tasks per dollar.**

The number that survives model price changes. Composes with whatever budget finance approved. At 10,000 Opus tasks/month → **~$51,500/month measurable saving**. The pack costs less than one task.

*Source: Bai et al. (2026) — agents reasoning from scratch consume an order of magnitude more tokens than agents working from pre-loaded knowledge.*

---

## § 05 · Pricing

### €35 / seat / month. Founding Partner rate, guaranteed for life.

Subscription is the only recurring line. Managed operations, support, maintenance, platform upgrades — all included. Infrastructure and AI tokens are paid directly to your provider.

| Line | Value |
|---|---|
| List price per seat | €50/mo |
| Founding Partner discount | 30% |
| **Founding Partner per seat** | **€35/mo** |
| Seats (minimum tier) | 50 |
| **Minimum monthly commitment** | **€1,750/mo** |
| Commitment | 12 months from go-live |

#### § 05.1 · Market context (monthly, per seat)

| Product | Price / seat / mo | Memory | Correction-based learning | Self-hosted |
|---|---|---|---|---|
| GitHub Copilot Enterprise | $39–60 | 28-day window | No | No |
| Augment Code Standard | $60 | Project-scoped | No | No |
| Sourcegraph Cody Enterprise | $59 | None (search) | No | Yes (Ent.) |
| JetBrains AI Enterprise | $60+ | None | No | No |
| **PLUR Enterprise · list** | **€50** | **Persistent graph + semantic** | **Yes** | **Yes** |
| **PLUR · Founding Partner** | **€35** | Same | Yes | Yes |

> **The Founding Partner rate is guaranteed for life.** €1,750/month is the minimum commitment — it covers 50 seats whether you activate 10 or 50. Additional seats at the same €35/seat rate, no renegotiation. The guarantee extends to every future PLUR and Datacore product.

#### § 05.2 · Or, by request — metered pricing

For organisations whose CFO wants **pay-for-outcomes** pricing tied directly to measured API spend reduction, we offer a metered alternative:

- **20% of measured API savings**, invoiced monthly with auditable receipts.
- **Floor: €500/month** — covers gateway operational cost regardless of usage.
- **No cap** — heavy savers pay proportionally; light users pay the floor.
- BYOK: customer brings their own LLM API keys; the gateway measures with vs. without packs.

**When this fits.** Variable usage across teams. Outcome-based procurement preferences. Auditable receipts requirement.

> **Metered ships in Founding Partner Beta** through Q3 2026. Methodology and audit format are versioned and disclosed. PLUR will not invoice variable amounts until the savings calculation is co-signed for your environment in the first 30 days. If the methodology is not co-signed, the customer reverts to the standard €35/seat Flat rate.

---

## § 06 · Timeline

### From contract to coverage in two weeks.

The product self-deploys. There is no integration consulting engagement.

| When | Milestone |
|---|---|
| Contract signed | T+0 — Founding Partner agreement countersigned |
| Day 1–3 | Self-service deployment — Docker compose / Helm chart, SSO wired against your IdP |
| Day 3–7 | First 5 users smoke-test in a sandbox scope |
| Day 7–14 | Rollout to wider team, admin dashboard tuned |
| **Day 14** | **Go-live · subscription starts** |
| Q3/Q4 2026 | Datacore Enterprise — scoped together, same Founding Partner terms |

> **No charges before go-live.** Deployment and the first 14 days of evaluation are free. If go-live doesn't happen by day 30, the contract lapses with no obligation.

---

## § 07 · Return on Investment

### The subscription pays for itself in the first month of use.

> Every developer recovers ≈ **€315 of time per month**. PLUR costs **€35 / dev / month**. Everything else — faster onboarding, fewer repeated mistakes, higher agent accuracy — is upside.

#### Per-developer math (monthly)

| Line | Value |
|---|---|
| Time recovered / dev / day | 15 min |
| Working days / month | ~18 |
| Blended hourly value | €70 |
| **Recovered value / dev / month** | **≈ €315** |
| **PLUR cost / dev / month** | **€35** |
| Payback per developer | **within the first month** |

#### Context

McKinsey puts developer time spent searching for information at **1.8 hours/day**. GitHub reports context-switching costs engineering organisations an average of **~€50,000 per developer per year**.

We model **15 minutes/day** — roughly an eighth of McKinsey's number. Even at that level the subscription pays for itself in the first month of use, before the memory layer has had time to compound.

> **Upside not modelled.** Faster onboarding, higher agent success rates, and — for metered customers — measurable API spend recovery. At 10,000 Opus tasks/month, ~$51,500/month measurable saving (see § 04).

---

## § 08 · Optional Add-Ons

The subscription stands on its own. Two optional add-ons are available outside the recurring line:

### § 08.1 · Feature requests *(billed on actuals)*

Custom feature requests — new MCP tools, custom ingestion adapters, bespoke admin views, dashboard integrations — are scoped and billed on actuals at **€85/h**, with monthly cap negotiated per request.

- No fixed-price risk premium.
- Invoiced monthly against real hours.
- Roadmap-aligned features (that benefit all customers) are absorbed into the platform at no charge.
- Customer-specific features ship behind a feature flag and can be open-sourced upon mutual agreement.

### § 08.2 · Datacore Enterprise — Founding Partner indicative prices

Available Q3/Q4 2026. Scoped together once the memory layer is producing.

| AI role | Description | €/mo (indicative) |
|---|---|---|
| **AI Chief of Staff** | Org-wide operational intelligence. | €800 |
| **Insight Agent** | Proactive pattern detection across repos. | €600 |
| **Onboarding Companion** | Interactive buddy for new developers. | €400 |

*Pricing is per AI role per month. Exact scope and commercials agreed in Q3/Q4 2026. Founding Partner 30% discount applies on the same terms.*

---

## § 09 · Questions before the first call.

**Is it self-hosted?**
Yes. PLUR Enterprise runs inside your infrastructure — no source code, graphs or prompts leave your network. LLM calls go to the provider you choose (self-hosted or commercial), routed through your gateway.

**How does it fit our security model?**
SSO through your IdP, scope-based access, tool allowlist, write enforcement, tamper-evident audit log. We co-author the threat model and the mapping to your controls during deployment.

**How is this different from Copilot?**
Copilot autocompletes. PLUR remembers. It retains conventions, decisions, corrections and context across repos and years, and serves them back to any agent or engineer on demand.

**What happens to the learning if we leave?**
You keep it. The knowledge graph, engrams and packs are your property. You export them at any time, in open formats.

**Who owns the IP?**
You own all extracted knowledge. Datafund retains IP in the PLUR platform itself. The Founding Partner terms guarantee you the best commercial rate, always.

**Why "Founding Partner"?**
Because we are shipping this together. Your requirements define the enterprise feature set, you receive 30% off for life, and you hold white-label & reseller rights for your own vertical.

**What if we use fewer than 50 seats?**
You pay €1,750/month regardless — that's the minimum commitment. It covers up to 50 seats whether you activate 5 or 50. Additional seats beyond 50 are €35/seat/month, same Founding Partner rate.

**How does the metered alternative work?**
You bring your own LLM API keys (BYOK). The gateway proxies requests and measures tokens used with vs. without the relevant packs, producing a signed receipt of measurable savings each month. We invoice 20% of measured savings, with a €500/month floor that covers gateway operational cost regardless of usage. There is no cap — heavy-saving months cost more, light months cost the floor.

**Will the metered methodology be auditable?**
Yes. The methodology is published and versioned. During the first 30 days you co-sign the savings calculation as fit for your environment. If you don't co-sign, the contract automatically reverts to the standard €35/seat Flat rate; no obligation either way.

**Can we request custom features?**
Yes — see § 08.1. Feature requests are scoped per request and billed on actuals at €85/h. Roadmap-aligned features ship at no charge. Customer-specific features ship behind a feature flag.

#### § 09.1 · Terms & conditions

01. All prices exclude VAT.
02. **Flat subscription**: 12-month commitment starting at go-live. €1,750/month minimum covers up to 50 seats; additional seats at €35/seat/month.
03. **Metered (by request, Founding Partner Beta)**: 12-month commitment from go-live. 20% of measured API savings, €500/month floor, no cap. Methodology co-signed in first 30 days or reverts to Flat €35/seat.
04. **Founding Partner rate is guaranteed for life** — best-rate clause binding. Applies to whichever pricing model is selected, and extends to every future PLUR and Datacore product.
05. Feature requests (§ 08.1) invoiced monthly on actuals at €85/h. No fixed-price premium.
06. Datacore Enterprise scoped and priced together in Q3/Q4 2026.
07. IP: customer owns all extracted knowledge; Datafund retains IP in the PLUR platform.
08. Deployment phase is free — no subscription charges before go-live (typically day 14).
09. Infrastructure (hosting, hardware) and AI token costs are not included in the subscription. These are paid directly to the customer's provider.

---

## § 10 · Commercials & Acceptance

### Let's start the Founding Partnership.

The Founding Partner cohort is limited to **five companies**. Beyond the headline discount, the partnership carries:

- Guaranteed best rate, for life.
- Influence on the product roadmap.
- White-label & reseller rights in your vertical.
- Same terms carry to Datacore Enterprise.
- Case study, co-authored, mutually approved.
- No subscription charges before go-live.

#### § 10.1 · Acceptance

Reply to **gregor@datafund.io** with the seat count and (optionally) request the metered alternative. We will send the Founding Partner contract within 48 hours and schedule the kick-off call.

> **Next step — not a signature.** Reply *"let's talk"* and we schedule the first call. The full terms are negotiated in the Founding Partner contract, not here.

---

**Contact:** Gregor Žavcer, gregor@datafund.io
**Web:** plur.ai
