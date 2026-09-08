# PLUR format and compatibility

Use this reference when serializing or validating records. The bundled spectrum was checked against repository snapshot `1557e14f9953ec97c41ef484723b1a15422b42a8`, dated in the teaching catalog as 7 September 2026. It is a compatibility baseline, not a claim about current main or an installed deployment. Note that `1557e14f` predates the 2026-09-07 fixes recorded under [delivery checks](#delivery-checks); a deployment built from it still has those four defects.

Prefer the target deployment's installed schema and renderer. If they are unavailable, use the pinned baseline below and identify the compatibility target in the handoff. Do not repeatedly fetch documentation when the relevant schema is already available locally.

Contents: [authoritative references](#authoritative-references), [core fields](#core-fields), [evidence and history](#evidence-and-history), [abstractions and meta-engrams](#abstractions-and-meta-engrams), [delivery checks](#delivery-checks).

## Authoritative references

- [Open Engram Standard v1 working draft](https://github.com/plur-ai/plur/blob/1557e14f9953ec97c41ef484723b1a15422b42a8/spec/ENGRAM-STANDARD-v1.md): normative store, identity, and record conventions; section 11 describes the informative meta extension.
- [Engram JSON Schema](https://github.com/plur-ai/plur/blob/1557e14f9953ec97c41ef484723b1a15422b42a8/spec/engram.schema.json): serializable base shape and constraints.
- [Runtime engram schema](https://github.com/plur-ai/plur/blob/1557e14f9953ec97c41ef484723b1a15422b42a8/packages/core/src/schemas/engram.ts): defaults, refinements, and runtime field meanings.
- [Runtime meta-engram schema](https://github.com/plur-ai/plur/blob/1557e14f9953ec97c41ef484723b1a15422b42a8/packages/core/src/schemas/meta-engram.ts): complete `meta` block.
- [Runtime injection](https://github.com/plur-ai/plur/blob/1557e14f9953ec97c41ef484723b1a15422b42a8/packages/core/src/inject.ts) and [feedback](https://github.com/plur-ai/plur/blob/1557e14f9953ec97c41ef484723b1a15422b42a8/packages/core/src/feedback.ts): baseline implementation details, which may differ from a deployment being updated.

The [public overview](https://plur.ai/spec.html) is useful orientation. Resolve schema/version questions against the versioned standard and target implementation rather than mixing overview labels with the record's numeric version.

## Core fields

Use a YAML mapping whose top-level `engrams` value is a sequence of records.

| Field | Baseline requirement or meaning |
| --- | --- |
| `id` | Required unique string. Mint `ENG-YYYY-MM-DD-NNN`, or the corresponding `ABS-`/`META-` form, using an appropriate actual creation date and collision-free suffix. Preserve valid existing IDs; legacy compact-date IDs need not be rewritten. |
| `version` | Integer shape generation; currently `2` in the referenced baseline. Do not serialize `2.1`. |
| `engram_version` | Separate integer tracking content evolution. Do not invent previous runtime event IDs to populate version history. |
| `status` | Required: `active`, `dormant`, `retired`, or `candidate`. The baseline documents active/retired assignment and reserved/legacy candidate/dormant states; verify supported lifecycle behavior. |
| `type` | Required: `behavioral`, `terminological`, `procedural`, or `architectural`. |
| `scope` | Required string, such as `global` or `project:luma`. A namespace value alone is not an access-control guarantee. |
| `statement` | Required nonempty string; the useful assertion. Advisory word counts are not a schema maximum. |
| `summary` | Optional string, at most 80 characters in this baseline. Preserve critical qualifiers if this is the only injected text. |
| `pinned` | Always-load within eligible scope. The set has a quota (`injection_budget × injection.pinned_ratio`) enforced when pinning: an over-quota pin is refused with usage and unpin candidates, rather than silently dropped at injection time. |
| `visibility` | `private`, `public`, or `template`; private is the baseline default. A generic-looking statement is not sufficient reason to make private knowledge public. |
| `rationale`, `contraindications` | Optional explanation and exception list. Their presence does not prove they reach the model. |
| `knowledge_type` | When present, provide both `memory_class` and `cognitive_level`. |
| `commitment` | Optional decision state: `exploring`, `leaning`, `decided`, `locked`, or `draft`. Not epistemic confidence. `draft` IS enforced in core as of #1141 — stored and recalled, never injected. |
| `created_at`, `updated_at` | Optional RFC 3339 provenance timestamps. Never defaulted — absent means genuinely unknown, and synthesising one destroys the provenance it records. `updated_at` tracks content/lifecycle change only, never reads or feedback. |
| `structured_data` | Optional arbitrary metadata. Namespace author extensions and explain who interprets them. |

Choose the native type by the content: behavioral for preferences and behavior, terminological for entity/term meanings and simple context facts, procedural for how to perform work, architectural for system structure, purpose, or design decisions. These are practical mappings, not a mandate to turn every fact into a definition or every hypothesis into an architectural record.

`memory_class` values: `semantic`, `episodic`, `procedural`, `metacognitive`.

`cognitive_level` values: `remember`, `understand`, `apply`, `analyze`, `evaluate`, `create`.

These axes are independent of scope, pinning, and decision commitment. For example, the catalog's episode is `type: behavioral` with `memory_class: episodic`; its meta-engram is `type: procedural` with `memory_class: metacognitive`.

## Evidence and history

Populate only supported, relevant fields:

- Use `source`, `provenance`, and `knowledge_anchors` for real origin and evidence. An anchor requires `path`; optional `snippet` is limited to 200 characters in the baseline. Test a link's actual resolution when the consumer depends on it. Use actual immutable versions where needed for reproducibility.
- If a `provenance` object is present, supply its required `origin`; do not manufacture signatures or imply a source was independently verified. Do not silently assign a permissive license to material without that right.
- A `temporal` object requires `learned_at`; `valid_from`, `valid_until`, and `ingested_at` are additional time concepts. Preserve event time separately where needed. Retrieval time is not verification time. Do not infer verification from `activation.last_accessed` or feedback.
- For an inclusive deadline such as “through 14 September 2026,” check how the consumer interprets a date-only `valid_until`; a midnight interpretation can expire the memory before the intended final day. Use the intended end instant and a known timezone when supported. If timing is unresolved, preserve the completion/date condition in the statement and identify the unresolved cutoff rather than inventing a precise timestamp.
- Use `measured_under` for the model, software, hardware, dataset, date, or other material conditions actually known. Preserve units and the measured statistic in the claim or relevant structured data. Unknown conditions stay unknown. Differing-condition measurements may coexist.
- Use `relations.supersedes` and `superseded_by` for decision replacement; `broader`, `narrower`, `related`, and `conflicts` express other relationships. Check IDs and intended direction. Use `derived_from` for a single parent where appropriate.
- Treat `derivation_count`, `write_count`, `recurrence_count`, retrieval frequency, usage, and feedback as distinct fields with distinct meanings. Do not set them to make a new memory appear established. Omit runtime-maintained values or use documented fresh values; preserve existing counters on edits unless the operation legitimately changes them.
- Optional confidence is not a calibrated probability. The baseline episodic confidence scale is 1–10; omit unsupported scores. A frequent recall or a positive signal does not verify a fact.
- Use `episode_ids` and `previous_version_ref` only for existing records/events. A sentence describing an episode does not supply an actual episode-store identifier.
- The baseline `insight` block describes a particular synthesis pipeline, not every hand-authored inference. Do not fill it merely because an engram is insightful. If used through that pipeline, respect its refinements, including verified grounding for promoted fate.

Author review notes can live outside the record, or under a clearly named extension such as `structured_data.authoring`. The catalog's `structured_data.example` intentionally includes teaching sources and checks. Those fields do not establish native acceptance, review, pinning, or expiry behavior.

## Abstractions and meta-engrams

Use `abstract` on a concrete engram to point to its `ABS-` generalization when justified. Link supporting records so the abstraction can be reassessed when evidence changes. Preserve candidate status or equivalent uncertainty when the broader principle remains unvalidated.

For `META-`, consult the exact runtime schema before writing the extension. In the baseline, the `meta` block includes:

| Block | Required substance |
| --- | --- |
| `structure` | Goal, constraint, outcome, template, and the relevant structural frame. |
| `evidence` | At least two concrete engram mappings, with domain, mapping rationale, and alignment assessment. |
| `domain_coverage` | Keep validated, failed, and predicted domains distinguishable. |
| `falsification` | Expected conditions and exceptions; supply a discriminating prediction when possible. |
| `confidence` | Evidence count, domain count, structural depth, validation ratio, and composite as specified by the actual implementation. |
| `hierarchy` | Supported level and parent/child relationships. |
| `pipeline_version` | Actual pipeline/version or an explicitly identified authored example, not a fictitious production run. |

The base JSON schema is open to extensions; parsing a `meta` field through it does not validate all runtime META requirements. Schema-required numerical fields are not a license to fabricate measured confidence. If an assessment is unavailable, preserve a staged proposal with the missing assessment identified instead of claiming a complete validated meta-engram. A teaching fixture can identify illustrative author judgments explicitly, as example 17 does.

## Delivery checks

These were open questions when this reference was pinned. Four were confirmed as defects on 2026-09-07 and fixed; the state below is what the runtime does now. Re-verify against the deployment you are targeting, which may be older.

| Contract | State |
| --- | --- |
| Does a review state prevent unapproved guidance reaching an agent? | **Yes.** `commitment: draft` is never injected (plur-ai/plur#1141). Recall still returns it, so review is possible. Feedback cannot advance commitment. |
| Does the rendered form preserve critical conditions? | **Partly.** `contraindications` render at layers 2 and 3 (#1140). Layer 1 still emits `summary` alone, so a qualified rule must not be summarised as unconditional. |
| Can the pinned set fit its budget, and are omissions reported? | **Yes, and it is now prevented.** The budget is a quota enforced at pin time: an over-quota `plur_pin` is refused with usage and unpin candidates (#1142). `omitted_pinned` reports any injection-time shortfall for stores that went over before this landed. |
| Are freshness labels based on evidence rather than retrieval? | **Yes.** The field renders as `Last active`, not `Last verified` (#1139) — it is `activation.last_accessed`, which feedback re-anchors. Verification still needs its own evidence. |

One contract remains open: **constraints render at layer 2 and therefore without `rationale`** (#1144). `rationale` is indexed for retrieval but not shown to the model for a prohibition. Keep a mechanism the model must weigh in the `statement` of a constraint.

Keep authoring quality, delivery correctness, and observed model benefit separate when reporting results. Do not recast an implementation failure as a stronger memory instruction.
