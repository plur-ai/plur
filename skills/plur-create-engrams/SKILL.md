---
name: plur-create-engrams
version: 0.23.1
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

## The structured form: statement plus body

The statement is the one line an agent acts on. Most memories worth keeping also deserve a **structured body**, written into `structured_data.body`, that carries what the line cannot: the situation it is for, the steps, the reason, the trap. The body is indexed for recall, so it is where the situation words go. In a 2026-11-09 test, replacing one-liners with structured items lifted top-10 recall from 55% to 62%.

```text
When: <2–3 concrete situations, in the words a future task will contain>
Asks: <three short requests a user would actually type when this applies>
Do: <the action, or what is true>
Why: <the mechanism — and so when it stops holding>
Pitfalls: <the near-miss, what goes wrong if you skip it>
Anchors: <files, commands, endpoints, ids, names a query will mention>
```

What makes a body findable was measured on 2026-11-19: structured bodies were added to the 30 hardest-to-find memories of a 14,000-memory store and to all 5,067 memories competing with them, then each line was scored with PLUR's own hybrid search.

- **`Asks` is the strongest single line.** Three ordinary requests, phrased as tasks, that do not name the rule ("set up the release for Thursday", not "apply the sign-off rule"). On its own it beat every fuller body: 20 targets ranked better, 4 worse. Add it to every memory that should fire on a task.
- **`When` names situations, not the rule again.** List 2–3 concrete cases. A lesson about evaluating beyond one asset pair went from rank 1,568 to rank 1 once its `When` said "backtesting a trading strategy".
- **No glossary line.** A list of spelled-out jargon made memories harder to find than no body at all. Put everyday words inside the `When` and `Asks` sentences instead.
- **Short beats long.** A longer body did no better. Aim for five or six lines.
- **Dated status notes get no body.** A heartbeat, a status update or an "as of" summary is a snapshot: say so in the statement, give it an expiry or completion trigger, and leave the body out so it does not compete with lasting knowledge.
- **At most ~300 tokens** (2,000 characters; longer is refused). Leave out a part that has nothing in it rather than padding it.
- **The statement must still stand alone.** Injection renders the statement, not the body; the body helps the memory be found.
- **`kind`** says what sort of memory it is: `rule` (a convention to follow), `tool` (a pointer to a command, script, endpoint or file), `fact` (how something is), `preference` (a taste or style choice), `experience` (what happened in a past attempt), `failure_lesson` (what went wrong and what to avoid). It sets `memory_class` when you give none: experiences and failure lessons are episodic, rules and tools procedural, facts and preferences semantic.
- **`outcome`**: `success` or `failure`, or a short stated result ("p95 fell to 2 s"). Only when the source says so. Never guess one.
- **Distil failure lessons.** When something went wrong, record the lesson, not the transcript: the trigger, the wrong move, the right move, and how to tell next time. `kind: failure_lesson`, `outcome: failure`, the incident date in `source`. One lesson per engram.

```json
{
  "statement": "Read a spilled injection file in full before acting; head-and-tail reading skips the rules in the middle.",
  "domain": "plur.engineering.injection",
  "source": "2026-09-07 session: 4% of a 115,052-char injection was read",
  "structured_data": {
    "kind": "failure_lesson",
    "outcome": "failure",
    "body": "When: plur_session_start or a hook returns a pointer to a file instead of the memories; a session starts with a truncated tool result.\nAsks: start the session; load my memory for this repo; what do you remember about this project?\nDo: read the whole file in ~80,000-char slices before the first action.\nWhy: a pointer reads like a result you already have, so skipping it fails silently.\nPitfalls: reading only the head and tail; the redaction rules sat in the unread middle.\nAnchors: session_start, spilled payload, tool-result limit, truncated injection."
  }
}
```

`plur_learn` accepts `structured_data` with exactly `body`, `kind` and `outcome`; the CLI takes `--body`, `--kind`, `--outcome`. Any other key is refused. `plur enrich` labels existing memories with a kind after the fact, without touching their statements.

## Findability: write the situation, not the subject

An engram that never surfaces is worth nothing, and relevance is not automatic. Three things decide whether yours floats up.

**1. Discriminating words.** BM25 ranks by term *rarity*. In a store about one product, that product's vocabulary is worthless: measured on a real 110-engram injection, the query terms "plur", "enterprise", "session" and "engrams" appeared in 62%, 31%, 27% and 24% of the corpus. Terms that common cannot rank anything, so retrieval degenerates toward whichever documents are longest and most keyword-dense.

