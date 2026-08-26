# The Open Engram Standard

**Version:** 1.3 (draft)
**Status:** Working Draft
**Date:** 2026-08-26
**Editors:** PLUR.ai (plur-ai)
**License:** This specification is licensed under CC-BY-4.0. Reference code is Apache-2.0.
**Companion profiles:** [Recording where an engram came from](./ENGRAM-PROVENANCE-PROFILE.md)
— profiles §9. A profile refines one part of this document; it never replaces it,
and this document remains authoritative wherever the two overlap.

Revision history is §10.5.

> An **engram** is a small, self-describing, portable assertion of learned
> knowledge for AI agents. The Open Engram Standard defines the engram object,
> the pack format that bundles engrams for sharing, the `.plur` capsule that
> seals a pack into a single integrity-checked file, and the trust model that
> lets a third party verify what they received. This document is written so that
> an independent implementer can read and write conformant engrams, packs, and
> capsules in any language, without reading the reference TypeScript.

---

## Conformance terminology

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** in this
document are to be interpreted as described in [RFC 2119] / [RFC 8174].

Every normative section carries a maturity label:

| Label | Meaning |
|---|---|
| **STABLE** | Implemented in the reference and frozen for v1. Implementers MUST follow it to be conformant. Breaking changes require a major version. |
| **RESERVED** | Wire space, flags, or fields are allocated and validated, but the *behavior* is not yet specified. Implementers MUST preserve the reserved space (e.g. round-trip the bytes/fields) but MUST NOT assign their own meaning to it. |
| **PROPOSED** | A planned extension or profile. Non-normative for v1. Provided so the design space is documented and the fundable remainder is explicit. Implementers MAY ignore it. |
| **SPECIFIED** | Normative and frozen for v1, but **not yet fully implemented in the reference**. Implementers MUST follow it to be conformant, exactly as for STABLE. The distinction exists because "implemented in the reference" and "binding on implementers" are different claims, and a document that conflates them cannot describe a rule written before its own implementation catches up. Where the reference falls short, this document says so and names the tracking issue. |

The maturity label of a whole section applies to everything in it unless an
inner item is labelled otherwise.

---

## 1. Scope and intent — STABLE

### 1.1 What this standard covers

1. **The Engram object** (§4) — the field set, types, value ranges, and
   invariants of a single unit of knowledge.
2. **The ID grammar** (§3) — how engram identifiers are formed and what their
   prefixes mean.
3. **The Pack format and lifecycle** (§5) — the on-disk directory layout
   (`SKILL.md` + `engrams.yaml` + `INTEGRITY`), the manifest fields, and what a
   consumer does when it installs, updates or removes one (§5.6–§5.8).
4. **The `.plur` capsule** (§6) — the binary single-file envelope: header,
   format version, flags, payload, checksum.
5. **The integrity model** (§6, §8) — how a receiver verifies that a pack or
   capsule is intact.
6. **The signing model** (§7) — the *intended* authenticity scheme (Ed25519),
   marked RESERVED.
7. **Provenance binding** (§9) — engram/pack ↔ W3C PROV-O ↔ Swarm anchor,
   specified as a PROPOSED profile.
8. **Versioning and compatibility policy** (§10).

### 1.2 What this standard does not cover

- **Ranking, decay, and injection.** How an implementation scores, decays, or
  selects engrams for a context window is an *implementation* concern, not an
  interchange concern. The `activation`, `usage`, and `feedback_signals` fields
  carry the *state* such algorithms consume, but the algorithms themselves are
  out of scope.
- **Search.** BM25/embedding/RRF retrieval is non-normative.
- **Transport / sync.** Git sync, the REST `/api/v1/engrams` surface, and remote
  stores are implementation choices, not part of the interchange format.
- **Storage engine.** YAML is the canonical, human-readable serialization (§2);
  a conformant implementation MAY use any internal store (SQLite, a database, a
  remote service) as long as it can import and export canonical YAML losslessly.

### 1.3 Design goals

- **Implementable from this document alone**, in any language.
- **Human-readable canonical form** — an engram store is a YAML file a person
  can open, diff in git, and hand to a teammate.
- **Forward-compatible** — unknown fields are preserved, not dropped (§4.1,
  §10.3), so a new producer and an old consumer interoperate without data loss.
- **Verifiable by a third party** — integrity today (§8), authenticity next (§7).

### 1.4 Relationship to the reference implementation

The normative source of truth for v1 is the Zod schema in `@plur-ai/core`:

| Artifact | Reference file |
|---|---|
| Engram object | `packages/core/src/schemas/engram.ts` |
| Pack manifest | `packages/core/src/schemas/pack.ts` |
| Capsule header & preamble | `packages/core/src/schemas/capsule.ts` |
| Capsule reader/writer | `packages/core/src/capsule.ts` |
| Pack hashing / integrity | `packages/core/src/packs.ts`, `packages/core/src/trust.ts` |
| Meta-engram extension | `packages/core/src/schemas/meta-engram.ts` |

The canonical machine-readable schemas accompanying this document are
`engram.schema.json` and `pack-manifest.schema.json` (JSON Schema Draft
2020-12). Where this prose and the JSON Schema disagree, the JSON Schema is
authoritative for *shape*; this prose is authoritative for *semantics*.

---

## 2. Serialization and data model — STABLE

### 2.1 Canonical serialization

The canonical on-disk serialization of engrams is **YAML 1.2**, UTF-8 encoded.
An engram store is a YAML document with a top-level `engrams:` key holding a
sequence of engram objects:

```yaml
engrams:
  - id: ENG-2026-05-06-001
    statement: "toEqual() in Vitest is strict — use toMatchObject() for partial matching"
    type: behavioral
    status: active
    scope: project:my-app
    domain: dev/testing
```

JSON is a permitted equivalent transport (the YAML above maps 1:1 to JSON; the
accompanying JSON Schemas validate either after parsing). YAML is RECOMMENDED on
disk because it is the human-editable form the ecosystem expects.

### 2.2 Value types

- **Strings** are UTF-8.
- **Timestamps** are strings. Two forms appear in v1:
  - *Date* form `YYYY-MM-DD` (e.g. `activation.last_accessed`).
  - *Instant* form, an ISO 8601 / RFC 3339 timestamp with offset
    (e.g. `2026-05-06T08:30:00Z`).
  This standard does NOT impose a single timestamp type on every field, because
  the reference does not; an implementer MUST accept both forms wherever a
  timestamp string is specified, and SHOULD emit RFC 3339 instants for new
  timestamps it creates. A future minor version MAY tighten this to RFC 3339
  everywhere (§10.2).
- **Numbers** are JSON numbers. Fields documented as integer MUST be whole
  numbers; fields documented with a `[min, max]` range MUST fall within it
  inclusive.

### 2.3 Defaults

Many fields carry defaults (see §4 and the JSON Schema `default` keywords). A
producer MAY omit a field with a default; a consumer MUST treat an absent field
as if it held its default. Defaults are part of the contract: an importer that
materializes defaults and a producer that omits them MUST round-trip to the same
logical engram.

---

## 3. Identifier grammar — STABLE

### 3.1 Grammar

Every engram has an `id` matching:

```
id          = class "-" body
class       = "ENG" / "ABS" / "META"
body        = 1*( ALPHA / DIGIT / "-" )
```

As a regular expression (the reference validator):

```
^(ENG|ABS|META)-[A-Za-z0-9-]+$
```

### 3.2 Class prefixes

