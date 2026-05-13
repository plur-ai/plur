# PLUR Geo — Internal Technical Brief

**Audience:** PLUR engineering team
**Status:** Draft, pre-architecture review
**Author:** Gregor (with Claude)
**Date:** 2026-05-13
**Companion:** `docs/enterprise/offer/PLUR-Geo-Addendum-IGEA.md` (customer-facing)

---

## TL;DR

PLUR Geo is the **first vertical extension** of the engram engine. It adds a typed sidecar to the engram schema (spatial coords, time validity, jurisdiction, regulation reference, sensor provenance, classification) and composable filters on hybrid recall. No core changes — the engine was designed for this. The same recipe will produce PLUR Finance and PLUR Med next.

The IGEA opportunity is the forcing function: cadastres, road and bridge registries, risk registries, smart cities. All four are "institutional knowledge over space + time", which is precisely what an engram graph is, plus a coordinate system.

---

## Scope

In scope for v1:
- Engram schema additive fields (geo, temporal, jurisdiction, regulation, provenance, classification).
- Spatial index alongside pgvector / AGE / BM25.
- `recall_hybrid` filter composition (`bbox`, `within_polygon`, `radius_km`, `valid_at`, `jurisdiction`).
- INSPIRE adapter (CSW / WMS / WFS metadata read; we publish engram metadata as CSW records).
- PLUR Edge runtime (embedded, offline, signed-pack sync).
- Three starter sector packs (cadastre, road asset, risk).

Out of scope for v1:
- Becoming a GIS. We do not store geometries authoritatively; we reference parcel / building / asset IDs in the customer's system of record.
- Polygon-in-polygon topology ops, network routing, raster analytics. Those belong in PostGIS / Esri / GeoServer.
- Authoritative cadastral ledger. That's an FDS / Verity problem.

---

## Schema delta

Engrams already carry: `id, version, status, type, scope, visibility, statement, rationale, domain, relations, activation, feedback_signals, provenance, tags, pack` (ENG-2026-0221-615). PLUR Geo adds an optional typed sidecar:

```yaml
geo:
  crs: EPSG:3794                # mandatory if geometry present
  geometry: { type: Point, coordinates: [14.508, 46.050] }   # GeoJSON
  geohash: u269s9z              # derived, indexed
  bbox: [14.50, 46.04, 14.52, 46.06]   # derived, indexed
  centroid: [14.51, 46.05]
  altitude_m: 295               # optional, for 4D/BIM
  reference:
    parcel_id: "1722-405/3"     # cadastral ID, opaque to PLUR
    building_id: "B-12-345"
    bim_ifc_guid: "2O2Fr$t4X..."
    inspire_dataset_id: "SI.GURS.KN"

temporal:
  valid_from: 2015-06-01
  valid_to: null                # null = currently valid
  observed_at: 2025-09-12       # when this engram was learned

jurisdiction:
  country: SI                   # ISO 3166-1
  admin_l1: SI-061              # NUTS-3 or LAU
  cadastral_district: "2636"    # opaque code from customer system

regulation:
  ref: "ZEN-2024-1"             # opaque reg identifier
  supersedes: "ZEN-2014-2"
  effective_from: 2024-01-01
  effective_to: null

provenance_geo:
  sensor: "lidar"               # lidar | photogrammetry | drone | survey | siwim | manual
  precision_m: 0.05
  capture_date: 2025-04-12
  operator: "field-team-3"

classification:
  level: "public"               # public | restricted | confidential | nato-boa-tier-x
  scope_country: "SI"           # data residency hint
```

All fields are **optional**. A plain semantic engram with none of these still works. Vertical engrams compose: an engram can have `geo + temporal + regulation` without `provenance_geo`.

### Backwards compatibility

- No breaking changes to existing engram readers. Sidecar is namespaced; v2-schema consumers ignore unknown blocks.
- `plur_recall_hybrid` accepts new filter params; absence = current behaviour.
- Existing packs and engrams continue to load.

---

## Storage & indexing

