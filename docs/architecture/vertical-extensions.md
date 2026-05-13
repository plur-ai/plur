# PLUR Vertical Extensions — The Recipe

**Status:** Architectural note
**Date:** 2026-05-13
**Companion:** `plur-geo-tech-brief.md` (the first instance)

---

## The claim

PLUR's engram model was designed in a way that makes vertical extensions natural rather than invasive. Geo is the first one; financial, medical, legal, and others should follow the same recipe with no engine changes.

This document is the recipe — so the next vertical doesn't have to re-derive the pattern.

---

## What makes a "vertical"

A vertical is a domain where memory needs **extra coordinates beyond meaning**:

| Vertical | Extra coordinates |
|---|---|
| **Geo** | location, time, jurisdiction, regulation, sensor, classification |
| **Finance** | instrument, market, currency, time, jurisdiction, regulatory frame (MiFID/Dodd-Frank), counterparty |
| **Medicine** | patient (de-identified), time, terminology codes (ICD/SNOMED), care setting, consent class, evidence grade |
| **Legal** | jurisdiction, court, citation graph, time validity, regulation, precedent weight |
| **Construction** | project, site, BIM IFC GUID, phase, sub-contractor, permit |
| **Manufacturing** | line, lot, sensor stream, time, defect taxonomy |

Semantic similarity alone cannot answer the questions practitioners actually ask in these domains. "Show me cases like this" needs filters before ranking.

---

## Memory and transfer of knowledge on top of the system of record

This is the positioning thesis for every vertical.

Each domain already has a **system of record (SoR)** that is mature, entrenched, and not going away. PLUR does not replace it. PLUR layers **memory and transfer of knowledge** on top of it — orthogonal to the data plane, attached to the workflow plane.

The original phrasing came out of the IGEA conversation: *"they layer 'memory and transfer of knowledge' on top of GIS."* Swap the noun and the same sentence describes every vertical's offer:

| Vertical | System of record (already in place) | What PLUR adds on top |
|---|---|---|
| Geo | GIS (Esri, PostGIS, GeoServer), INSPIRE catalogues, cadastral databases, BIM | Memory of surveyor decisions, regulation interpretations, cross-jurisdiction remediation patterns. |
| Finance | OMS / EMS, Bloomberg / Refinitiv, regulatory reporting platforms, risk engines | Memory of trade rationale, compliance edge-case rulings, market-regime patterns transferable across desks. |
| Medicine | EMRs (Epic, Cerner, OpenEMR), PACS, lab systems, FHIR registries | Memory of clinical reasoning, atypical-presentation lessons, treatment-response patterns — no PHI duplicated. |
| Legal | Case management, citation databases (Westlaw, LexisNexis), e-filing | Memory of argument structures, judicial tendencies, jurisdictional adaptation of precedent. |
| Construction | BIM (IFC), project ERP (Primavera, P6), permit & inspection systems | Memory of site-specific details that worked, contractor patterns, permit-resolution playbooks. |
| Manufacturing | MES, SCADA, PLM, QMS, sensor historians | Memory of root-cause analyses, drift early-warnings, process-tweak rationale across plants. |
| Energy / utilities | SCADA, asset-management systems (Maximo, IBM TRIRIGA), GIS-of-network | Memory of outage diagnoses, switching-order rationale, vegetation-management patterns. |
| Government services | Legacy records systems, citizen-relationship platforms | Memory of case-handling decisions, exception approvals, jurisdictional rule interpretations. |

The pattern is unmistakable: every vertical has a **truth layer** that stores *what is*, and is missing a **memory layer** that stores *what was learned doing things with it*. PLUR is that second layer.

### Three properties this framing forces

1. **Reference, never duplicate.** The SoR owns the authoritative record. Engrams point at it by opaque ID — `parcel_id`, `encounter_id`, `trade_id`, `case_number`, `ifc_guid`, `lot_id`. If the SoR migrates, the engram link follows. PLUR never becomes a system of truth and never inherits the regulatory burden of one. This is also a sales argument: customers do not rip-and-replace; they augment.

2. **Adoption is non-disruptive.** Practitioners do not learn a new tool. Memory rides in through the agentic / chat / IDE surface that is already appearing next to every SoR. The surveyor keeps using their GIS; the clinician keeps using the EMR; the trader keeps using the OMS. What changes is that their AI counterpart finally remembers what they decided last quarter.

3. **The integrator owns the relationship.** Whoever **delivers and operates** the SoR-bound system is the natural PLUR distributor:
   - Geo: GIS integrators (IGEA, Hexagon, Esri partners, OpenGIS shops).
   - Medicine: EMR implementation partners, clinical informatics consultancies.
   - Finance: bank tech teams, fintech integrators, prime-broker tech groups.
   - Construction: BIM consultants, project-controls firms.
   - Manufacturing: industrial-IT system integrators.
   - Government / utilities: legacy-modernisation primes.

   PLUR is **memory-as-a-feature of their delivery**, priced into their engagement. That is the commercial wedge — not selling memory directly to end users, but selling it through whoever already has the integration relationship.

### Transfer of knowledge — concrete examples

