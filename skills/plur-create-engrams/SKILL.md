---
name: plur-create-engrams
version: 0.19.4
description: Create or improve PLUR engrams from conversations, documents, decisions, observations, and explicit preferences. Use for memory extraction, engram authoring, or reviewing proposed memories, including global, scoped, pinned, retrieved, and provisional knowledge. Ordinary use of existing memories does not require this skill.
---

# Create PLUR Engrams

An engram earns its place by changing a future answer, action, or interpretation. Two failures cost more than a missing memory: one that is **too long to be read**, and one that is **never retrieved when it applies**. Most of this skill is about those two.

Read [PLUR format and compatibility](references/plur-format.md) before serializing. Use [the spectrum catalog](references/plur-engram-spectrum.yaml) and [examples explained](references/examples-explained.md) for worked records; load only the ones you need.

## The four fields do different jobs

Getting this wrong is the main cause of bloat. Each field has one job:

| Field | Job | Test |
| --- | --- | --- |
| `statement` | The assertion. What to do or what is true. | Could someone act on this alone? |
| `rationale` | The **mechanism** that makes it true — and therefore when it stops being true. | Does it name a condition that could fail? |
| `source` | Where it came from: incident, date, speaker, document. | Is this a citation rather than a reason? |
| `tags` / `domain` | Where it should surface. | See *Findability* below. |

`rationale` is not "more explanation". "Because the user said so on 12 March" is a citation and belongs in `source`. A real rationale is falsifiable: if its mechanism stopped holding, the rule should be retired.

**Worked example.** A real engram, 1,454 characters:

> A TRUNCATED memory injection means you do not have your memory — stop and read it in full before doing anything else. When plur_session_start returns more than the harness tool-result limit, the payload is spilled to a file and you receive only a pointer… Proven 2026-09-07: session_start returned 115,052 chars, ~5,000 were read (4%), and four engrams forbidding what happened next were in the unread 96% — ENG-…, ENG-…. A customer name was then narrated to a live audience. Nothing malfunctioned… Rule: on any spilled injection, slice the whole file in ~80,000-char spans…

Eleven claims in one record. The instruction appears in sentence 1 and again at character 1,180; everything between is justification written to pre-empt disagreement. Rewritten, 198 characters:

```yaml
statement: >-
  When an injection is spilled to a file, read the whole file before acting —
  you do not have your memory yet. Head-and-tail reading skips the middle,
  where the rules about what you must not say live.
rationale: >-
  A pointer to a spilled payload reads exactly like a result you already have,
  so this fails silently.
source: >-
  2026-09-07 — 115,052-char session_start, 4% read; four redaction engrams sat
  in the unread 96%.
tags: [injection, truncation, redaction, session-start]
```

Nothing was lost. Each part moved to the field whose job it is. The long version was also **worse for retrieval** — its embedding is the centroid of five topics, so it ranked mediocre for all of them, and its term density was diluted fourfold.

Length is a symptom, not the rule. Aim for 100–300 characters of `statement`; past ~600 you are almost certainly carrying another field's content. Exceed it when a dependent procedure genuinely needs the steps together.

## Findability: write the situation, not the subject

An engram that never surfaces is worth nothing, and relevance is not automatic. Three things decide whether yours floats up.

**1. Discriminating words.** BM25 ranks by term *rarity*. In a store about one product, that product's vocabulary is worthless: measured on a real 110-engram injection, the query terms "plur", "enterprise", "session" and "engrams" appeared in 62%, 31%, 27% and 24% of the corpus. Terms that common cannot rank anything, so retrieval degenerates toward whichever documents are longest and most keyword-dense.

Write the words a future *task* will contain, not the words your topic belongs to. A rule about demos must contain *demo, screen-share, recording, audience, presentation* — those are its handles.

**2. One topic per record.** An embedding is a centroid. Two claims in one engram produce a vector between them that matches neither well. Splitting raises the score of both.