| Concern | Mechanism |
|---|---|
| Geometry storage | JSONB column `engram.geo` in Postgres |
| Spatial index | **PostGIS GiST** on materialised `geom` column (derived from `geo.geometry`) — guarded by `EXTENSION IF NOT EXISTS postgis`. |
| Geohash filter (cheap pre-filter, even without PostGIS) | B-tree on `geo.geohash` — supports prefix queries; works in the local SQLite store too. |
| Temporal index | B-tree on `(valid_from, valid_to)`, exclusion constraint optional. |
| Jurisdiction | B-tree on `country, admin_l1`. |
| Edge runtime | SQLite + R*Tree module for spatial; no PostGIS dependency. |

The local-first / edge story is important for IGEA's Geo-Intelligence appliance and field rescue use cases. **SQLite R*Tree is the canonical small-footprint path**; PostGIS is the server path. The schema is identical; only the index implementation differs.

---

## Recall API

`plur_recall_hybrid` gains optional filter params:

```ts
{
  query: "landslide remediation drainage",
  // existing: scope, domain, top_k, ...

  // new in PLUR Geo
  geo?: {
    bbox?: [w, s, e, n];
    within?: GeoJSON.Polygon;
    near?: { center: [lon, lat]; radius_m: number };
    geohash_prefix?: string;     // cheap path
    crs?: string;                // input CRS; default EPSG:4326
  };
  valid_at?: ISODate;            // temporal slice
  jurisdiction?: { country?: string; admin_l1?: string; };
  classification_max?: "public" | "restricted" | "confidential";
}
```

Behaviour:
1. **Spatial / temporal / jurisdiction filters run first** as cheap predicate pushdown.
2. Hybrid BM25 + embedding + activation ranking runs on the filtered candidate set.
3. Classification filter is enforced last and audited.

This means the existing ranker stays untouched. Vertical fields are filters, not ranking signals (v1). A later iteration can fold spatial proximity into the activation score, but that is opt-in.

---

## Sector packs

Pack format is the engram pack already shipped by `plur_packs_export`. PLUR Geo adds:

- **Domain validators** — a pack can declare required sidecar fields (e.g. Cadastre Pack requires `geo.reference.parcel_id` on every engram).
- **Pack-scoped schemas** — extra typed fields on top of the geo sidecar, declared in `pack.yaml` (e.g. `cadastre.parcel_state_transition`).
- **Cross-jurisdiction transfer helpers** — `plur_packs_promote` learns to rewrite jurisdiction-scoped engrams when promoted across deliveries (e.g. SI → HR), with explicit human approval.

Three starter packs (delivered by Datafund, extended by IGEA):
- `cadastre-pack` — INSPIRE themes, parcel-state transitions, common legal exceptions.
- `road-asset-pack` — RAMS / BMS conventions, SiWIM events, bridge inspection taxonomy.
- `risk-pack` — Risk Assessment → Prevention → Event → Regeneration lifecycle.

---

## Multi-tenant scoping

Engram `scope` already supports `agent:X`, `command:X`, `global`, `space:X` (ENG-2026-0221-590). PLUR Geo introduces no new scope kinds — but a delivered system becomes a `space:` (e.g. `space:cadastre-RS`, `space:LAIS-HR`, `space:risk-registry-SI`).

Promotion between spaces (knowledge transfer across deliveries) is the operation that gives IGEA a defensible moat. It requires:
- Explicit cross-space ACL,
- Optional jurisdiction rewriting,
- Audit log entry with operator + reason,
- Signed-pack export for portable transfer.

---

## PLUR Edge

A small-footprint embeddable runtime targeting the Geo-Intelligence appliance and field tablets.

| Aspect | Choice |
|---|---|
| Storage | SQLite + R*Tree |
| Embedding model | Smaller local model (TBD — same family as current local embedder) |
| Sync | Signed engram packs, append-only delta; conflict resolution by `observed_at` + provenance precedence |
| Auth | Device certificate, gateway-mediated |
| Footprint target | ≤200 MB binary, ≤500 MB working set with a 10k-engram pack loaded |

This is a separate package (`packages/edge/`), not a build flag. Shares the schema and recall API with the server runtime — code reuse via the existing `packages/core/` engram model.

---

## Compliance hooks

