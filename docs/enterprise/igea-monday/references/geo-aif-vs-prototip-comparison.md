---
title: Geo-AIF vs Prototip Geo Slovenija — Objektivna primerjava konceptov
captured_from: forwarded by IGEA on 2026-05-13
original_date: 2026-05-05
author: unknown (cited source paths: matchmaking/PROJECT_ARCHITECTURE.md, Študija/Prototip_agenta_Geo_Slovenija/)
language: Slovenian
note: Archived verbatim. The label "Prototip Geo Slovenija" comes from this document, not from us. We do not know the underlying project.
---

# Geo-AIF vs Prototip Geo Slovenija - Objektivna primerjava konceptov

*Primerjava na enaki izhodiščni točki - samo koncepti, brez vrednotenja*

---

## 1. KNOWLEDGE REPRESENTATION

| Koncept | Geo-AIF | Prototip |
|---------|---------|----------|
| **Tehnična enota shranjevanja** | Triple (S-P-O) | YAML key-value pair |
| **Ontološki elementi (TBox)** | RDF Resource (URI): `owl:Class`, `owl:ObjectProperty` | Engram `type: definition` |
| **Semantični artefakti (ABox)** | RDF Resource (URI): `r2rml:TriplesMap`, XSD Resource | Engram `type: procedure`, `type: tool` |
| **Operational storage** | RDF Store (GraphDB/Virtuoso) | YAML files (local filesystem) |
| **Verification storage** | ✅ OriginTrail DKG (validated assertions) | ❌ Ni |
| **Format** | RDF (Turtle, JSON-LD, N-Triples) | YAML |
| **Standard** | W3C | PLUR.AI spec v2.1 |
| **Hierarhije** | `rdfs:subClassOf` | ▲ (nadpomenka) |
| **Ekvivalence** | `owl:equivalentClass` | Tags + semantic similarity |
| **Relacije** | `skos:related` | ↔ (soroden) |
| **Strukturno reasoning** | SPARQL queries + SHACL validation | Vector similarity search + Activation filtering |
| **AI reasoning** | ✅ LLM (AI Agent - PRIOT partner) | ✅ LLM |

### Primerjava iste vsebine:

**Ontološki element (TBox):**
```turtle
# Geo-AIF - Tier 3 (Operational) ontologija:
onto:Parcela a owl:Class ;
  rdfs:label "Parcela"@sl ;
  rdfs:subClassOf inspire:CadastralParcel .  # inspire:CadastralParcel = Tier 1 (EU standard)

# Hierarhija:
# Tier 1: inspire:CadastralParcel (INSPIRE - EU standard)
#   ↓ subClassOf
# Tier 3: onto:Parcela (Project-specific - Slovenian implementation)
```

```yaml
# Prototip - Engram definicija:
id: ENG-parcela-def-001
type: definition
pojam: "Parcela"
statement: "Osnovna katastrska enota identificirana s parom ST_PARCELE + KO_ID..."
relations:
  ▲: kataster  # nadpomenka (parent concept)
```

**Semantični artefakt (ABox):**
```turtle
# Geo-AIF:
<mapping/parcela-si> a r2rml:TriplesMap ;
  r2rml:logicalTable [ r2rml:tableName "KN.PARCELE" ] ;
  r2rml:subjectMap [
    rr:template "parcel/{ST_PARCELE}/{KO_ID}" ;
    rr:class onto:Parcela
  ] .
```

```yaml
# Prototip:
id: ENG-parcela-proc-001
type: procedure
cilj: "iskanje parcele po naslovu"
statement: "1. Razreši naslov → EID. 2. Poišči parcele..."
contraindications: "Naslov ≠ KN identifikator"
```

---

## 2. VSEBINSKA STRUKTURA (TBox/ABox)

| Element | Geo-AIF | Prototip |
|---------|---------|----------|
| **Ločitev TBox/ABox** | DA - striktna separacija | NE - unified v engramih |
| **TBox (Ontologije)** | ✅ OWL classes, properties | ✅ Engram type: definition |
| **ABox (Semantični artefakti)** | ✅ R2RML mappings, XSD schemas, DCAT-AP metadata | ✅ Engram type: procedure, tool |
| **TBox storage** | RDF Store - TBox graph | YAML files (mixed with ABox) |
| **ABox storage** | RDF Store - ABox graph | YAML files (mixed with TBox) |
| **Operativni podatki** | Spatial DB (npr. PostGIS) - **NI del TBox/ABox KG** | Eksterne OGC WFS storitve |
| **Query TBox** | SPARQL (ontology structure) | ▲▼↔ relacijski traversal |
| **Query ABox** | SPARQL (metadata, mappings) | Vector search |
| **Validacija** | SHACL (ABox validiran proti TBox) | ❌ Ni formalne |
| **AI orchestration** | LLM (AI Agent - PRIOT) | LLM |