The "transfer" half of the proposition is what makes memory worth paying for. Without transfer, memory is institutional knowledge inside one operator. With transfer, the same lesson improves every comparable operator that follows.

- **Geo.** The landslide-remediation playbook learned in Slovenia 2021 (same geomorphology, comparable rainfall, similar parcel-ownership patterns) applies as a starting point to a Croatian case in 2026. The engram pack travels with explicit jurisdiction rewriting; the operator on the ground gets twenty years of accumulated reasoning at the start of the new project, not at the end of it.

- **Finance.** A compliance officer's rationale for clearing an unusual MiFID II edge case in London transfers, with the regulatory frame rewritten to MiFIR, to the equivalent question on a Frankfurt desk. The trade itself sits in the OMS; the *interpretation* lives in PLUR.

- **Medicine.** A community hospital learns from a tertiary centre's experience of an atypical sepsis presentation in elderly patients. No PHI moves — only the **clinical-reasoning engram**, with patient identifiers stripped at the SoR boundary. The transfer is the heuristic, not the case.

- **Legal.** A successful argument structure used to challenge a planning refusal in one council transfers, with jurisdiction-specific adaptation, to comparable cases in twelve other councils. The citations live in the case database; the argument *strategy* lives in PLUR.

- **Construction.** A waterproofing detail that worked on one site with high water table transfers to another site with similar soil and water conditions. The drawings live in BIM; the *why this worked* lives in PLUR.

- **Manufacturing.** A defect root-cause analysis at Plant A becomes an early-warning engram applied at Plant B before the same drift produces visible defects. The sensor data and SPC charts live in the historian and MES; the diagnostic pattern lives in PLUR.

- **Utilities.** The switching-order rationale a control-room operator used to isolate a fault during a storm transfers, with grid-topology adaptation, to a comparable storm in a neighbouring DSO's territory.

In every example the SoR is untouched. What moves is a signed, jurisdiction-aware, audit-trailed engram pack — small, portable, and improving with every iteration.

### The integrator's compounding asset

For a firm delivering SoR-bound systems repeatedly across customers — IGEA across cadastres, an EHR consultancy across hospitals, a SaaS implementation partner across deals, a manufacturing-IT integrator across plants — PLUR is the **first asset that compounds across deliveries**. Custom code is bespoke. The customer's data is the customer's. Methodology is implicit, lives in expert heads, and walks out with retirement. **Engrams are explicit, portable, signed, and improve every delivery that follows.**

This reframes how to read an integrator's positioning. When IGEA says "35+ years, €15M revenue, €110M Croatia LAIS, €2.33B Slovenia flood programme," it is describing accumulated tacit knowledge. PLUR Geo turns that tacit asset into a durable, transferable, priceable one — instead of letting it leave with each retiring expert. The same logic generalises to every integrator-led vertical.

### A simple test for new verticals

Before opening a new vertical, ask three questions:

1. **Is there a clear system of record?** Not a portfolio of overlapping tools — one or two recognised authoritative systems. If not, the "reference, never duplicate" rule has nothing to point at, and PLUR would be pulled into becoming the SoR.
2. **Is there an integrator class?** A repeatable distribution channel — firms that deliver and operate SoR-bound systems for multiple customers. If memory has to be sold direct to every end user, the GTM cost dominates.
3. **Does transfer of knowledge clearly pay back?** The vertical has comparable operators or jurisdictions where the same lesson recurs. If every customer is fundamentally unique, transfer collapses to single-operator memory and the moat narrows.

Geo passes all three with margin. Finance, medicine, legal, construction, manufacturing, utilities all pass. Pure consumer apps, single-tenant SaaS, and creative-work verticals typically fail (2) or (3), and should be approached through the developer-tools entry point instead.

---

## Why PLUR's architecture absorbs verticals cleanly

Three architectural decisions, taken for other reasons, line up to make vertical extension low-cost:

1. **Engram schema is typed but extensible.** v2-schema engrams already declare a rich core (statement, rationale, domain, scope, provenance, activation, relations). Verticals add an optional, namespaced sidecar — old readers ignore unknown blocks, new readers light them up. No migration storm.

2. **Hybrid recall is a pipeline, not a monolith.** `plur_recall_hybrid` composes BM25 + embedding + activation. Vertical filters slot in as predicate pushdown **before** ranking — they reduce the candidate set, the ranker stays untouched. Vertical signals can later be folded into activation scoring, but it's opt-in.

3. **Packs are first-class.** Engrams travel in signed bundles with their own schemas, ACLs, and promotion rules. A vertical is partly schema, partly content. The pack format already carries both. Sector packs (Cadastre, Road Asset, Risk; eventually Equity Research, Oncology, etc.) are not a new concept — they're a use of an existing one.

These three together mean the engine ships once; verticals plug in as data + filters + packs.

---

## The recipe (do these for each vertical)

### 1. Define the sidecar schema

Optional, namespaced, every field nullable. Document which fields are required for which engram **types** within the vertical (not for engrams in general).

Example shape:

```yaml
<vertical_name>:
  <coordinate_1>: ...
  <coordinate_2>: ...
  reference:
    <authoritative_id>: ...
```

