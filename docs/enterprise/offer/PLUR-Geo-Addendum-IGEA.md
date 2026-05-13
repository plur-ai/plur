# PLUR Geo — Addendum to the Enterprise Offer

**Prepared for:** IGEA d.o.o.
**Date:** May 2026
**From:** Datafund d.o.o.
**Status:** Discussion draft — companion to REV.002 (sent 2026-04-28)

---

## Why this addendum

The base Enterprise offer (REV.002) addresses one half of IGEA's value: **memory for your 50 developers**. After reviewing IGEA's "Managing eSpaces. Together." overview, it is clear that the larger opportunity is the other half: **memory for the systems IGEA delivers** — cadastres, road and bridge registries, risk registries, smart-city platforms.

These systems share a defining property: they are **long-lived institutional knowledge anchored in space and time**. A Slovenian cadastre that has run for 30+ years; a €110M Croatian LAIS spanning 2008–2016; a €2.33B flood remediation programme running 2023–2028. Every decision, exception, regulation interpretation, and field correction accumulates over decades, across changing teams, governments, and standards.

This is what PLUR was built to remember. PLUR Geo is the extension that makes it speak IGEA's domain natively.

---

## What PLUR Geo adds

A vertical extension of the PLUR memory engine that gives every engram a place, a time, a jurisdiction, and a regulatory frame — so the same correction-based learning and transfer-of-knowledge that PLUR provides to developers becomes available to surveyors, road engineers, risk officers, and decision-makers.

### Engram model extensions

| Capability | What it enables |
|---|---|
| Spatial coordinates (GeoJSON / WKT, EPSG-aware) | "Show me every lesson learned about parcels within 500 m of this riverbank." |
| Geohash + bbox pre-filter on hybrid recall | Spatial queries combine with semantic and BM25 ranking — no separate GIS needed for memory lookups. |
| Temporal validity (`valid_from` / `valid_to`) | Cadastres are 4D. "What was the legal status of this parcel on 2015-06-01?" |
| Jurisdiction (ISO country + LAU/NUTS / cadastral district) | Cross-country knowledge transfer with proper scoping (HR ↔ RS ↔ MK ↔ SI). |
| INSPIRE theme / dataset linkage | Engrams discoverable through the same metadata catalogue your geoportal uses. |
| BIM IFC GUID + cadastral / building registry ID | Engrams *reference* the authoritative record, never duplicate it. |
| Regulation reference | Engrams age out automatically when a law is superseded. |
| Sensor / provenance class (lidar, photogrammetry, drone, survey, SiWIM) | Audit-grade trail for ISO 9001 / 27001 / 20000 and NATO BOA workflows. |
| Classification level | Public, restricted, NATO BOA — visibility model matches what you already operate. |

### Query patterns

- **Spatial recall** — bbox, radius, within-polygon filters on `recall_hybrid`.
- **Temporal recall** — historical state queries for legal/audit defence.
- **Cross-jurisdiction transfer** — "How did we remediate landslides in SI 2021? Apply to current HR case." Transfer of knowledge between deliveries becomes a first-class operation, not a tribal-knowledge exercise.
- **Regulation-aware** — engrams scoped to a legal regime, auto-revoked on supersession.

### Runtime extensions

- **PLUR Edge** — embedded PLUR runtime for the Geo-Intelligence appliance. Offline engram store, signed packs, sync-on-connect. Critical for rescue missions and field inspection where connectivity is intermittent.
- **INSPIRE adapters** — WMS / WFS / CSW connectors, so engrams sit alongside the spatial services IGEA already operates.
- **PostGIS-backed spatial index** — proper R-tree indexing for serious cadastral query volumes; the existing pgvector / AGE stack from the base Enterprise offer extends naturally.

---

## How it fits IGEA's portfolio