---

## 3. ONTOLOŠKA HIERARHIJA - Mapiranje nivojev

**OPOMBA:** Prototip ne uporablja Tier 1/2 (EU/OGC standarde). Prototip L2, L3, L4 sodijo v Geo-AIF Tier 3:

| Nivo | Geo-AIF | Prototip | Vsebina | Ownership |
|------|---------|----------|---------|-----------|
| **Tier 1** | ✅ INSPIRE, DCAT-AP, ISO 19115 | ❌ Ni | EU/ISO conceptual ontologije | EU/W3C/ISO |
| **Tier 2** | ✅ CityGML, GeoSPARQL, E57 | ❌ Ni | OGC domain ontologije | OGC/buildingSMART |
| **Tier 3** | ✅ Digital Twin, LiDAR Semantics | **L2** Information (vsebinski sklopi)<br/>**L3** Knowledge (projektna config)<br/>**L4** Wisdom (operativni popravki) | Project operational nivo | Konzorcij / Domenski strokovnjak + Projektni vodja + Koordinator |
| **Pod ABox** | Spatial DB (npr. PostGIS) | **L1** Data (uradne evidence GURS, SURS) | Surovi prostorski podatki | Nacionalne agencije |

**Interpretacija:**
- Prototip L2, L3, L4 so **vsi del Tier 3** (operativnega nivoja)
- Geo-AIF Tier 3 je en blok; Prototip ga razčleni na tri sub-nivoje
- Prototip L1 (Data) je **pod ABox** (operativni podatki, ne semantika)

**Promocija znanja:**
- **Geo-AIF**: ❌ Ni eksplicitnega feedback workflow
- **Prototip**: ✅ L4→L2 kuratorski proces

---

## 4. EU STANDARDI & COMPLIANCE

| Standard | Geo-AIF | Prototip |
|----------|---------|----------|
| **INSPIRE** | ✅ Tier 1 ontologija (uporabljeno) | ✅ Referenčno omenjeno |
| **DCAT-AP** | ✅ Metadata KG struktura | ✅ Export capability načrtovan |
| **GeoDCAT-AP** | ✅ Geographic extension | ✅ Omenjeno |
| **ISO 19115/19139** | ✅ Metadata standards | ✅ Omenjeno |
| **ELI** (European Legislation Identifier) | ❌ Ni omenjen | ✅ Uporabljen za zakone v engram |
| **ECLI** (Case Law Identifier) | ❌ Ni omenjeno | ✅ Uporabljen za sodne odločbe |
| **PROV-O** | ✅ Provenance ontologija načrtovana | ⚠️ Audit log (ne formalna ontologija) |
| **SKOS** | ✅ Vocabulary standard | ⚠️ Implicitno (relacije ▲▼↔) |
| **EU AI Act** | ✅ Sledljivost načrtovana | ✅ Compliance implementiran |
| **EIF 4 nivoji** | ❌ Ni eksplicitno mapiran | ✅ Mapiran na L1-L4 nivoje |

---

## 5. KNOWLEDGE LIFECYCLE & GOVERNANCE

| Koncept | Geo-AIF | Prototip |
|---------|---------|----------|
| **Ontology Registry Component** | ✅ Načrtovana (verzioniranje ontologij) | ❌ Ni |
| **Data Source Registry Component** | ✅ Načrtovana (avtoritativni viri) | ⚠️ Implicitno (seznam virov) |
| **Usage tracking** | ✅ Knowledge Audit & Trace Layer | ✅ Activation + frequency count |
| **Obsolescence detection** | ✅ Semantic Drift Detection Module | ✅ Activation decay (0→1) |
| **Prioritization** | ✅ Priority & Criticality Engine | ✅ Activation score (emergentno) |
| **Schema drift** | ✅ Schema Snapshot & Diff Engine | ❌ Ni |
| **Identifier consistency** | ✅ Identifier Consistency Monitor | ❌ Ni |
| **Governance roles** | ✅ Ontology Steward, Data Steward | ✅ Domenski strokovnjak, Koordinator |
| **Workflow** | ⚠️ Roles definirane, workflow ni ekspliciten | ✅ 4-step: predlog→pregled→sprejem→revizija |
| **Verzioniranje** | ✅ Semantic versioning (major.minor.patch) | ❌ Ni eksplicitno |
| **Contraindications** | ⚠️ SHACL constraints (kaj je nedovoljeno) | ✅ Eksplicitne (kdaj NE uporabiti) |