Write the words a future *task* will contain, not the words your topic belongs to. A rule about demos must contain *demo, screen-share, recording, audience, presentation* — those are its handles.

**2. One topic per record.** An embedding is a centroid. Two claims in one engram produce a vector between them that matches neither well. Splitting raises the score of both.

**3. A behavioural rule is hard to retrieve — give it a situation, not a pin.** This is the hard limit, and it is measured, not theoretical. Twelve rewritten rules were probed with the situation each one governs, phrased as a real task would phrase it. **R@1 was 2/12 and R@5 was 3/12.**

The failure is structural. For *"publish the new version to npm"*, the top five results were all about npm publishing mechanics — they repeat "npm" and "publish", while a governance rule about sign-off does not. The words that describe a situation are the words that describe its topic, and the topic always has more documents. A rule competes against facts and loses.

Situation-words help only when the situation is lexically distinctive: *"ssh into the client VPS"* ranked #1, *"investor deck, can we mention the pilots"* ranked #5. Generic situations — *"ready to ship"*, *"finished that part"* — ranked nowhere at all.

So: write the situation words — in the statement where they fit, and in the structured body's `When:`, `Asks:` and `Anchors:` lines where they do not. They are what buys you the distinctive cases. **Do not pin to compensate.** Pins are loaded into every session whatever the task, and a pinned set grown by agents crowds out the memories a task actually needs. If you believe a rule needs to be always loaded, say so to the owner and let them decide.

`rationale`, `tags` and the structured body are indexed as well as `statement`, so a concrete mechanism sentence adds retrieval surface at no cost to the statement's length. **Caveat:** for constraints, `rationale` is indexed but *not rendered* to the model (see *What the model actually receives*). It helps findability, not comprehension.

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

## MCP tool profiles

`plur_learn`, `plur_recall` and `plur_forget` are direct tools in the default lean profile. Less-common operations such as `plur_pin` are reached through `plur_admin` with `{ "action": "plur_pin", "args": { ... } }`. Call `plur_admin` with `{ "action": "help" }` for the current actions and schemas; use the live schema when serializing a call. With `PLUR_TOOL_PROFILE=full`, those actions are direct tools too.

## Before you write: check, and write once

Inspect the existing bank first. `plur_learn` returns `dedup.near_duplicates` including **the neighbour's own statement** — read it before moving on; that is what it is for. High similarity is a reason to look, not a verdict: cosine cannot distinguish a duplicate from a correction of one, and nothing is suppressed on similarity alone.

Reuse the identity for an update to the same knowledge. Merge equivalent content without pretending its sources were independent. Keep separate records when they can change independently.

**Draft the assertion before you call the tool.** Superseding an engram you wrote minutes ago is a redraft, not a correction — it leaves a chain of near-identical records, and no similarity check catches it because each link genuinely differs. `plur_learn` flags this as `redraft`. If the earlier one was simply wrong, retire it rather than stacking another supersede.

For changes, compare the same entity, scope, version and measurement conditions before declaring a contradiction. Link superseded records in both directions, keep useful history, retire the old operational rule. Differing measurement conditions can justify parallel records. Give temporary priorities an expiry or completion trigger; do not invent expiry dates for stable knowledge.

## Scope, pinning, and state are independent

Choose the broadest scope the source justifies. A standing preference can be global immediately; a project incident does not become global because its wording sounds general. Set `domain` on every record — it is the primary routing signal, and a record without one falls to `global` regardless of content.

**Pin only when the owner explicitly asks** for that memory to be pinned ("pin this", "always load this"). Do not set `pinned: true` on your own judgement, however important a rule looks — propose it instead and give the reason. A fact you need sometimes should be recalled, not pinned. In a real store audited on 2026-09-07, 12 of 46 pinned engrams were facts or history — positioning theses, incident write-ups, architecture notes — none of them things to obey.

The pinned set has a **quota** (`injection_budget × injection.pinned_ratio`). "Always-load" only means something if the set fits, so `plur_pin` **refuses** a pin that would exceed it and returns current usage plus unpin candidates. Expect refusal; resolve it by unpinning or raising the limit, and put that choice to the owner rather than picking one. Candidates are ordered by what they free, which is arithmetic — not by importance, which nothing can rank for you.

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

Deliver readable statements plus the requested records, with assumptions and unresolved evidence identified. Give each a `kind`, a structured body when it carries more than one line can, and an `outcome` only when stated. Prefer the smallest useful set; explain significant merges or scope decisions. Apply store changes when the request or workflow authorises it — creating illustrative examples does not authorise installing them as live memories — and do not add an approval step where the action is already authorised.
