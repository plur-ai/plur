# Open Engram Standard — `spec/`

This directory is the **language-agnostic standard** for engrams, packs, and the
`.plur` capsule. It is extracted from the implicit format that lives in the
`@plur-ai/core` Zod schemas, so that a third party can implement a conformant
producer/consumer in any language without reading the TypeScript.

> **Why this exists.** The format was previously *implicit* — encoded only in
> runtime Zod validators. This directory makes it an *explicit, citable
> standard*: "here is a spec a third party can implement." That is the
> credibility anchor for an NGI/NLnet grant and the basis for an interoperability
> ecosystem.

## Files

| File | What it is |
|---|---|
| `ENGRAM-STANDARD-v1.md` | The **normative spec** — prose, byte layouts, grammars, invariants, maturity labels. |
| `engram.schema.json` | Canonical **JSON Schema (Draft 2020-12)** for the engram object. |
| `pack-manifest.schema.json` | Canonical **JSON Schema (Draft 2020-12)** for the pack manifest. |
| `README.md` | This file. |

## What is normative vs proposed

Every section of the spec carries a maturity label. In short:

- **STABLE** — implemented in the reference, frozen for v1, MUST be followed to
  conform. Covers: the engram object (§4), the ID grammar (§3), serialization
  (§2), the pack format and SHA-256 pack integrity (§5), the `.plur` capsule
  byte layout / format version `0x0001` / flag bits 0–1 / read+write algorithms
  / SHA-256 payload integrity (§6, §8), and the versioning policy (§10).
- **RESERVED** — wire space is allocated and MUST be preserved, but behavior is
  not yet specified. Covers: the **Ed25519 signing model** (§7) — the `SIGNED`
  flag, the 64-byte signature trailer, `header.signer`, and
  `provenance.signature`. A v1 implementation round-trips these but MUST NOT
  derive trust from them. Capsule flag bits 2–15 are also RESERVED.
- **PROPOSED** — planned profiles, non-normative for v1, documented so the design
  space (and the fundable remainder) is explicit. Covers: the engram `exchange`
  metadata block (§4.11) and the **PROV-O + Swarm provenance binding** (§9).
- **Informative** — the meta-engram (`META-`) extension (§11).

The maturity index is Appendix B of the spec.

## How the JSON Schemas relate to the Zod source

The schemas were **hand-authored** to faithfully mirror the Zod definitions in:

- `packages/core/src/schemas/engram.ts` → `engram.schema.json`
- `packages/core/src/schemas/pack.ts` → `pack-manifest.schema.json`

**Why hand-authored, not generated:** `zod-to-json-schema` is not a dependency of
this repo, and adding it (or building the package) would modify source/lockfiles
— out of scope for a docs-only change. Each field, type, enum, range, default,
and the `dual_coding` "at least one of example/analogy" refinement was
transcribed directly from the Zod source.

**Divergence risk (read this).** Because the JSON Schema is not auto-generated,
it can drift if the Zod schema changes and the JSON Schema is not updated. To
keep them in lockstep:

1. Treat `packages/core/src/schemas/engram.ts` and `…/pack.ts` as the source of
   truth; when they change, update the JSON Schema in the same PR.
2. The proper fix is a **generation step** (the first fundable-remainder item
   below): add `zod-to-json-schema`, emit these files in CI, and fail the build
   if the committed schema differs from the generated one. That converts
   "divergence risk" into "compile error."

Intentional, documented differences from a naive Zod→JSON translation:

- `additionalProperties: true` on the engram object and manifest — encodes the
  Zod `.passthrough()` open-world rule (unknown fields preserved).
- `activation.last_accessed` default is shown as `""`; the reference computes
  *today's date* at object-construction time, which a static schema cannot
  express. Consumers materialize the runtime default per §2.3 of the spec.
- `polarity` is `["string","null"]` with `enum: ["do","dont",null]` to model
  Zod's nullable enum.

## Verifying the schemas

The JSON Schema files are plain JSON and validate any engram/manifest after YAML
is parsed to JSON. Example (any Draft 2020-12 validator):

```bash
# pseudo — pick your validator (ajv, jsonschema, check-jsonschema, …)
ajv validate -s spec/engram.schema.json -d my-engram.json --spec=draft2020
```

## The fundable remainder — what makes this a *real* standard

v1 is a credible, implementable draft. Turning it into a ratified, interoperable
standard is the NGI/NLnet-fundable scope:

1. **Schema generation + drift CI.** Add `zod-to-json-schema`, generate
   `engram.schema.json` / `pack-manifest.schema.json` from the Zod source in CI,
   and gate the build on equality. Eliminates the divergence risk above.
   *(small, do first)*

2. **Conformance test vectors.** A language-neutral corpus of canonical inputs +
   expected outcomes: valid/invalid engrams (one per invariant in §4.14), golden
   packs with known `INTEGRITY` hashes, and **golden `.plur` capsules** (hex
   fixtures) covering magic/version/flags/header/payload/sha-256 — including
   negative cases (bad magic, reserved-flag-set, size-mismatch, sha-mismatch,
   truncated). This is what lets an independent implementation prove conformance.

3. **Ed25519 signing — finalize and implement (§7 → STABLE).** Decide and fix:
   (a) the exact capsule signed message (candidate: `preamble || header ||
   payload`), (b) engram canonicalization for `provenance.signature` (candidate:
   RFC 8785 JCS over a defined, state-excluding field subset), (c) key
   distribution / `key_id` resolution / revocation. Ship a verifying reader.

4. **PROV-O + Swarm provenance binding (§9 → STABLE).** Fix the `anchor` field
   shape, the PROV-O/JSON-LD sidecar, the canonical bytes the Swarm reference
   commits to, and a verifier that resolves anchor → bytes → §8 hash → recorded
   integrity. Delivers tamper-evident, producer-independent provenance.

5. **Interop SDK + second implementation.** A reference reader/writer in at least
   one non-TypeScript language (e.g. Python or Rust) that passes the conformance
   vectors. A standard with two interoperating implementations is a standard;
   one is a format.

6. **Meta-engram normative spec (§11 → normative).** Promote the `META-`
   extension from informative to a specified profile (structure templates,
   evidence/falsification/confidence semantics, hierarchy).

7. **Formal publication.** Stable URLs for the `$id`s
   (`https://plur.ai/spec/v1/…`), a versioned changelog, and an editor's draft
   process (so STABLE/RESERVED/PROPOSED transitions are tracked publicly).

Items 1–2 are cheap and unlock everything else (you cannot claim conformance
without vectors). Items 3–4 are the substantive trust-and-provenance work that an
NGI/NLnet "data sovereignty / trustworthy AI memory" grant most naturally funds.
Items 5–7 graduate it from draft to ratified standard.