---

## 6. SPATIAL CAPABILITIES

| Koncept | Geo-AIF | Prototip |
|---------|---------|----------|
| **Prostorski DB** | ✅ Spatial DB (npr. PostGIS) - native operations | ⚠️ Uporablja OGC WFS servise |
| **Geometrijske operacije** | ✅ ST_Intersects, ST_Buffer, ST_Distance, ST_Union | ⚠️ Preko WFS klicev |
| **Spatial indexes** | ✅ R-tree, GiST indexes | ❌ (na strani OGC servisa) |
| **3D podpora** | ✅ CityGML LOD0-4, 3D meshes | ❌ Ni omenjeno |
| **LiDAR** | ✅ E57 format, point cloud metadata | ❌ Ni omenjeno |
| **DGGS** | ✅ Discrete Global Grid System omenjeno | ❌ Ni omenjeno |
| **Digital Twins** | ✅ Jedro projekta (temporal + 3D) | ❌ Ni omenjeno |
| **EPSG transformations** | ✅ Coordinate system support | ⚠️ Preko WFS |

---

## 7. FEDERATION & CROSS-BORDER

| Koncept | Geo-AIF | Prototip |
|---------|---------|----------|
| **Arhitektura** | Federirana (SI/HR/AT cross-border) | Centralizirana (GURS) |
| **Coordination layer** | ✅ Minimal Central Coordination Layer | ❌ Ni načrtovano |
| **SPARQL endpoints** | ✅ Načrtovani (federated query) | ❌ Ni |
| **Cross-border preslikave** | ✅ SI/HR/AT cadastre harmonization | ⚠️ SI→EU reference only |
| **URI alignment** | ✅ owl:sameAs med državami | ⚠️ EU URI kot referenca (ne bi-directional) |
| **Distributed trust** | ✅ DKG network (multi-node) | ❌ Centralni sistem |

---

## 8. TRUST & VERIFICATION