| Requirement | Mechanism |
|---|---|
| ISO 9001 / 27001 / 20000 audit trail | Every engram already carries `provenance`; `provenance_geo` extends it. Immutable, retire-and-replace (ENG-2026-0303-R04). |
| NATO BOA classification | `classification.level` field; recall enforces `classification_max`. Restricted engrams never enter recall results for callers lacking clearance. |
| GAIA-X / data residency | `classification.scope_country` is a hard residency hint; promotion across borders requires policy approval. |
| GDPR | PII never stored on engrams. Authoritative registry IDs (`parcel_id`, `building_id`) are opaque references, not PII. Document this in the data-protection annex. |

---

## Implementation phases

**Phase 0 — Schema RFC (1–2 weeks)**
- Land the schema delta as a draft.
- Generate sample engrams from IGEA's published material (cadastres, RAMS, risk registry).
- Verify backwards compatibility on existing tests.

**Phase 1 — Server-side filters (3–4 weeks)**
- PostGIS-backed spatial index + temporal index.
- `recall_hybrid` filter params.
- Pack format extensions for sector packs.
- Cadastre Pack v0 (seed content from IGEA pilot).

**Phase 2 — INSPIRE adapter (2–3 weeks)**
- CSW metadata publication (engrams discoverable from geoportals).
- WMS / WFS read connectors for spatial context enrichment.

**Phase 3 — PLUR Edge prototype (4–6 weeks)**
- SQLite + R*Tree engine.
- Local embedder.
- Pack sync against server.
- Demo on a Jetson-class device (matches the Geo-Intelligence appliance form factor).

**Phase 4 — IGEA pilot (8–12 weeks, parallel)**
- One delivered system (cadastre or risk registry).
- Schema deployment in their environment.
- 30+ engram seed pack from IGEA institutional knowledge.
- Joint review with IGEA technical leads.

Total: ~5 months end-to-end. Phases 1–3 are internal; Phase 4 starts after Phase 1 lands.

---

## Open questions

1. **CRS handling** — do we normalise to EPSG:4326 internally, or preserve the input CRS? Recommend: store as-given, derive a 4326 normalised geometry for indexing. Reprojection via PROJ on the server, pre-bundled tables on edge.
2. **Geometry size cap** — engrams are meant to be statements, not GIS features. Should we cap geometry complexity (e.g. ≤ 100 vertices, ≤ 4KB serialised) and force engrams to *reference* complex polygons by ID?
3. **Activation scoring with proximity** — v1 keeps geo as filter only. Open question whether spatial proximity should feed activation in v2.
4. **Classification model** — borrow from existing IGEA / NATO BOA classification, or define our own and map?
5. **Edge embedder** — which model? Trade-off between footprint and recall quality.
6. **Cross-jurisdiction promotion semantics** — when SI engram transfers to HR delivery, do we rewrite jurisdiction or stack it? Argues for stacking (engram now valid in both, with `jurisdiction` becoming a list).

---

## Tests we'll need

- Backwards-compat: existing engrams + packs still load and recall identically when no geo filters are present.
- Spatial: bbox / within-polygon / radius filters against a 10k-engram synthetic cadastre.
- Temporal: `valid_at` slicing returns correct historical state.
- Edge parity: identical recall results from server (PostGIS) and edge (SQLite R*Tree) on same fixture.
- Classification: restricted engrams never leak through any recall path. Property test, not just unit.
- Promotion: cross-space transfer preserves audit trail, requires ACL, produces signed pack.

---

## Why this matters beyond IGEA

PLUR Geo is the first instance of a pattern (see `docs/architecture/vertical-extensions.md`). Land it cleanly and the same recipe takes us into Finance (instruments, jurisdictions, regulatory frames) and Medicine (patient context, time, terminology codes, consent classes). The engram engine stays one engine; verticals plug in as sidecar schemas and recall filters.

The IGEA conversation gives us a paying co-design partner for the geo vertical. Treat the pilot as the reference implementation, not a one-off.

---

## Action items (post brief review)

- [ ] Engineering: review schema delta, push back on field set.
- [ ] Engineering: confirm PostGIS / SQLite R*Tree split is acceptable.
- [ ] Product: confirm pricing model in the customer addendum.
- [ ] Gregor: walk this through with IGEA technical leads (Phase 0 scoping workshop).
- [ ] All: read `docs/architecture/vertical-extensions.md` for the generalisation argument.