| Prefix | Class | Meaning |
|---|---|---|
| `ENG` | Engram | A concrete, learned assertion. The common case. |
| `ABS` | Abstraction | A generalization that concrete engrams instantiate (referenced by an engram's `abstract` field). |
| `META` | Meta-engram | A cross-domain structural pattern induced from ≥2 engrams (see §11 and `meta-engram.ts`). |

### 3.3 Canonical concrete form

While the grammar permits any `[A-Za-z0-9-]+` body, the RECOMMENDED canonical
form for a freshly minted concrete engram is date-sequenced with full ISO-8601
date separators — the SAME form whether the id is minted locally or assigned
by a server (plur-ai/plur#771):

```
ENG-YYYY-MM-DD-NNN
```

- `YYYY-MM-DD` ISO-8601 calendar date (UTC at mint time), `NNN` a zero-padded
  per-day sequence number starting at `001`.
- Example: `ENG-2026-05-06-003`.

#### 3.3.1 Legacy compact form

Reference releases before the #771 convergence minted *local* ids with a
compact date while servers assigned the full-date form above, producing two
shapes for the same logical scheme:

```
ENG-YYYY-MMDD-NNN                 e.g.  ENG-2026-0506-003   (legacy, local)
```

Compact ids remain VALID forever — they match the §3.1 grammar, existing
stores containing them need NO migration, and consumers MUST accept both the
full-date and compact forms wherever a date-sequenced id is parsed (e.g. the
reference's `engramDate()` treats the day separator as optional).
Implementations MUST NOT mint new compact ids.

#### 3.3.2 Pack form

Engrams shipped in curated packs use a dateless, human-assigned form:

```
ENG-PACK-{NAME}-NNN               e.g.  ENG-PACK-EM-006
```

where `{NAME}` is a short uppercase abbreviation of the pack name. This is an
INTENTIONAL exemption from the date-sequenced scheme: pack content is
versioned by the pack manifest, not by mint date, and ids must stay stable
across pack releases so installs and upgrades can be diffed. Pack ids match
the §3.1 grammar. The `ABS-` and `META-` class prefixes (§3.2) combine with
every form in this section the same way (e.g. `ABS-PACK-EM-001`,
`META-2026-05-06-001`).

### 3.4 Store-namespaced form

When engrams from multiple stores are merged, an implementation MAY namespace an
ID with a short store **PREFIX** to avoid collisions. The prefix is inserted
directly after the class prefix; the rest of the id — whichever §3.3 form the
source store minted — is preserved verbatim:

```
ENG-{PREFIX}-YYYY-MM-DD-NNN       e.g.  ENG-GPL-2026-07-30-032
ENG-{PREFIX}-YYYY-MMDD-NNN        e.g.  ENG-DF-2026-0401-001   (legacy source id)
```

`PREFIX` is a SHORT uppercase token derived from the source scope (the
reference derives exactly three characters via `storePrefix()`, e.g.
`group:plur/engineering` → `GPL`-style abbreviations, and detects namespaced
ids with `^(ENG|ABS|META)-[A-Z]{3}-`). The namespaced form still matches the
grammar in §3.1. Implementations MUST treat the namespaced and bare forms as
referring to *different* logical engrams once namespacing has been applied
(the prefix is part of the identity in a merged view). Pack producers SHOULD
export *bare* IDs.

### 3.5 Uniqueness

Within a single store, `id` MUST be unique. On load, an implementation
encountering a duplicate ID SHOULD keep the first occurrence's ID and regenerate
IDs for the later duplicates (the reference's de-duplication behavior), rather
than fail the whole load.

---

## 4. The Engram object — STABLE (except where noted)

An engram is a map. The fields below are grouped by concern. For each: name,
JSON type, required/optional, range/enum, and semantics. Required fields are
marked **R**; all others are optional and carry the stated default when absent.

### 4.1 Open-world rule

The engram object is **open**: a consumer MUST preserve fields it does not
recognize and round-trip them unchanged. (The reference uses Zod `.passthrough()`
for exactly this reason: hand-added or future fields must not be silently
dropped.) The JSON Schema sets `additionalProperties: true` to encode this.
Conformance does NOT require understanding every field — it requires not
destroying any.

### 4.2 Identity

| Field | Type | R | Range / enum | Semantics |
|---|---|:--:|---|---|
| `id` | string | **R** | grammar §3 | Unique identifier. |
| `version` | integer | | ≥1, default `2` | Schema-shape generation of the object. Current shape is `2`. Distinct from `engram_version`. |
| `status` | string | **R** | `active` \| `dormant` \| `retired` \| `candidate` | Lifecycle state. `candidate` = proposed but not yet promoted; `dormant` = decayed out of active use; `retired` = superseded/forgotten. |
| `consolidated` | boolean | | default `false` | Whether the engram has been through consolidation reprocessing. |
| `type` | string | **R** | `behavioral` \| `terminological` \| `procedural` \| `architectural` | Top-level knowledge class. |
| `scope` | string | **R** | free-form | Hierarchical namespace. Convention: `kind:path`, e.g. `global`, `project:my-app`, `group:plur/test`. |
| `visibility` | string | | `private` \| `public` \| `template`, default `private` | Sharing posture. `private` engrams MUST NOT be exported (§5.4). `template` = shippable skeleton. |

### 4.3 Content

| Field | Type | R | Range / enum | Semantics |
|---|---|:--:|---|---|
| `statement` | string | **R** | minLength 1 | The assertion. The load-bearing text. |
| `rationale` | string | | | Why it is true / why it matters. |
| `contraindications` | string[] | | | Conditions under which the statement does NOT apply. |

### 4.4 Lineage

| Field | Type | R | Range / enum | Semantics |
|---|---|:--:|---|---|
| `source` | string | | | Free-text origin (session, document). |
| `source_patterns` | string[] | | | Pattern IDs that contributed. |
| `derivation_count` | integer | | ≥0, default `1` | Number of derivation steps. |
| `pack` | string \| null | | default `null` | Owning pack name, or null. A consumer satisfying §5.6.2 by writing this SHOULD do so; absence does NOT mean an engram is not from a pack. |
| `abstract` | string \| null | | default `null` | ID of an `ABS-` abstraction this instantiates. |
| `derived_from` | string \| null | | default `null` | ID of the parent engram. |

### 4.5 Classification

| Field | Type | R | Range / enum | Semantics |
|---|---|:--:|---|---|
| `knowledge_type` | object | | see below | `{ memory_class, cognitive_level }`. |
| `domain` | string | | | Dotted/slashed domain path, e.g. `dev/testing`, `plur.session`. |
| `tags` | string[] | | default `[]` | Free-form matching tags. |

`knowledge_type.memory_class` ∈ {`semantic`, `episodic`, `procedural`,
`metacognitive`}. `knowledge_type.cognitive_level` ∈ Bloom's taxonomy
{`remember`, `understand`, `apply`, `analyze`, `evaluate`, `create`}. Both
required when `knowledge_type` is present.

### 4.6 Activation (ACT-R) — drives decay & ranking state

| Field | Type | R | Range | Semantics |
|---|---|:--:|---|---|
| `activation.retrieval_strength` | number | **R*** | `[0,1]` | Current retrievability. |
| `activation.storage_strength` | number | **R*** | `[0,1]` | Long-term storage strength. |
| `activation.frequency` | integer | **R*** | ≥0 | Access count. |
| `activation.last_accessed` | string | **R*** | date/instant | Last access time. |

(**R\*** = required *if the `activation` object is present*. The whole
`activation` object is optional at the engram level and defaults to
`{retrieval_strength:0.7, storage_strength:1.0, frequency:0, last_accessed:<today>}`.)

### 4.7 Relations & grounding

| Field | Type | Range / enum | Semantics |
|---|---|---|---|
| `relations` | object | `broader`/`narrower`/`related`/`conflicts`, each string[] default `[]` | Typed graph edges to other engram IDs. |
| `associations` | object[] | each: `target_type` (`engram`\|`document`), `target` string, `strength` `[0,0.95]`, `type` (`semantic`\|`temporal`\|`causal`\|`co_accessed`), `updated_at?` | Weighted edges. Note `strength` caps at **0.95**, not 1.0. |
| `knowledge_anchors` | object[] | each: `path` (R), `relevance` (`primary`\|`supporting`\|`example`, default `supporting`), `snippet?` (≤200 chars), `snippet_extracted_at?` | Links to grounding documents. |
| `dual_coding` | object | `{ example?, analogy? }` — **at least one required** | Verbal + analogical encoding. Invariant: `example OR analogy` MUST be present if the object is present. |

### 4.8 Provenance — STABLE (origin/chain/license); `signature` RESERVED

| Field | Type | Range / enum | Semantics |
|---|---|---|---|
| `provenance.origin` | string (R within object) | | Where this engram came from. |
| `provenance.chain` | string[] | default `[]` | Derivation/transfer chain. |
| `provenance.signature` | string \| null | default `null` | **RESERVED.** Detached signature over the engram. Algorithm and canonicalization are NOT specified in v1 (§7). Producers MUST write `null`; consumers MUST round-trip whatever value is present without ascribing trust to it. |
| `provenance.license` | string | default `cc-by-sa-4.0` | License of this engram's content. |

**Who is answerable, and what kind of claim it is — PROPOSED (#961, #963)**

Both fields are optional. A producer that does not know a value MUST omit it
rather than guess. A record with no agent is valid; a record with a guessed agent
is worse than one with none.

| Field | Type | Range / enum | Semantics |
|---|---|---|---|
| `attribution` | object | all sub-fields optional | Who is answerable for this engram. `asserted_by` (address of who or what asserted it), `runtime` (`name`, `version?` of the software that wrote it), `model` (`name`, `prompt_id?`, `prompt_version?`, `prompt_sha256?` — prompt text is never stored), `tool` (`name`, `version?`), `on_behalf_of` (the party the runtime acted for). |
| `claim_class` | string | `observed`, `documented`, `structural`, `asserted`, `inferred`, `revised` | What kind of claim this is. Distinguishes a statement a person made from one a model inferred and one a pattern scraped — today those are stored identically. |

`attribution.asserted_by` holds an address and deliberately does not fix its form.
A local name, a Decentralized Identifier and an identifier for a running process
are all acceptable. When no identity is configured, producers SHOULD write the
well-known value `unidentified` rather than omitting the field: absence cannot be
told apart from a record written before identity was captured at all, and the
marker distinguishes the two.

Producers MUST NOT derive an identity from the operating system account. That
would write a personal name by default, without anyone choosing to share it.

Full treatment in [the provenance profile](./ENGRAM-PROVENANCE-PROFILE.md).

### 4.9 Feedback & usage state

| Field | Type | Range / enum | Semantics |
|---|---|---|---|
| `feedback_signals` | object | `{positive,negative,neutral}` integers, default `0` | Relevance counters. |
| `usage` | object | `{injections,hits,misses}` integers, `last_hit_at?` | Hit/miss tracking (Softmax-Engram-inspired). |

### 4.10 Structured extraction & temporal

| Field | Type | Range / enum | Semantics |
|---|---|---|---|
| `entities` | object[] | each: `name` (R), `type` ∈ {person, organization, technology, concept, project, tool, place, event, standard, other} (R), `uri?` (URI) | Typed entity refs for graph queries. |
| `temporal` | object | `learned_at` (R), `valid_from?`, `valid_until?`, `ingested_at?` | Bi-temporal validity window. |
| `episodic` | object | `emotional_weight` `[1,10]` int default 5, `confidence` `[1,10]` int default 5, `trigger_context?`, `journal_ref?` | Episodic context. |
| `structured_data` | object | arbitrary key→value | Domain-specific extension bag. |
| `polarity` | string \| null | `do` \| `dont` \| null, default `null` | Directive vs prohibition classification. |

#### 4.10.1 Convention: ETL extraction provenance (`structured_data.extraction`)

ETL extractors (e.g. the enterprise ETL CLI, enterprise#409) SHOULD carry
classifier-time provenance in `structured_data.extraction` (plur#463):

| Key | Type | Range | Semantics |
|---|---|---|---|
| `extraction.confidence` | number? | `[0,1]` | Classifier confidence at extraction time, frozen at write. |
| `extraction.source_commit` | string? | git SHA | Source repository commit at extraction time (reproducibility). |
| `extraction.extractor_version` | string? | semver | Version of the extracting tool (schema-migration handle). Complementary to the pack-level capsule `producer` field (plur#61), which carries tool+version at the envelope level. |

This is a **convention**, not a schema field: `structured_data` is already an
arbitrary extension bag, so no engram-schema change is involved. Reference
validation lives in `@plur-ai/core` as `ExtractionProvenanceSchema` /
`getExtractionProvenance(engram)` (returns `null` when absent or malformed;
unknown keys inside `extraction` are preserved for forward compatibility).
Promote to a first-class optional sub-object only when a consumer needs to
query/filter on it.

**Three distinct `confidence` semantics — implementers MUST NOT conflate them:**

1. `structured_data.extraction.confidence` — `[0,1]` **classifier** score,
   frozen at extraction time; never updated after write.
2. `computeConfidence()` — `[0,1]` score **derived from `feedback_signals`** at
   read time (+ consolidation bonus); changes as feedback accumulates.
3. `episodic.confidence` — `[1,10]` integer **subjective certainty** of an
   episodic memory (§4.10, DIP-0019).

Seeding one from another (e.g. initializing feedback-derived scores from
extraction confidence) corrupts the feedback loop.

### 4.11 Exchange metadata — PROPOSED

| Field | Type | Range | Semantics |
|---|---|---|---|
| `exchange.fitness_score` | number | `[0,1]` | Marketplace fitness. |
| `exchange.environmental_diversity` | integer | default 0 | Distinct environments adopting it. |
| `exchange.adoption_count` | integer | default 0 | Times adopted. |
| `exchange.contradiction_rate` | number | `[0,1]` default 0 | Observed contradiction rate. |

This block is **PROPOSED**: it is validated and round-tripped today, but its
semantics are expected to evolve with the exchange protocol. Implementers MAY
ignore the values.

### 4.12 Intelligence & evolution state

| Field | Type | Range / enum | Semantics |
|---|---|---|---|
| `content_hash` | string | | Hash of normalized statement, for dedup. |
| `commitment` | string | `exploring` \| `leaning` \| `decided` \| `locked` \| `draft` | Epistemic commitment level. `draft` marks the engram as pending human approval — core stores and recalls it normally; enforcement is left to deployments with a review queue. |
| `locked_at` | string | | When commitment became `locked`. |
| `locked_reason` | string | | Why locked. |
| `write_count` | integer | ≥0, default 1 | Same-scope re-learn count. Engram retires only at 0. Renamed from `reference_count` (#866); implementations MUST backfill on first parse. |
| `injection_count` | integer | ≥0, default 0 | Number of times this engram was selected into a session's injection context. Distinct from `activation.frequency` (recall events). High injection_count + low positive feedback_signals is an efficacy-failure signal (#865, #866). |
| `sources` | object[] | each: `scope` (R), `session_id?` (string\|null), `stored_at` (R, instant) | One entry per write attempt. |
| `recurrence_count` | integer | ≥0, default 0 | Different-scope re-learn count (universality evidence). |
| `engram_version` | integer | ≥1, default 1 | Content-evolution version. |
| `previous_version_ref` | object | `{event_id, changed_at}` | Pointer to prior content version. |
| `episode_ids` | string[] | default `[]` | Source episode IDs. |
| `summary` | string | ≤80 chars | Injection-friendly short form. |
| `pinned` | boolean | | Always-load flag; bypasses keyword gating. Use sparingly. |
| `measured_under` | object | `model?`, `source_type?`, `hardware?`, `dataset?`, `date?` (ISO date) | Measurement conditions for numeric/benchmark engrams — which model, environment type, hardware tier, dataset, and date the value was recorded under. Allows tension-aware retrieval to treat differently-measured values as refinements rather than contradictions (#869). |

### 4.13 Required-field summary

A minimally conformant engram is exactly:

```yaml
id: ENG-2026-05-06-001         # §3 grammar
statement: "…"                # non-empty
type: behavioral              # enum §4.2
status: active                # enum §4.2
scope: project:my-app         # free-form §4.2
```

All five of `id`, `statement`, `type`, `status`, `scope` are REQUIRED. Every
other field is optional with the default given above.

> **Note on `created_at`.** Some reference example documents show a top-level
> `created_at` timestamp. It is **not** a validated field in v1 — it survives
> only via the open-world rule (§4.1). Implementers SHOULD use `temporal.learned_at`
> (or `sources[].stored_at`) for authoritative creation time. A future minor
> version MAY promote a creation timestamp to a first-class field (§10.2).

### 4.14 Key invariants (normative)

1. `id` matches §3.1. **MUST.**
2. `statement` length ≥ 1. **MUST.**
3. `status`, `type`, `visibility`, `polarity`, all enum-typed sub-fields hold
   only their listed values. **MUST.**
4. Numeric ranges hold inclusively: `activation.*` in `[0,1]`,
   `association.strength` in `[0,0.95]`, `episodic.*` in `[1,10]`, etc. **MUST.**
5. If `dual_coding` is present, at least one of `example`/`analogy` is present.
   **MUST.**
6. Unknown fields are preserved on round-trip. **MUST.**
7. `private`-visibility engrams are excluded from pack export. **MUST** (§5.4).

---

## 5. The Pack format — STABLE

A **pack** is a portable, named, versioned bundle of engrams plus a manifest and
an integrity file.

### 5.1 Directory layout

```
<pack-name>/
├── SKILL.md          (REQUIRED — manifest as YAML frontmatter)
├── engrams.yaml      (the engrams, top-level `engrams:` sequence)
├── INTEGRITY         (pack content hash; see §5.5)
└── provenance/       (OPTIONAL — PROV records; see the provenance profile §5.3)
```

- A pack **MUST** ship a `SKILL.md`, carrying the manifest as its **YAML
  frontmatter** (delimited by `---` … `---`, with human-readable prose after it).
  The frontmatter MUST be a valid manifest (§5.2) — presence of an empty or
  invalid `SKILL.md` is not conformant.
- A standalone **`manifest.yaml`** is **DEPRECATED**. The reference loader still
  reads a `manifest.yaml`-only pack (emitting a deprecation warning) and
  **auto-upgrades it to `SKILL.md` frontmatter on install**; new packs MUST be
  published with a `SKILL.md`. `manifest.yaml` does not contribute to the
  integrity hash (§5.5).
- `engrams.yaml` is a §2.1 store document.
- `INTEGRITY` is OPTIONAL on disk but RECOMMENDED for distribution; the
  authoritative integrity record at install time is the registry entry (§5.5).
- `provenance/` is OPTIONAL. When present it holds W3C PROV records describing
  where the pack and its engrams came from; its layout and contents are
  specified in §5.3 of the [provenance profile](./ENGRAM-PROVENANCE-PROFILE.md).
  These files are **not** covered by the §5.5 integrity hash, which is defined
  over `SKILL.md` ‖ `engrams.yaml` only. A pack SHOULD declare their presence
  via `metadata.provenance` (§5.2) so a reader need not probe for the directory.

### 5.2 Manifest fields

The manifest object (see `pack-manifest.schema.json`):

| Field | Type | R | Range / enum | Semantics |
|---|---|:--:|---|---|
| `name` | string | **R** | | Pack name; registry key. |
| `version` | string | **R** | SemVer recommended | Validated as opaque string, not range-checked. |
| `description` | string | | | Human description. |
| `creator` | string | | | Author/handle. |
| `license` | string | | default `cc-by-sa-4.0` | Pack license. |
| `tags` | string[] | | default `[]` | Discovery tags. |
| `metadata` | object | | see below | Preferred loader-metadata block. |
| `x-datacore` | object | | see below | **LEGACY** loader block, retained for backward compat. |

`metadata`:

| Field | Type | Range / enum | Semantics |
|---|---|---|---|
| `id` | string | | Stable machine id. |
| `injection_policy` | string | `on_match` \| `on_request` \| `always`, default `on_match` | When the loader may inject this pack. |
| `match_terms` | string[] | default `[]` | Keywords gating `on_match`. |
| `domain` | string | | Domain. |
| `engram_count` | number | | Advisory count (loaders count the real file). |
| `provenance` | boolean | default absent | The pack ships PROV records under `provenance/` (§5.1). A **declaration, not evidence**: it is written by the producer and covered by the §5.5 hash, but a reader MUST still verify the directory exists and the records parse before relying on them. Absent means "not declared", which is not the same as "none present". |

`x-datacore` is the same shape **except** `injection_policy` ∈ {`on_match`,
`on_request`} only (no `always`), `id` and `injection_policy` are required, and
`engram_count` is a non-negative integer. New packs SHOULD use `metadata`.

### 5.3 Example manifest (SKILL.md frontmatter)

```markdown
---
name: Effective Memory
version: "1.1.0"
creator: plur-ai
license: MIT
tags: [memory, learning, best-practices]
metadata:
  id: effective-memory
  injection_policy: on_match
  match_terms: [memory, learn, recall, engram, session]
  domain: plur.best-practices
  engram_count: 12
---

# Effective Memory

Prose documentation for humans goes here…
```

### 5.4 Export privacy rule — MUST

When producing a pack from a live store, a producer MUST exclude:

- engrams with `visibility: private`, and
- engrams whose content trips a secret scan (API keys, tokens, passwords).

A producer SHOULD also strip store-local state that is meaningless to a
recipient: cross-reference `relations.related`/`relations.conflicts`,
**`relations.supersedes`/`relations.superseded_by`**, `associations`, local
`knowledge_anchors`, and SHOULD reset `activation` (fresh `retrieval_strength`,
`frequency: 0`) and `feedback_signals` to zero so the recipient builds their own
usage history. (This mirrors the reference `exportPack`.)

Supersession edges are store-local in the same way the other cross-references
are: they name engram ids that mean nothing in the recipient's store, and a stale
edge landing on an id collision would suppress tension detection between
unrelated engrams.

A producer MUST also neutralize fields by which a pack could override the
recipient's own behaviour:

- **`pinned` MUST be removed.** A pinned engram bypasses the relevance gate and
  is injected unconditionally. A pack is an archive from a stranger, and letting
  its author decide what is always in front of the recipient's model is a
  privilege no producer may take.
- **`commitment: locked` MUST be downgraded to `decided`,** and `locked_at` and
  `locked_reason` removed with it. A locked engram resists dedup and correction,
  so shipping one hands the producer a claim the recipient cannot revise.

These two are stated as MUST rather than SHOULD because, unlike the strip list
above, leaving them in place is not merely untidy — it changes whose judgement
governs the recipient's store. A consumer SHOULD enforce both on import as well
rather than trusting the producer, since a hostile pack will not comply
(see §5.6).

### 5.5 Pack integrity — STABLE

Pack integrity is a **SHA-256** over the pack's `SKILL.md` followed by its
engrams file:

```
H = SHA256( bytes(SKILL.md)  ||  bytes(engrams.yaml) )
```

- `SKILL.md` is REQUIRED (§5.1) and is always hashed; `engrams.yaml` bytes are
  appended if present. A deprecated `manifest.yaml`, if any, does **not**
  contribute to `H` (the reference auto-upgrades it to `SKILL.md` on install, so
  the recorded integrity is over `SKILL.md` + `engrams.yaml`).
- The hash is recorded as the string `sha256:<64-lowercase-hex>` — in the
  `INTEGRITY` file (single line, trailing newline) and/or in the consumer's
  install registry.
- A receiver verifies by recomputing `H` over the received bytes and comparing
  to the recorded `sha256:` value. Mismatch MUST be treated as a failed
  integrity check.

> **Implementation note.** The reference exposes a single §5.5 construction:
> `computePackHash` (`packs.ts`, used for the registry/`INTEGRITY`) and
> `computePackChecksum` (`trust.ts`, used for trust verification) compute the
> identical hash — `computePackChecksum` delegates to `computePackHash` — so they
> cannot diverge. Hashing is over **raw file bytes**, so producers and consumers
> MUST NOT re-serialize before hashing.

#### 5.5.1 Two hashes, two questions

The rule above is about the **pack integrity value**: the hash of the bytes a
producer shipped, recorded in `INTEGRITY`, and the only value a recipient can
compare against what they received. It answers *"did this arrive as it was sent?"*
and it MUST be computed over the received bytes, unmodified.

A consumer that alters content on import — as §5.4's MUST-neutralize rules
require it to, and as §5.6 permits for sanitisation — then holds something that is
no longer those bytes. The hash of *that* is a second and different value,
answering *"has the installed copy been altered since it was installed?"*

**These MUST NOT be conflated.** An implementation that stores the post-import
hash under the name of the pack integrity value has lost the ability to answer
the first question at all, and a recipient comparing it against the producer's
`INTEGRITY` will see a mismatch that means nothing.

An implementation that neutralizes on import therefore records both, named
distinctly: the shipped value as received, and the installed-content value it
computes itself. §5.1's statement that "the authoritative integrity record at
install time is the registry entry" refers to the second — the record of what is
installed — and does not license overwriting the first.

> **Known divergence in the reference, as of this revision.** `_installPackDir`
> re-serializes `engrams.yaml` after neutralizing `pinned` and `locked`, then
> records the hash of the rewritten file as the registry's `integrity`. So for any
> pack containing a pinned or locked engram, the recorded value is the
> installed-content hash carrying the pack-integrity name, and the shipped value is
> compared at the gate and then discarded. Tracked in #1019; the fix is to record
> both.

---

### 5.6 Install — SPECIFIED

§5.1 to §5.5 describe a pack as an artifact. This section describes receiving
one.

A **consumer** is any implementation that takes a pack and makes its engrams
available to a reader. The rules below are about a pack that arrived from
somewhere else. That is the only case worth specifying, because a pack a
consumer built itself needs no defending against.

#### 5.6.1 Order of operations — MUST

A consumer MUST perform these in order, and MUST NOT make any engram available
to a reader until all of them have completed:

1. **Verify integrity** (§5.5). Recompute over the received bytes and compare to
   the shipped `INTEGRITY`. A mismatch MUST abort the install unless the
   installer has explicitly overridden it for this pack.
2. **Scan for secrets.** A pack whose content trips a secret scan MUST be
   refused, and the refusal MUST NOT be overridable. §5.4 makes excluding
   secrets a producer obligation; a consumer cannot assume the producer complied.
3. **Neutralize host-overriding fields** (§5.4): remove `pinned`, downgrade
   `commitment: locked` to `decided`. A consumer MUST do this even though §5.4
   also requires the producer to, and MUST report how many engrams were changed.
4. **Resolve scope** (§5.6.3).
5. **Record the install** (§5.6.4).

Ordering matters and is not merely tidy. Verification before scanning means a
tampered pack is refused before its content is parsed. Scanning before
neutralizing means the scan sees what was shipped rather than what was cleaned.
Recording last means a failed install leaves no record claiming otherwise.

A consumer MAY additionally refuse a pack on grounds this standard does not
define — prompt-injection heuristics, size limits, an unrecognised producer. Such
refusals are implementation policy and MUST be reported as such rather than as
conformance failures.

#### 5.6.2 Where engrams go — implementation choice, with one requirement

This standard does not say where a consumer stores installed engrams. Keeping
them in the pack directory, merging them into a primary store, or projecting them
into a database are all conformant.

**The requirement is that the consumer MUST be able to determine, for any engram
it has made available, which pack it came from, and MUST be able to enumerate the
engrams of an installed pack.** Membership MUST be durable — it MUST survive a
restart and MUST NOT depend on the pack directory remaining on disk in a
particular shape.

Without that, §5.8 is not implementable: an installed pack cannot be removed if
nothing records what it installed. The requirement is stated as a capability
rather than a mechanism because the honest options differ by store —
the `pack` field (§4.4), a registry keyed by engram id, or an append-only
record naming the set are all sufficient.

> **Note on `pack` (§4.4).** The field is defined as *"Owning pack name, or
> null"*. A consumer that satisfies this section by writing it SHOULD do so.
> A consumer that satisfies it another way MAY leave `pack` null, but MUST NOT
> rely on the field's absence meaning an engram is not from a pack.

#### 5.6.3 Scope on import — MUST NOT decide silently

A pack's engrams arrive carrying the scopes its **producer** wrote. Those names
belong to the producer's installation. `group:acme/engineering` in a received
pack does not name the recipient's engineering group; if a group of that name
exists locally it is a different group that happens to collide.

Therefore:

- A consumer **MUST NOT** place engrams from a received pack into a shared scope
  (§4.2) on the producer's say-so alone. The installer decides.
- A consumer **MUST NOT** place them into a scope that would widen their audience
  beyond the installer's own read access.
- A consumer **SHOULD** let the installer name one target scope for the pack, and
  **SHOULD** report the scope every engram landed in.
- Where a pack declares `global` or an equivalent everyone-sees-it scope, a
  consumer **MUST** obtain explicit consent rather than adopting it.

The rule is about consent, not taxonomy. A recipient installing a pack is
agreeing to hold its contents; they are not thereby agreeing to show them to
their whole organisation.

#### 5.6.4 The install registry — normative

§5.1 and §5.5 both call the registry authoritative and neither says what it is.

An **install registry** is a durable record, held by the consumer, of the packs
it has installed. It is not part of a pack and never travels with one.

A registry entry MUST carry:

| Field | Semantics |
|---|---|
| `name` | The installed pack's manifest `name`. Unique within a registry. |
| `version` | The manifest `version` as shipped. REQUIRED — §5.7 cannot order without it. |
| `installed_at` | RFC 3339 instant. |
| `integrity_shipped` | The `sha256:` value the pack shipped, verbatim, or explicitly absent if it shipped none. This is what a later re-verification compares against (§5.5.1). |
| `source` | Where the pack came from, in a form the consumer can act on — a path, a URL, or an explicit "no longer resolvable". REQUIRED, because §5.8 makes removal reversible only if it survives. |

A registry entry SHOULD carry `integrity_installed` (§5.5.1), `creator`, the
resolved target scope (§5.6.3), and a pointer to the engram membership required
by §5.6.2.

A consumer MUST NOT treat an unreadable registry as an empty one. An empty
registry means nothing is installed; an unreadable one means the consumer does
not know, and proceeding as though nothing is installed silently duplicates
every pack the user has.

#### 5.6.5 What a consumer MUST report

An install is a change to knowledge the reader will act on. A consumer MUST
report, in a form the installer sees:

- engrams installed
- engrams neutralized under §5.6.1 step 3, and which field was changed
- the integrity verdict, including "the pack shipped none" as distinct from "it
  matched"
- the scope every engram landed in
- conflicts detected with content the consumer already held, where it detects any

A consumer that found provenance records in the pack MUST report what it found,
per §5.4 of [the provenance profile](./ENGRAM-PROVENANCE-PROFILE.md).

Silence is the failure mode this guards against. A pack that installs with no
output is indistinguishable from one that installed nothing.

---

### 5.7 Update — SPECIFIED

Replacing an installed pack with a later version of the same pack.

#### 5.7.1 Ordering versions

§5.2 validates `version` as an opaque string, which cannot be ordered. For update
to mean anything, ordering has to exist somewhere.

- A producer **SHOULD** use SemVer for `version`, and **MUST** use a scheme in
  which later releases order after earlier ones under the comparison the producer
  documents.
- SemVer **build metadata MUST NOT** be the only thing distinguishing two
  versions: SemVer ignores it for precedence, so `1.0.0+a` and `1.0.0+b` compare
  equal and a consumer cannot tell which is later.
- A consumer **MUST NOT** infer an ordering it cannot compute. Where two versions
  are not comparable, it MUST treat the operation as a replacement requiring
  explicit confirmation rather than guessing a direction.

A consumer MUST distinguish three cases and MUST NOT silently perform any of
them as though it were another: **upgrade** (candidate orders after installed),
**reinstall** (equal), **downgrade** (orders before). A downgrade MAY be
permitted; if it is, it MUST be explicit.

#### 5.7.2 Which engrams correspond

Correspondence is by engram `id`. §3.3.2 gives packs a dateless id form for
exactly this reason — so ids are stable across releases and two versions can be
diffed.

For each id: present in both is a **carry-over**, new in the candidate is an
**addition**, present only in the installed version is a **departure**.

#### 5.7.3 Recipient-accumulated state — MUST NOT be silently discarded

A recipient accumulates state against installed engrams: feedback, usage counts,
activation, and any review or approval decisions their implementation records.
That state is the recipient's, not the producer's, and an update MUST NOT
silently destroy it.

- For a **carry-over**, a consumer MUST preserve recipient-accumulated state,
  even where the engram's `statement` changed. The recipient's judgement was
  about that engram, and the id is what identifies it.
- For a **departure**, a consumer MUST NOT simply drop the engram. It MUST be
  retired under §5.8's rules, so that a reader asking about it learns it was
  withdrawn by an update rather than finding nothing.
- Producer-side state in the candidate — `activation`, `feedback_signals`, which
  §5.4 requires a producer to reset — MUST NOT overwrite the recipient's.

#### 5.7.4 What a consumer MUST report

Additions, departures and carry-overs whose content changed, with counts, and the
version transition. An update that reports only "updated" tells the reader
nothing about what they are now relying on.

---

### 5.8 Uninstall — SPECIFIED

Removing an installed pack.

#### 5.8.1 Retire, do not erase — MUST

A consumer MUST NOT make an installed pack's engrams silently disappear.

Where the consumer's model has a retired or withdrawn state, engrams from an
uninstalled pack MUST be moved into it rather than deleted, and the reason MUST
name the pack and version. A reader who later asks about one MUST be able to
learn that it existed and was withdrawn.

The distinction matters because the alternative is indistinguishable from having
never known. A memory system whose removals leave no trace cannot answer why it
no longer believes something — and that question is the reason provenance exists.

A consumer MAY additionally offer a permanent erase, and where it does, that MUST
be a separate and explicit operation, never the default path of uninstall.

#### 5.8.2 Reversibility — SHOULD

A consumer SHOULD retain enough to reinstall: the registry entry's `source`, and
where practical the artifact itself.

A consumer MUST NOT discard the `source` before completing the removal. Removing
the record of where a pack came from as a step of removing the pack leaves the
operation irreversible by construction, which is a defect rather than a policy.

#### 5.8.3 What survives

Recipient-accumulated state MAY be discarded on uninstall, but a consumer SHOULD
retain it against the retired engrams so a reinstall does not lose the
recipient's judgement.

Content the recipient independently learned that happens to match a pack engram
is **not** part of the pack and MUST NOT be removed with it. Membership is what
§5.6.2 recorded, not similarity.

#### 5.8.4 What a consumer MUST report

Engrams retired, whether the source was retained, and what the consumer kept.

---

### 5.9 Where the reference does not yet comply

§5.6 to §5.8 were written from the behaviour a consumer needs, not from the
behaviour the reference has. It has less. Listed here rather than left for an
implementer to discover by disagreeing with us:

| Rule | Reference today | Tracked |
|---|---|---|
| §5.6.2 membership | The registry records pack names, not engram ids, and `pack` (§4.4) is never written. There is no way to enumerate an installed pack's engrams, so §5.8 is not implementable. | plur-ai/plur#1025, #1023 |
| §5.6.3 scope | No scope resolution on import at all. Engrams keep the producer's scopes, including `global`; the installer is warned and not asked. | plur-ai/plur#1024 |
| §5.6.4 registry | `integrity_shipped` is not retained — the post-neutralization hash is recorded under that name (§5.5.1). `source` is present but removed *before* the pack directory during uninstall. | plur-ai/plur#1027 |
| §5.7 update | No update path exists for a user-installed pack. Versions are never compared at install, so upgrade, reinstall and downgrade are indistinguishable. | plur-ai/plur#1026 |
| §5.8.1 retire | Uninstall deletes the pack directory. Nothing is retired, no reason is recorded, and no history event is written. | plur-ai/plur#1027 |

This table is a conformance statement, not an apology. A standard whose reference
silently diverges teaches implementers the divergence; one that names its gaps
lets them decide what to build against.

---

## 6. The `.plur` capsule — STABLE

A **capsule** seals a pack into one integrity-checked binary file. It is the
single-file distribution unit (for marketplaces, attachments, content
addressing). Reference: `schemas/capsule.ts` + `capsule.ts`.

### 6.1 Byte layout

All multi-byte integers are **little-endian (LE)**.

```
Offset  Size  Field
------  ----  -----------------------------------------------------------
0       4     MAGIC          = 0x50 0x4C 0x55 0x52  ("PLUR")
4       2     FormatVersion  uint16  (v1 = 0x0001)
6       2     Flags          uint16  (§6.3)
8       4     HeaderLen      uint32  (byte length of Header JSON; MUST be > 0)
12      H     Header         UTF-8 JSON, exactly HeaderLen bytes (§6.4)
12+H    P     Payload        opaque bytes, length = header.payload.size_compressed
12+H+P  S     Signature      present iff Flags.SIGNED; S = 64 bytes (Ed25519) — RESERVED (§7)
```

Bytes `0..12` are the **preamble** (a fixed 12-byte prefix).

### 6.2 Format version

- `FormatVersion` for this standard is `0x0001`.
- A reader MUST reject any `FormatVersion` it does not support.
- New major capsule revisions get new `FormatVersion` values; the magic is
  unchanged.

### 6.3 Flags — STABLE bits 0–1; bits 2–15 RESERVED

| Bit | Mask | Name | Meaning |
|---:|---|---|---|
| 0 | `0x0001` | `SIGNED` | A 64-byte Ed25519 signature trailer is present. (Trailer layout STABLE; signature *semantics* RESERVED — §7.) |
| 1 | `0x0002` | `COMPRESSED` | The payload is gzip-compressed. |
| 2–15 | `0xFFFC` | — | **RESERVED.** MUST be zero. A reader MUST reject a capsule with any reserved flag bit set. |

Consistency rule: the `COMPRESSED` flag MUST agree with
`header.payload.compression` (`gzip` ↔ set, `none` ↔ clear). Disagreement MUST
fail the read.

### 6.4 Header (JSON) — STABLE

The header is a JSON object (`schema: "plur.capsule/1"`):

| Field | Type | R | Semantics |
|---|---|:--:|---|
| `schema` | const `"plur.capsule/1"` | **R** | Header schema tag. |
| `product_type` | `engram-pack` \| `skill` | **R** | What the payload contains. |
| `manifest_summary` | object | **R** | `{ name (R), version (R), creator?, engram_count (R,int≥0), domain?, license (default cc-by-sa-4.0) }`. A denormalized copy of pack identity for listing without unpacking. |
| `payload` | object | **R** | `{ compression: gzip\|none, size_compressed: int≥0, size_uncompressed: int≥0, sha256: /^[0-9a-f]{64}$/ }`. |
| `created_at` | string (RFC 3339, with offset) | **R** | Capsule creation instant. |
| `producer` | object | **R** | `{ tool (R), version (R), agent_id? }` — what wrote the capsule. |
| `signer` | object \| null | | `{ algo: const "ed25519", public_key (R), key_id? }` or `null`. Default `null`. **RESERVED** when non-null (§7). |

### 6.5 Payload

The payload is opaque bytes — typically a **gzip-compressed tar** of a pack
directory (`SKILL.md` + `engrams.yaml`). The capsule format does
not constrain the internal payload structure beyond what `product_type` implies;
unpacking yields a §5 pack.

### 6.6 Size limits — STABLE

- **Soft limit:** 100 MiB (`100 * 1024 * 1024`). Producers SHOULD stay under it.
- **Hard limit:** 1 GiB (`1024 * 1024 * 1024`). `HeaderLen`, total capsule size,
  and any single dimension MUST NOT exceed the hard limit; a reader MUST reject a
  capsule (or a `HeaderLen`) above it.

### 6.7 Read algorithm (normative)

A conformant reader MUST:

1. Reject if total length > hard limit (§6.6).
2. Read the 12-byte preamble. Reject if < 12 bytes.
3. Verify `MAGIC == "PLUR"`. Reject on mismatch.
4. Read `FormatVersion`; reject if unsupported (§6.2).
5. Read `Flags`; reject if any RESERVED bit (`& 0xFFFC`) is set (§6.3).
6. Read `HeaderLen`; reject if `0` or > hard limit.
7. Read `HeaderLen` bytes of UTF-8 JSON; parse and validate against §6.4. Reject
   on malformed JSON or schema violation.
8. Determine signature length `S` = 64 if `SIGNED` set, else 0. Compute the
   payload region as `[12+HeaderLen, len-S)`. Reject on underflow.
9. Verify `len(payload) == header.payload.size_compressed`. Reject on mismatch.
10. Compute `SHA256(payload)` and compare to `header.payload.sha256`. Reject on
    mismatch (this is the integrity gate — §8).
11. Verify the `COMPRESSED` flag agrees with `header.payload.compression` (§6.3).
12. If `SIGNED`, the trailing 64 bytes are the signature. Signature
    *verification* is RESERVED (§7) — a v1 reader extracts the bytes but does not
    derive trust from them.

### 6.8 Write algorithm (normative)

A conformant writer MUST:

1. Compute `sha256 = SHA256(payload)` and set `payload.size_compressed =
   len(payload)`, `size_uncompressed` accordingly.
2. Build and validate the §6.4 header; serialize as UTF-8 JSON; set
   `HeaderLen = len(headerJson)`.
3. Set `Flags`: `COMPRESSED` iff `compression == gzip`; `SIGNED` iff a signer is
   present. All RESERVED bits zero.
4. Refuse to emit a signature without a signer, or a signer without a 64-byte
   signature (no ambiguous envelopes).
5. Concatenate `preamble || header || payload || [signature]`. Reject if total >
   hard limit.

---

## 7. Signing model (authenticity) — RESERVED

v1 specifies the *space* for signatures but not a verifiable signing scheme. The
following is RESERVED: the wire space is allocated and MUST be preserved, but no
v1 implementation derives trust from a signature, and no canonicalization is
fixed.

**Intended scheme (to be finalized in a future version):**

- **Algorithm:** Ed25519 (RFC 8032). Public keys and signatures are fixed-length
  (32-byte key, 64-byte signature).
- **Capsule signature.** When `Flags.SIGNED` is set, a 64-byte Ed25519 signature
  trailer follows the payload, and `header.signer = { algo: "ed25519",
  public_key, key_id? }`. **Open question (RESERVED):** the exact signed
  message. The natural candidate is the byte range
  `preamble || header || payload` (everything before the trailer), so the
  signature commits to format version, flags, header, and payload together.
  v1 does NOT freeze this; producers MUST set `signer: null` and MUST NOT set
  `SIGNED` until the scheme is ratified.
- **Engram-level signature.** `provenance.signature` (§4.8) is a detached
  signature over a single engram. **Open question (RESERVED):** the
  canonicalization of an engram prior to signing (e.g. JCS / RFC 8785 canonical
  JSON over a defined subset of fields, excluding volatile state like
  `activation`/`usage`/`feedback_signals`). v1 fixes neither the field subset nor
  the canonicalization; producers MUST write `null`.
- **Key distribution / revocation.** Out of scope for v1. A future profile will
  bind `key_id` to a resolvable key record.

A v1 conformant implementation:

- MUST round-trip `provenance.signature` and `header.signer` unchanged.
- MUST NOT claim a capsule or engram is "verified/authentic" on the basis of a
  signature in v1.
- SHOULD treat the presence of `SIGNED` on a v1 capsule as a producer error
  (since the scheme is not ratified) — at minimum it MUST NOT mislead the user
  into believing authenticity was checked.

---

## 8. Integrity model — STABLE

Integrity (the payload is intact and unmodified) is **separate** from
authenticity (who produced it). v1 delivers integrity; authenticity is §7.

- **Hash:** SHA-256.
- **Pack integrity:** §5.5 — `sha256:` over `SKILL.md` bytes ‖ `engrams.yaml`
  bytes, recorded in `INTEGRITY` / registry.
- **Capsule integrity:** §6.4/§6.7 step 10 — `header.payload.sha256` over the
  payload bytes, checked on every read; plus the structural checks (magic,
  version, size, flag consistency, declared sizes).
- A receiver MUST refuse to act on a pack or capsule whose recomputed hash does
  not match the recorded value.

Content addressing: because the pack hash is deterministic over raw bytes, it
doubles as a content-addressable identifier (and is the bridge to the Swarm
anchor in §9).

---

## 9. Provenance binding (PROV-O + Swarm anchor) — PROPOSED

> **Elaborated in a companion profile.**
>
> This section remains part of the standard. The sketch below is worked out in
> full in [Recording where an engram came from](./ENGRAM-PROVENANCE-PROFILE.md),
> a *profile* of this section: it specifies the mapping, every way an engram can
> be created, the pack-level record, the licence binding, and what has to be
> captured first.
>
> A profile refines; it does not replace. This section keeps its normative
> standing, states the motivation concisely, and defines the Swarm anchor — which
> the profile deliberately leaves out of its own scope (profile §1.2, §2.3).
> Where the two overlap, this document governs; where the profile is more
> specific, follow the profile. An implementer building provenance should read
> the profile, and read this section for the anchoring layer above it.
>
> Two things the profile settles that this sketch left open. A record you SEND
> must stand on its own, since the recipient has none of our files. And the four
> provenance fields defined in §4.8, although marked stable, were written by
> nothing at all until that work began.


This section is a **PROPOSED profile**, non-normative for v1. It documents how an
engram or pack binds to a W3C PROV-O provenance record and to a Swarm content
anchor, so the design is explicit and fundable.

### 9.1 Motivation

The on-engram `provenance` block and the per-write `sources[]` give a *local*
account of origin. A standard provenance binding lets a third party verify an
*external, immutable* provenance trail: who derived what, from what, when, and
where the bytes are anchored.

### 9.2 PROV-O mapping (proposed)

Map engram/pack concepts onto [W3C PROV-O]:

| Engram concept | PROV-O term |
|---|---|
| an engram / a pack | `prov:Entity` |
| a learn/derive/consolidate step | `prov:Activity` |
| the agent or tool that produced it | `prov:Agent` (`prov:SoftwareAgent` for tools) |
| `derived_from`, `abstract`, `provenance.chain` | `prov:wasDerivedFrom` |
| `sources[].stored_at`, `temporal.learned_at` | `prov:generatedAtTime` |
| `producer` (capsule) | `prov:wasAttributedTo` / `prov:wasGeneratedBy` |

A pack MAY carry PROV-O records in JSON-LD, or reference an external PROV
document by URI.

> **Corrected in 1.2.** This paragraph previously read *"A pack MAY carry a
> sidecar `provenance.jsonld` (PROV-O in JSON-LD) inside the capsule payload"* —
> a single file, because it was drafted with one engram in mind. A pack needs one
> record per engram plus one for the pack itself, which a single file cannot hold.
>
> The layout is **a `provenance/` directory** containing `pack.jsonld` and one
> `<engram-id>.jsonld` per engram, specified in §5.3.1 of
> [the provenance profile](./ENGRAM-PROVENANCE-PROFILE.md) and reflected in §5.1
> above. The correction is recorded here rather than made silently because §9 of
> this document governs where it and the profile overlap, so an implementer
> reading §9 alone was being told to build the wrong thing.

### 9.3 Swarm anchor (proposed)

The pack/capsule SHA-256 (or the Swarm BMT/`bzz` reference of the uploaded
bytes) serves as an immutable **anchor**. Proposed binding fields (to live under
`structured_data` or a future `anchor` block, both engram- and pack-level):

```yaml
anchor:
  scheme: swarm          # content-addressed store
  ref: <bzz reference>   # Swarm hash of the canonical bytes
  hash_alg: sha256       # the §8 integrity hash
  recorded_at: <RFC3339>
```

The chain is then: **engram/pack** → (PROV-O activity/agent) → **content hash**
(§8) → **Swarm anchor**. A verifier resolves the anchor, fetches the bytes,
recomputes the §8 hash, and confirms it matches the engram/pack's recorded
integrity value, giving tamper-evident provenance independent of the producer.

### 9.4 Status

PROPOSED. No v1 field is required to carry an anchor. The binding, the exact
field names, and the canonicalization that the Swarm anchor commits to are part
of the fundable remainder (see the spec README).

---

## 10. Versioning & compatibility policy — STABLE

### 10.1 What "v1" labels

"Open Engram Standard v1" is the document version. It is distinct from:

- the engram **object shape** `version` field (currently `2`),
- a single engram's **content** `engram_version`,
- the **capsule** `FormatVersion` (`0x0001`),
- the **capsule header** `schema` tag (`plur.capsule/1`),
- a **pack** `version` (the pack author's SemVer).

These evolve on independent clocks; this section governs the *document* and the
compatibility guarantees it makes.

### 10.2 Change classes

- **Patch (1.0.x):** editorial clarifications, no wire change.
- **Minor (1.x):** additive only — new OPTIONAL engram fields, new RESERVED flag
  bits gaining defined behavior, new manifest fields, promotion of a documented
  PROPOSED item to STABLE or RESERVED. MUST NOT remove a field, tighten a type
  in a way that rejects previously-valid data, or change an enum's existing
  members' meaning. A minor MAY narrow timestamp acceptance only by deprecation
  with a transition window.
- **Major (2.0):** anything that can reject previously-valid v1 data — a new
  capsule `FormatVersion`, a removed/renamed field, a tightened constraint.

### 10.3 Forward/backward compatibility rules (normative)

1. **Unknown engram fields MUST be preserved** (§4.1). A v1 consumer reading a
   v1.(n+1) engram keeps the fields it does not understand.
2. **Unknown manifest fields MUST be preserved** (`additionalProperties: true`).
3. **Capsule readers MUST reject unknown `FormatVersion`** rather than guess.
4. **RESERVED flag bits MUST be zero** on write and **MUST cause rejection** on
   read if set, until a version defines them — this keeps the flag space safely
   extensible.
5. **Defaults are stable** — a field's default (§2.3) MUST NOT change in a minor
   version, because that would silently change the meaning of existing omitted
   fields.
6. **Enums grow, never repurpose** — a minor version MAY add an enum member;
   existing members keep their meaning forever.

### 10.4 Deprecation

A field/flag is deprecated by: marking it DEPRECATED in this document, keeping it
parseable (consumers still accept it), and providing the replacement. Removal
happens only at a major version. The `x-datacore` manifest block (§5.2) is the
canonical example: retained, parseable, superseded by `metadata`.

### 10.5 Revision history

Every revision of this document is recorded here, so a reader can tell which one
they are holding and what changed. Version numbers follow §10.2.

| Version | Date | Change class | What changed |
|---|---|---|---|
| 1.3 | 2026-08-26 | Minor (additive) | **New maturity label SPECIFIED** — normative and frozen, but not yet implemented in the reference; the vocabulary previously conflated "binding on implementers" with "implemented here" and so could not describe a rule written ahead of its own implementation. **§5.6 Install, §5.7 Update and §5.8 Uninstall added** — the standard described a pack as an artifact and said nothing about receiving one. §5.6 fixes the order of operations, requires a consumer to be able to answer which pack an engram came from, forbids adopting a producer's shared scopes without the installer's consent, and **defines the install registry** that §5.1 and §5.5 already called authoritative. §5.7 requires an orderable version and forbids silently discarding recipient-accumulated state across an update. §5.8 requires retire-rather-erase and forbids discarding a pack's source as a step of removing it. §4.4's `pack` gains a consumer-side note. §5.9 lists where the reference does not yet comply. Nothing here constrains previously-valid pack *data*; the new obligations fall on consumers, which the document did not previously address at all. |
| 1.2 | 2026-08-26 | Minor (additive) | §5.4: the strip list gains `relations.supersedes`/`superseded_by`, and gains two MUST-neutralize rules for `pinned` and `commitment: locked` — both were performed by the reference and stated nowhere, and both change whose judgement governs the recipient's store rather than merely tidying. §5.5.1 added: the pack integrity value and the installed-content hash answer different questions and MUST NOT be conflated; the reference's current conflation is recorded as a known divergence. §9: the single `provenance.jsonld` sidecar corrected to the `provenance/` directory the profile specifies — §9 governs where the two overlap, so an implementer reading it alone was being told to build the wrong thing. No field removed, no constraint tightened on existing data, no default changed. |
| 1.1 | 2026-08-25 | Minor (additive) | §4.8: added the OPTIONAL `attribution` and `claim_class` engram fields, marked PROPOSED. §4.12: added `injection_count` and `measured_under`; renamed `reference_count` → `write_count` (consumers MUST backfill on first parse). §3.3: canonical id form gains full ISO-8601 date separators, with the compact form retained as permanently valid legacy (§3.3.1) and the dateless pack form documented (§3.3.2). §5.1/§5.2: an OPTIONAL `provenance/` directory and a `metadata.provenance` declaration. §9: recorded that a companion profile now elaborates it. §4.12 `commitment` gains the `draft` member. No field removed, no constraint tightened, no default changed. |
| 1.0 | 2026-06-14 | — | Initial working draft. |

**Companion profiles** version independently of this document, and their version
is stated in their own header. A profile moving to a new version does not change
this document's version, and vice versa.

| Profile | Profiles | Version |
|---|---|---|
| [Recording where an engram came from](./ENGRAM-PROVENANCE-PROFILE.md) | §9 | 0.5 (draft) |

---

## 11. Meta-engram extension (informative)

A `META-` engram is a cross-domain structural pattern induced from ≥2 concrete
engrams (`meta-engram.ts`). It carries an extra `meta` block:
`structure` (a goal/constraint/outcome template with a `structure_type`),
`evidence[]` (≥2 supporting engrams with alignment scores), `domain_coverage`,
`falsification` (Popperian test predictions), `confidence` (composite of
evidence/domain/depth/validation), and `hierarchy` (`mop`/`top` level with
parent/children). This is an *informative* extension in v1; it reuses the §3
grammar (`META-` prefix) and the §4 open-world rule. It is documented here so an
implementer recognizes `META-` IDs and preserves the `meta` block, but full
normative specification of meta-engrams is deferred (a fundable remainder item).

---

## Appendix A — Normative references

- [RFC 2119] Key words for use in RFCs. https://www.rfc-editor.org/rfc/rfc2119
- [RFC 8174] Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words.
- [RFC 3339] Date and Time on the Internet: Timestamps.
- [RFC 8032] Edwards-Curve Digital Signature Algorithm (EdDSA / Ed25519).
- [RFC 8785] JSON Canonicalization Scheme (JCS) — candidate for §7 canonicalization.
- [JSON Schema Draft 2020-12] https://json-schema.org/draft/2020-12/schema
- [W3C PROV-O] The PROV Ontology. https://www.w3.org/TR/prov-o/
- YAML 1.2 specification. https://yaml.org/spec/1.2.2/

## Appendix B — Maturity index

| Section | Topic | Maturity |
|---|---|---|
| §1 | Scope | STABLE |
| §2 | Serialization | STABLE |
| §3 | ID grammar | STABLE |
| §4 | Engram object | STABLE (exchange block PROPOSED; provenance.signature RESERVED) |
| §5 | Pack format, integrity & lifecycle | STABLE for §5.1–§5.5 (`provenance/` and `metadata.provenance` OPTIONAL); **SPECIFIED** for §5.6–§5.8, with the reference's gaps listed in §5.9 |
| §6 | `.plur` capsule | STABLE (FormatVersion 0x0001; flag bits 2–15 RESERVED) |
| §7 | Signing (Ed25519) | RESERVED |
| §8 | Integrity (SHA-256) | STABLE |
| §9 | PROV-O + Swarm binding | PROPOSED — the PROV-O half is elaborated in the [provenance profile](./ENGRAM-PROVENANCE-PROFILE.md) and implemented in the reference; the Swarm anchor half remains a sketch |
| §10 | Versioning policy | STABLE |
| §11 | Meta-engram extension | Informative |

**Companion profiles**

| Profile | Profiles | Maturity |
|---|---|---|
| [Recording where an engram came from](./ENGRAM-PROVENANCE-PROFILE.md) | §9 | PROPOSED — implemented in the reference; see its Appendix C for per-section status |