| Koncept | Geo-AIF | Prototip |
|---------|---------|----------|
| **Trust model** | Cryptographic (blockchain-based) | Authority-based (uradni viri) |
| **Blockchain** | ✅ OriginTrail DKG | ❌ Ni |
| **Immutability** | ✅ Cryptographic proofs (hash) | ❌ Ni |
| **Timestamp** | ✅ Blockchain timestamp (verifiable) | ⚠️ Operativni log timestamp |
| **Provenance** | ✅ PROV-O ontology (formal) | ✅ Audit trail (operational) |
| **Confidence levels** | ❌ Ni eksplicitno | ✅ "Zanesljivost: srednja/visoka" |
| **Source citation** | ✅ Proof URI (dkg://assertion/...) | ✅ Eksplicitni sklici (GURS, SURS, PISRS) |
| **Decentralization** | ✅ DKG distributed network | ❌ Centraliziran sistem |

---

## 9. ELEMENTI KJER JE GEO-AIF KONCEPTUALNO ZRELEJŠI

### 9.1 Striktna TBox/ABox separacija z možnostjo poljubne globine v ABox

**Geo-AIF pristop:**

```
TBox (Ontologije) - MODEL - Ločen layer
├─ Tier 1 (Conceptual - EU/ISO standards)
├─ Tier 2 (Domain - OGC standards)
└─ Tier 3 (Operational - Project ontologies)
     ↓ defines structure (validacija)

ABox (Semantični artefakti + Instance) - DATA - Ločen layer
├─ Level 1: Mappings (R2RML: SI→EU preslikave)
├─ Level 2: Schemas (XSD, JSON-LD dokumentacija)
├─ Level 3: Metadata (ISO 19115, DCAT-AP zapisi)
├─ Level 4: Codelists (SKOS klasifikatorji)
├─ Level 5: ...
└─ Level N: ... (poljubna globina brez omejitev)
     ↓
Operativni prostorski podatki (Spatial DB, npr. PostGIS - milijoni objektov)
```

**Prednosti konceptualne ločitve:**
- **TBox stabilnost**: EU/OGC standardi se redko spreminjajo → stabil model
- **ABox fleksibilnost**: Lahko dodajamo nove nivoje mappingov brez vpliva na TBox
- **Neodvisna evolucija**: TBox verzioniranje (major.minor) ločeno od ABox (continuous)
- **Formalna validacija**: SHACL validacija ABox proti TBox pravilom
- **OWL reasoning učinkovitost**: Reasoning deluje samo na TBox (ni milijonov instanc)
- **Hierarhična globina**: ABox lahko ima poljubno globino (Level 1, 2, ..., N) brez strukturnih omejitev

**Prototip pristop:**

```
Unified engram sistem (TBox + ABox v istem "košu")
├─ Engram type: definition (TBox-like)
├─ Engram type: procedure (ABox-like)
└─ Engram type: tool (ABox-like)
     ↓
Vse v istem formatu - ni strukturne hierarhične ločitve
```

**Posledica unified pristopa:**
- ❌ TBox in ABox evoluirata skupaj → sprememba TBox vpliva na ABox
- ❌ Ni formalne SHACL validacije ABox proti TBox
- ❌ Ni jasne hierarhične globine v ABox
- ❌ LLM reasoning mora procesirati TBox + ABox skupaj

---

### 9.2 OriginTrail DKG - Blockchain verification layer

**Geo-AIF implementira dual-layer Knowledge Graph:**

```
Operativni KG (mutable - delovno okolje)
     ↓ Human/AI validation
     ↓
OriginTrail DKG (immutable - verification layer)
     ↓
┌──────────────────────────────────────────┐
│ Immutable assertion                      │
│ Blockchain timestamp: 2026-02-11T10:23Z  │
│ Cryptographic hash: 0x7a3f9b2e...        │
│ Proof URI: dkg://assertion/0x7a3f9b...   │
│ Multi-node consensus                     │
└──────────────────────────────────────────┘
     ↓
Verificirano lahko preverjajo pooblaščeni sistemi/persone
```

**Kaj DKG zagotavlja:**
- **Immutability**: Assertion ne more biti **spremenjen** po objavi (cryptographically guaranteed)
- **Temporal proof**: Dokazan obstoj assertion na določen datum (blockchain timestamp)
- **Distributed storage**: Multi-node network → no single point of failure
- **Integrity verification**: Lahko preverimo da assertion **ni bil spremenjen** od objave

**Kaj DKG NE zagotavlja (v trenutni dokumentaciji):**
- ❌ **Correctness**: "Garbage in = garbage out" - napačna assertion ostane napačna
- ❌ **Trust metrike**: Confidence scores, verification levels, human validation status niso dokumentirane
- ❌ **Authority trust**: Zaupanje v publisher-ja (SI, HR, AT) je še vedno potrebno

**Posledica:**
Brez trust metrik je dodana vrednost DKG za ontološke/semantične artefakte **omejena** na:
- Immutability (ni sprememb)
- Temporal proof (timestamp)
- **NI rešitev za trust problema accuracy/correctness**

**Use case - Cross-border data exchange:**
```
Scenario: SI → HR podatkovni exchange

Brez DKG (authority-based):
  SI: "Parcela 123 pripada katastru SI-001"
  HR: "Ali lahko zaupam SI sistemu?" ❓
  → Potrebno bilateralno zaupanje

Z DKG (cryptographic):
  SI: Objavi assertion na DKG + blockchain proof
  HR: Preveri cryptographic proof (matematično)
  → Trust is guaranteed, not assumed
```

**Prototip NE implementira:**
- ❌ Blockchain verification
- ❌ Immutable assertions
- ❌ Cryptographic proofs
- ❌ Distributed trust network
- ❌ Temporal mathematical proof

**Uporablja:** Authority-based trust (zaupanje v GURS kot nacionalno avtoriteto)

---

## 📊 SKUPNI KONCEPTI (oba implementirata)

1. **Knowledge Graph** (različna implementacija: RDF vs YAML)
2. **Ontološke definicije (TBox)** (`owl:Class` vs `type: definition`)
3. **Semantični artefakti (ABox)** (R2RML vs `type: procedure`)
4. **Knowledge lifecycle management** (drift detection vs activation decay)
5. **Prioritization** (Criticality Engine vs activation score)
6. **Kuratorski governance** (Steward roles vs 4-step workflow)
7. **Provenance/audit** (PROV-O vs audit log)
8. **EU standards awareness** (INSPIRE/DCAT vs ELI/ECLI)
9. **Multi-domain integration**
10. **Modularnost** (tier selection vs vsebinski sklopi)

---

*Pripravil: 2026-05-05*
*Primerjava temelji na dokumentih: [`matchmaking/PROJECT_ARCHITECTURE.md`](matchmaking/PROJECT_ARCHITECTURE.md), [`Študija/Prototip_agenta_Geo_Slovenija/`](Študija/Prototip_agenta_Geo_Slovenija/)*