**3. A behavioural rule usually cannot be retrieved at all — pin it.** This is the hard limit, and it is measured, not theoretical. Twelve rewritten rules were probed with the situation each one governs, phrased as a real task would phrase it. **R@1 was 2/12 and R@5 was 3/12.**

The failure is structural. For *"publish the new version to npm"*, the top five results were all about npm publishing mechanics — they repeat "npm" and "publish", while a governance rule about sign-off does not. The words that describe a situation are the words that describe its topic, and the topic always has more documents. A rule competes against facts and loses.

Situation-words help only when the situation is lexically distinctive: *"ssh into the client VPS"* ranked #1, *"investor deck, can we mention the pilots"* ranked #5. Generic situations — *"ready to ship"*, *"finished that part"* — ranked nowhere at all.

So: write the situation words anyway, because they are what buys you the distinctive cases. But **do not rely on retrieval for a rule you need obeyed unprompted.** That is what `pinned` is for, and it is the only mechanism that works for this class. A behavioural rule left unpinned is a rule that fires on the rare task whose wording happens to be unusual.

`rationale` and `tags` are indexed as well as `statement`, so a concrete mechanism sentence adds retrieval surface at no cost to the statement's length. **Caveat:** for constraints, `rationale` is indexed but *not rendered* to the model (see *What the model actually receives*). It helps findability, not comprehension.

## Identify the knowledge worth keeping

Extract one coherent unit that can be retrieved, revised, and retired independently. It may be a fact, preference, value, definition, decision, procedure, episode, measurement, hypothesis, lesson, or unfinished intention. Keep a procedure together when its steps depend on each other; split unrelated triggers and independently changing claims.

Ask what a future agent would do differently. Retain user-selected defaults, local meanings, and decision premises even when simple. Do not require novelty or a surprising lesson. Omit generic advice; link substantial source material rather than compressing a manual into one record.

Use the supplied evidence. Identify speaker or document, context, date when material, and whether the content is a preference, observation, decision, or inference. A statement about what a source says is not confirmation of its claim. Repeated copies of one source are not independent support.

Do not invent source events, acceptance, verification, benchmark results, confidence scores, usage, signatures, or timestamps. When evidence is incomplete, narrow the claim, keep it as a labelled hypothesis, or stage the record with the gap identified. Do not stall the useful part over an omittable field.

Choose a form that matches the knowledge:

| Knowledge | Form |
| --- | --- |
| Behavioural rule | When X, do Y, because Z, unless W. |
| Preference | Prefer X in context Y; keep the exception. |
| Fact or definition | X is Y within scope S, as of T if time matters. |
| Decision | Chose X because Z; reopen when C changes. |
| Episode | In context C, actor A did B, outcome O. Keep inferred motive separate. |
| Measurement | R measured V under conditions M; preserve the comparison's limits. |
| Hypothesis | Evidence E suggests H; uncertainty U; check T could distinguish. |
| Procedure | At trigger C, follow the sequence; link the detailed source. |

Avoid vague pronouns, "always obey", and urgency manufactured to imply authority. Never phrase a remedy as a disjunction whose second branch is cheaper — the cheap branch gets taken and the rule becomes a licence.

## Before you write: check, and write once

Inspect the existing bank first. `plur_learn` returns `dedup.near_duplicates` including **the neighbour's own statement** — read it before moving on; that is what it is for. High similarity is a reason to look, not a verdict: cosine cannot distinguish a duplicate from a correction of one, and nothing is suppressed on similarity alone.

Reuse the identity for an update to the same knowledge. Merge equivalent content without pretending its sources were independent. Keep separate records when they can change independently.

**Draft the assertion before you call the tool.** Superseding an engram you wrote minutes ago is a redraft, not a correction — it leaves a chain of near-identical records, and no similarity check catches it because each link genuinely differs. `plur_learn` flags this as `redraft`. If the earlier one was simply wrong, retire it rather than stacking another supersede.

