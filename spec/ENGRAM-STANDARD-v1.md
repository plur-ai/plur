# The Open Engram Standard

**Version:** 1.0 (draft)
**Status:** Working Draft
**Date:** 2026-06-14
**Editors:** PLUR.ai (plur-ai)
**License:** This specification is licensed under CC-BY-4.0. Reference code is Apache-2.0.

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

The maturity label of a whole section applies to everything in it unless an
inner item is labelled otherwise.

---

## 1. Scope and intent — STABLE

### 1.1 What this standard covers

1. **The Engram object** (§4) — the field set, types, value ranges, and
   invariants of a single unit of knowledge.
2. **The ID grammar** (§3) — how engram identifiers are formed and what their
   prefixes mean.
3. **The Pack format** (§5) — the on-disk directory layout (`SKILL.md` +
   `engrams.yaml` + `INTEGRITY`) and the manifest fields.
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
  - id: ENG-2026-0506-001
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
form for a freshly minted concrete engram is date-sequenced:

```
ENG-YYYY-MMDD-NNN
```

- `YYYY` four-digit year, `MMDD` month+day, `NNN` a zero-padded per-day
  sequence number starting at `001`.
- Example: `ENG-2026-0506-003`.

### 3.4 Store-namespaced form

When engrams from multiple stores are merged, an implementation MAY namespace an
ID with a short store **PREFIX** to avoid collisions:

```
ENG-{PREFIX}-YYYY-MMDD-NNN        e.g.  ENG-DF-2026-0401-001
```

`PREFIX` is a SHORT uppercase token derived from the source scope. The
namespaced form still matches the grammar in §3.1. Implementations MUST treat
the namespaced and bare forms as referring to *different* logical engrams once
namespacing has been applied (the prefix is part of the identity in a merged
view). Pack producers SHOULD export *bare* IDs.

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
| `pack` | string \| null | | default `null` | Owning pack name, or null. |
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
| `commitment` | string | `exploring` \| `leaning` \| `decided` \| `locked` | Epistemic commitment level. |
| `locked_at` | string | | When commitment became `locked`. |
| `locked_reason` | string | | Why locked. |
| `reference_count` | integer | ≥0, default 1 | Same-scope re-learn count. Engram retires only at 0. |
| `sources` | object[] | each: `scope` (R), `session_id?` (string\|null), `stored_at` (R, instant) | One entry per write attempt. |
| `recurrence_count` | integer | ≥0, default 0 | Different-scope re-learn count (universality evidence). |
| `engram_version` | integer | ≥1, default 1 | Content-evolution version. |
| `previous_version_ref` | object | `{event_id, changed_at}` | Pointer to prior content version. |
| `episode_ids` | string[] | default `[]` | Source episode IDs. |
| `summary` | string | ≤80 chars | Injection-friendly short form. |
| `pinned` | boolean | | Always-load flag; bypasses keyword gating. Use sparingly. |

### 4.13 Required-field summary

A minimally conformant engram is exactly:

```yaml
id: ENG-2026-0506-001         # §3 grammar
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
└── INTEGRITY         (pack content hash; see §5.5)
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
`associations`, local `knowledge_anchors`, and SHOULD reset `activation`
(fresh `retrieval_strength`, `frequency: 0`) and `feedback_signals` to zero so
the recipient builds their own usage history. (This mirrors the reference
`exportPack`.)

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

A pack MAY carry a sidecar `provenance.jsonld` (PROV-O in JSON-LD) inside the
capsule payload, or reference an external PROV document by URI.

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
| §5 | Pack format & integrity | STABLE |
| §6 | `.plur` capsule | STABLE (FormatVersion 0x0001; flag bits 2–15 RESERVED) |
| §7 | Signing (Ed25519) | RESERVED |
| §8 | Integrity (SHA-256) | STABLE |
| §9 | PROV-O + Swarm binding | PROPOSED |
| §10 | Versioning policy | STABLE |
| §11 | Meta-engram extension | Informative |