| IGEA domain (from the overview) | PLUR Geo contribution |
|---|---|
| Cadastral systems (HR / MK / SI / RS) | A reusable **Cadastre engram pack** that ships with each delivery — codifies 35 years of decisions so the next team inherits them. |
| Road & bridge asset management (RAMS, BMS, SiWIM, drone inspection) | Per-asset memory accumulating inspection findings, thermal anomalies, load events; pattern recognition across bridges and across countries. |
| Risk Registry & disaster response | "What worked during the 2023 floods" becomes auto-applicable when the next event hits a similar geomorphology. Real-time decision support without re-deriving from scratch. |
| Geo-Intelligence appliance | PLUR Edge ships on the device: spatial AI plus persistent learning, offline. |
| Smart Cities (participatory planning) | Multi-stakeholder scoping — citizens see public engrams; planners see the full graph; decision-makers see meta-engrams synthesised across cases. |
| Strategic Planning & decision support | Meta-engrams — patterns across patterns — give politicians and mayors briefable synthesis, not raw data. |

---

## Pricing model

PLUR Geo is licensed **per delivered system**, not per developer seat. It is sold as part of IGEA's deliveries to its end clients (state, agencies, municipalities), or operated by IGEA on behalf of those clients.

| Tier | Suitable for | Indicative |
|---|---|---|
| **Project licence** | One delivered system (e.g. a country cadastre, a road network, a risk registry) | Six figures, perpetual + annual support |
| **Portfolio licence** | All of IGEA's delivered systems in a country / agency | Negotiated, includes sector pack royalties |
| **OEM / embedded** | PLUR Geo ships inside the Geo-Intelligence appliance | Per-unit royalty + support |

This is **additive** to REV.002. The Founding Partner subscription remains the basis for IGEA's own 50 developers. PLUR Geo is the second revenue line — and the one that compounds with every system IGEA delivers.

> **Why the model differs:** developer-seat pricing makes sense when value scales with active users. Cadastre and registry memory scales with the *system's lifetime and reach* — millions of parcels, thousands of public users, decades of operation. Per-seat would mis-price both directions.

---

## Sector engram packs

PLUR Geo ships with three starter packs IGEA can extend with its own institutional knowledge:

1. **Cadastre Pack** — INSPIRE themes, parcel-state transitions, common legal exceptions, cross-country mapping (HR / MK / SI / RS variants).
2. **Road Asset Pack** — RAMS / BMS conventions, SiWIM event handling, bridge inspection taxonomy, HDM4 integration patterns.
3. **Risk & Disaster Pack** — Risk Assessment → Prevention → Event → Regeneration lifecycle, lessons from documented Slovenian flood / landslide responses.

Each pack is a portable, signed engram bundle. IGEA controls promotion and visibility per delivery.

---

## Compliance & sovereignty

- **ISO 9001 / 27001 / 20000** — audit trail and provenance fields are designed to satisfy existing certifications.
- **NATO BOA** — classification level on each engram; restricted scopes never leave their boundary.
- **GAIA-X** — federated sovereignty preserved; engram exchange respects data-residency rules (data stays in-country, derivative engrams can cross if policy allows).
- **GDPR** — owner / occupant personal data lives in the authoritative registry; engrams reference, never duplicate.

---

## Roadmap & engagement

**Phase 0 — Scoping workshop (2 days)**
Identify the first delivered system to instrument. Map IGEA's existing GIS / cadastre stack to PLUR Geo extensions.

**Phase 1 — Cadastre Pack pilot (8–12 weeks)**
One country cadastre. Schema deployment, INSPIRE adapter, 30-engram seed pack from IGEA's institutional knowledge, PLUR Edge prototype.

**Phase 2 — Productisation (Q3–Q4 2026)**
Sector packs hardened, OEM build for the Geo-Intelligence appliance, integration with one risk registry.

Custom work for Phase 0–1 is budgeted similarly to the base offer's Knowledge Extraction phases — fixed-fee, role-based, no surprise hours.

---

## Next step

A 60-minute working session with IGEA technical leads to:
1. Confirm which delivered system to pilot.
2. Walk through the engram schema extensions against IGEA's existing data model.
3. Agree the Phase 0 scope and pricing.

The base REV.002 subscription remains the right starting point regardless of how PLUR Geo proceeds. This addendum sits beside it — not in place of it.

---

**Contact:** Gregor Žavcer, Datafund d.o.o. — gregor@datafund.io