For changes, compare the same entity, scope, version and measurement conditions before declaring a contradiction. Link superseded records in both directions, keep useful history, retire the old operational rule. Differing measurement conditions can justify parallel records. Give temporary priorities an expiry or completion trigger; do not invent expiry dates for stable knowledge.

## Scope, pinning, and state are independent

Choose the broadest scope the source justifies. A standing preference can be global immediately; a project incident does not become global because its wording sounds general. Set `domain` on every record — it is the primary routing signal, and a record without one falls to `global` regardless of content.

**Pinning is for rules you must obey unprompted.** A fact you need sometimes should be recalled, not pinned. In a real store audited on 2026-09-07, 12 of 46 pinned engrams were facts or history — positioning theses, incident write-ups, architecture notes — none of them things to obey.

The pinned set has a **quota** (`injection_budget × injection.pinned_ratio`). "Always-load" only means something if the set fits, so `plur_pin` **refuses** a pin that would exceed it and returns current usage plus unpin candidates. Expect refusal; resolve it by unpinning or raising the limit, and put that choice to the user rather than picking one. Candidates are ordered by what they free, which is arithmetic — not by importance, which nothing can rank for you.

Keep epistemic standing, decision commitment and lifecycle separate. An observed event is not its explanation; an approved experiment is not a proven hypothesis.

`commitment: draft` means the engram is in a review queue: core stores and recalls it but **never injects it**, so an unapproved rule cannot shape behaviour. Recall stays open because reviewing requires reading. Feedback does not advance commitment — relevance is not approval.

Use `ABS-` for a justified generalisation and `META-` for a cross-domain pattern with explicit mappings from at least two concrete engrams. Broader wording, frequent retrieval and high alignment scores do not prove broader validity.

## What the model actually receives

Delivery is not uniform, and authoring against the wrong layer wastes the work.

| Section | Layer | Rendered |
| --- | --- | --- |
| `CONSTRAINTS` (prohibitions, `apply`/`analyze`) | 2 | statement + contraindications |
| `DIRECTIVES` (everything else) | 3 | statement + contraindications + rationale + domain/commitment/confidence |
| `ALSO CONSIDER` (low-relevance tail) | 1 | `summary` alone, ~80 chars |

Consequences worth designing around:

- **A constraint's `rationale` is indexed but never shown** (plur-ai/plur#1144). For a prohibition, any mechanism the model must weigh belongs in the `statement`.
- **A `summary` may be the only text delivered.** If a rule is qualified, its `summary` must not read as unconditional.
- Never hide a load-bearing exception exclusively in metadata.
- Constraints are emitted first and are the last section dropped under budget pressure — a prohibition is not shed to fit.

Verify against the deployment when reliable use depends on it, and report a structural check as structural validation, not as proof a model will comply.

## Specify without manufacturing evidence

Use native fields from [PLUR format and compatibility](references/plur-format.md). Fully specify what is relevant; do not populate every optional field or attach impressive-looking counters. The spectrum catalog fills nearly every field because it is a teaching fixture — **do not read it as a target shape.** Most good engrams use a handful of fields.

Choose cognitive labels to describe the knowledge honestly, not to obtain a stronger injection layer. Cite resolvable evidence with its real origin and sharing posture. For fictional examples keep the example markers in both `statement` and `summary`, mark synthetic sources, and leave usage at zero. Never import fixtures as facts about the user.

`created_at` and `updated_at` carry provenance. Both are optional and never defaulted: absent means genuinely unknown, and synthesising one destroys the provenance it records.

## Review and deliver

For each proposed memory, name one task where it should fire and one plausible near-match where it should not. Check that it contributes information or a decision criterion, stays inside its evidence, and survives its rendered layer. A simple fact does not need a manufactured test suite.

Deliver readable statements plus the requested records, with assumptions and unresolved evidence identified. Prefer the smallest useful set; explain significant merges or scope decisions. Apply store changes when the request or workflow authorises it — creating illustrative examples does not authorise installing them as live memories — and do not add an approval step where the action is already authorised.