Hard rule: **engrams reference authoritative records, never duplicate them.** A cadastre engram links a `parcel_id`; it does not store the parcel's geometry of record. A medical engram links a patient pseudonym + encounter ID; it does not store the clinical record. PLUR is memory, not the system of record.

### 2. Add recall filters

Extend `plur_recall_hybrid` with optional filter params for the new coordinates. They run as predicate pushdown before ranking. Default behaviour (no filter passed) must be identical to today.

### 3. Pick indexes

Map each coordinate to an index that:
- Works in both the server runtime (Postgres + extensions) and the edge runtime (SQLite + modules).
- Falls back to a cheap path (B-tree on a hashed / bucketed value) when the heavy extension isn't available.

For geo: PostGIS GiST on server, R*Tree on edge, geohash B-tree as universal fallback. The fallback path is what makes the schema portable.

### 4. Ship starter sector packs

Two or three small, opinionated packs with seed engrams. They demonstrate the vertical's shape and seed real usage. Co-designed with a domain partner.

### 5. Write the compliance annex

Each vertical has its own regulatory surface: ISO/NATO BOA in geo, MiFID/SOX in finance, HIPAA/GDPR-health in medicine. The annex declares:
- How classification is represented.
- How the audit trail meets the regime.
- Where the data residency boundaries are.
- What PLUR explicitly does **not** store.

### 6. (Optional) Build an adapter to the vertical's standard interop layer

INSPIRE for geo. FIX / FpML for finance. FHIR for medicine. The adapter publishes engram metadata in the vertical's catalogue, so engrams are discoverable to existing professional workflows.

---

## What stays generic

A surprising amount. The vertical adds metadata and filters; the engine keeps doing what it does.

- Engram identity, versioning, retire-and-replace lifecycle.
- Activation, feedback, decay.
- Hybrid ranking (BM25 + embedding + activation).
- Pack export / import / promotion.
- Scope model (`agent:`, `command:`, `global`, `space:`).
- Meta-engrams ("patterns across patterns") — these may end up the most valuable per-vertical artefact, but the mechanism is generic.
- The MCP protocol surface — verticals add params to existing tools, not new tools (with rare exceptions like INSPIRE-CSW publishing).

This separation is the whole point. **PLUR is one engine that gets smarter; verticals are one data shape each that the engine learns to host.**

---

## What this implies commercially

The same product addresses very different markets:

- **PLUR (core)** — developer organisations, agentic dev tools, knowledge workers.
- **PLUR Geo** — GIS integrators, state cadastres, infrastructure operators, smart cities (IGEA is the first paying partner).
- **PLUR Finance** — asset managers, quantitative research desks, compliance teams.
- **PLUR Med** — clinical decision support layered on EMRs, research cohorts, longitudinal patient memory.

Each vertical can be a separately priced, separately positioned offering, while sharing the engine, the team, the IP. The cost to enter the next vertical is the recipe above — measured in engineering weeks, not architectural rewrites.

This is the same playbook as Stripe (one rails, many products), Linear (one graph, many surfaces), and Databricks (one runtime, many lakes). It works because the core abstraction was chosen well.

---

## What to verify before scaling the pattern

Before declaring "vertical extensions" a productised motion, the IGEA pilot needs to validate:

1. **The sidecar pattern survives contact with real domain data.** If geo forces us to break engram immutability or restructure scope, the pattern is leakier than we hope. Watch for: temporal validity wanting to mutate rather than retire-and-replace.
2. **Predicate pushdown is enough, or we need vertical ranking signals.** If `recall_hybrid` returns junk despite filters, we may need to teach activation about proximity / recency-of-regulation. Track this empirically on the pilot.
3. **Sector packs are economically sensible to build.** They take real subject-matter time; if domain experts won't co-author them, the pack story collapses.
4. **Edge parity holds.** If the PostGIS / R*Tree split produces divergent recall on the same fixture, the local-first story is in trouble.

If all four pass on geo, the next vertical is a planning exercise, not a rebuild.

---

## Recommended sequencing

1. **PLUR Geo** (now → Q4 2026) — IGEA pilot drives it, paid co-design.
2. **PLUR Finance or PLUR Med** (2027) — pick based on which partner shows up first. Both fit the recipe equally well.
3. **Open vertical recipe** — by the time the third vertical lands, this document becomes a public extension guide, and third parties build sector packs against PLUR without our engineering involvement.

That last step is what turns vertical extensions from a product motion into a platform motion.

---

## Cross-references

- `plur-geo-tech-brief.md` — first instance, schema delta, IGEA pilot plan.
- `docs/enterprise/offer/PLUR-Geo-Addendum-IGEA.md` — customer-facing framing.
- ENG-2026-0221-615 — current engram schema baseline.
- ENG-2026-0303-R04 — retire-and-replace workflow (vertical engrams obey this too).
- ENG-2026-0330-005 — PLUR positioning pillars (transfer of knowledge, meta-engrams).
- ENG-2026-0302-004 — building/construction as a strong starting vertical (predates this brief; consistent).
