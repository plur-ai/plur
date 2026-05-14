---
title: IGEA — External References
captured: 2026-05-13
context: Materials forwarded by IGEA on 2026-05-13 ahead of the 2026-05-18 close meeting; provenance of each item recorded below.
---

# IGEA — External references

Materials IGEA forwarded ahead of the 2026-05-18 close meeting. Each item is annotated with what we know about it and what we *don't* — explicit gaps matter for Monday's discovery posture (ENG-2026-0513-014).

## 1. FRI-MDP semanticne-delavnice (workshop materials)

- **Source repo:** https://github.com/FRI-MDP/semanticne-delavnice
- **Local copy of presentation:** `2026-02-FRI-MDP-semanticne-delavnice-predstavitev.pdf` (3.8 MB, downloaded 2026-05-13)
- **SPARQL companion presentation:** https://github.com/FRI-MDP/semanticne-delavnice/blob/main/assets/predstavitev-SPARQL.pdf (not yet downloaded)
- **Authors:** dr. Dejan Lavbič, dr. Slavko Žitnik (UL FRI — University of Ljubljana, Faculty of Computer Science)
- **Workshop dates:** 9 February 2026 + 12 February 2026, 9:00–13:00 via MS Teams
- **Funding:** NOO (Načrt za okrevanje in odpornost — Slovenian National Recovery and Resilience Plan) + EU, component "Digitalne preobrazbe javnega sektorja in javne uprave" (C2K7)
- **Audience:** Slovenian public-sector employees
- **Curriculum:** 1-star → 5-star linked open data journey. Topics: URI, RDF (Turtle/JSON-LD/N-Triples), ontologies (OWL, Protégé), SPARQL, federated queries, FAIR principles, integration with SURS, CRP, OSM, Wikidata.

**Why it matters for IGEA's pitch:** This is the *educational ground IGEA's public-sector clients are walking on*. Whatever IGEA delivers in the next 18 months has to either speak W3C semantic web natively or convincingly interop with systems that do. State-funded training programmes shape buyer expectations.

**What we don't know yet:**
- Whether IGEA staff are participating in or aware of these workshops.
- Whether IGEA has been asked by any client to produce RDF/SPARQL-compliant outputs.
- How IGEA's existing GIS/cadastre delivery stack relates to the ontologies and standards (INSPIRE, DCAT-AP, GeoSPARQL) being taught here.

## 2. Geo-AIF vs Prototip comparison document

- **Local copy:** `geo-aif-vs-prototip-comparison.md` (the markdown text the user pasted; archived verbatim for traceability)
- **Date stated in document:** 2026-05-05 (8 days before being forwarded to us)
- **Cited source paths:** `matchmaking/PROJECT_ARCHITECTURE.md`, `Študija/Prototip_agenta_Geo_Slovenija/` — repository unknown
- **Author:** unknown
- **Stated purpose:** "Objektivna primerjava konceptov" — objective comparison, no scoring

### What the document compares

| | Geo-AIF | "Prototip Geo Slovenija" (label from the comparison itself, not ours) |
|---|---|---|
| Storage | RDF triples in GraphDB / Virtuoso | YAML engrams on filesystem |
| Verification | OriginTrail DKG (blockchain assertions) | Authority-based trust (GURS, SURS, PISRS) |
| Standards anchor | INSPIRE, DCAT-AP, ISO 19115/19139, OGC | ELI (legislation IDs), ECLI (case-law IDs), EIF 4-level mapping |
| Reasoning | SPARQL + SHACL + LLM | Activation + similarity search + LLM |
| Workflow | Roles defined; workflow not explicit | 4-step: predlog → pregled → sprejem → revizija |
| Confidence | Not explicit | "Zanesljivost: srednja/visoka" + contraindications |
| Cross-border | Federated SI/HR/AT, owl:sameAs | Centralised, EU URI as reference only |
| TBox/ABox | Strict separation, SHACL validation | Unified in engrams |

### What the document concludes

It does not score. It identifies two areas where Geo-AIF is "konceptualno zrelejši" (conceptually more mature):
1. Strict TBox/ABox separation enabling arbitrary ABox depth
2. OriginTrail DKG cryptographic verification layer

It also identifies areas where the Prototip is more mature operationally: explicit 4-step curation workflow, contraindications (when *not* to use), confidence levels, EIF 4-level mapping, ELI/ECLI for legal references.

### What we don't know yet — critical gaps

- **Who authored this comparison?** Internal IGEA analyst, partner pitch, academic study, or third party?
- **What is "Geo-AIF"?** A vendor product, a consortium proposal (the doc mentions "PRIOT partner" for AI Agent), or a research framework?
- **What is "Prototip Geo Slovenija"?** The doc cites paths only — `Študija/Prototip_agenta_Geo_Slovenija/`. We do not know the repo, the owner, or whether the engram-shaped primitives are convergent design or PLUR-aware design.
- **Why was it forwarded to us now?** Is IGEA evaluating both? Stuck between them? Looking for a third option?

## 3. Open follow-ups before Monday

- Find out who authored the Geo-AIF vs Prototip comparison.
- Identify the actual project behind "Prototip Geo Slovenija" — Slovenian academic / government / consortium project? Is it adjacent to the FRI workshops above?
- Locate the Geo-AIF source — is it a Datafund peer (Slovenian/EU geo-knowledge consortium), a vendor offering, or something IGEA is being pitched on?
- Check whether IGEA has a position on either approach, or is genuinely undecided.

These four questions are why Monday opens with discovery and not with the Geo addendum walkthrough (ENG-2026-0513-014).
