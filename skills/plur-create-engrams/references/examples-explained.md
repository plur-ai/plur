# The engram spectrum, explained

Use this guide to choose examples from [plur-engram-spectrum.yaml](plur-engram-spectrum.yaml). The YAML is the original 19-record teaching catalog, preserved unchanged. It contains fictional sources, modeled lifecycle states, proposed behavioral checks, and a simulated benchmark. Read it as an authoring reference, not as facts about the user or a demonstrated runtime trace.

Contents: [record index](#record-index), [why the examples work](#why-the-examples-work), [important relationships](#important-relationships), [loading and size](#loading-and-size), [adapting a record](#adapting-a-record).

## Read the catalog as a teaching fixture, not a target shape

Every one of the 19 records populates nearly every optional field — `provenance`, `knowledge_anchors`, `temporal`, `usage`, `feedback_signals`, `injection_count`, `recurrence_count` and `structured_data` appear on all 19. That is deliberate for teaching: the catalog has to demonstrate each field somewhere.

**It is not what a good engram looks like.** Most real engrams use `statement`, `rationale`, `source`, `domain`, `tags`, `scope`, `type` and little else. Copying a fixture's shape produces a record that is mostly ceremony, and every unused field costs injection budget — `estimateTokens` serialises the whole record, not just the statement.

Two things the catalog *does* model well and worth copying: statement length (median 229 characters across all 19) and the habit of keeping the exception in `contraindications` rather than burying it mid-statement.

## Record index

The example numbers below correspond to `structured_data.example.number`. Use the exact ID to find a record. The descriptive roles are richer than PLUR's four native `type` values; they are not additional enum values.

| No. | Exact ID | Role | Scope and modeled delivery/state |
| --- | --- | --- | --- |
| 01 | ENG-2026-09-07-101 | Recommendation preference | Global, pinned, active |
| 02 | ENG-2026-09-07-102 | Standing value | Global, pinned, active |
| 03 | ENG-2026-09-07-103 | Personal context fact | Global, retrieved, active |
| 04 | ENG-2026-09-07-104 | Creative taste | Global, retrieved, active |
| 05 | ENG-2026-09-07-105 | Project purpose | Luma, pinned, active |
| 06 | ENG-2026-09-07-106 | Architectural invariant | Luma, pinned, active |
| 07 | ENG-2026-09-07-107 | Local definition | Luma, retrieved, active |
| 08 | ENG-2026-09-07-108 | Decision | Luma, retrieved, active |
| 09 | ENG-2026-09-07-109 | Procedure | Luma, retrieved, active |
| 10 | ENG-2026-09-07-110 | Episode | Luma, retrieved, active |
| 11 | ENG-2026-09-07-111 | Bounded measurement | Luma, retrieved, active |
| 12 | ENG-2026-09-07-112 | Hypothesis | Luma, candidate review |
| 13 | ENG-2026-09-07-113 | Temporary priority | Luma, pinned, active until expiry/completion |
| 14 | ENG-2026-09-07-114 | Lesson | Luma, retrieved, active |
| 15 | ABS-2026-09-07-115 | Domain abstraction | Global, candidate review |
| 16 | ENG-2026-09-07-116 | Non-software procedure | Public talks, retrieved, active |
| 17 | META-2026-09-07-117 | Cross-domain structural pattern | Global, candidate review |
| 18 | ENG-2026-09-07-118 | Superseded decision | Luma, retired/history |
| 19 | ENG-2026-09-07-119 | Paused intention | Fieldnotes workshop, dormant/resumption |

## Why the examples work

1. **Recommendation preference.** The user chooses among several reasonable ways of presenting advice: recommendation first, deciding reason, downside, and a reversal condition. The exploration exception preserves brainstorming. It merits a global pin because the choice recurs across topics. Merely saying “be helpful and decisive” would omit what to actually do.

2. **Standing value.** Future attention becomes an explicit decision criterion alongside price and speed. It can change a choice about a software stack, recurring subscription, or project plan. Its value comes from representing this person's priorities; it is not a universal claim that simpler options are superior. The benefit clause allows justified complexity.

3. **Personal context fact.** Ten words preserve relevant information about Mira's existing prototyping tools. The fact may improve implementation suggestions without requiring an imperative or an invented exception. Retrieve it for prototyping questions, not every conversation. Do not inflate it into a claim about seniority or expertise.

4. **Creative taste.** Concrete nouns, quiet humor, and a surprising detail are usable creative criteria. The unwanted naming styles narrow the search space. The client-brief exception prevents projecting a personal preference onto unrelated work. Global scope allows reuse across Mira's projects; topic-dependent usefulness favors retrieval.

5. **Project purpose.** The audience, job, and success criterion orient decisions across Luma. Claim-to-evidence traceability provides a reason to prioritize one feature over another. Pinning preserves this context even when the task does not mention research or citations. Counts of activity remain supporting measures rather than silently becoming the product objective.

6. **Architectural invariant.** Separating synthesis from evidence carries consequences for editing, persistence, and export. Those consequences belong to one coherent model distinction. It is worth pinning within Luma because many plausible local solutions could otherwise erase that distinction. A later authorized model change may supersede it.

7. **Local definition.** The meaning of “claim” and its separate verification status prevent semantic drift in UI copy and data modeling. The word alone is insufficient for retrieval: an insurance claim is a near-match that should not invoke Luma's glossary. This is a contextual definition, not a command to verify every assertion.

8. **Decision.** The local SQLite choice includes the reason—offline, single-user launch—and a condition that can reopen it—approved shared editing. A future agent can extend the chosen architecture without relitigating it on every task. The reopening clause also prevents treating a remembered decision as immutable. Example 18 records the superseded direction.

9. **Procedure.** Internal revision, frozen tasks, fresh participants, unprompted behavior, and later discussion preserve an ordered workflow. The record remains compact because logistics belong in the study packet. An internal co-design workshop is a different activity and should not be reported as an independent assessment. This is a reusable constructive process, not an incident workaround.

10. **Episode.** A participant's side-by-side comparison and the team's next research question explain a historical change in attention. The record preserves observed behavior without claiming a population preference or the participant's motive. Keeping the episode separately allows later interpretations to change without rewriting what happened.

11. **Bounded measurement.** The p95 latency remains tied to a run, search method, corpus, and test conditions. The detailed `measured_under` object supports comparison, while the statement carries the basic limits. A different workload does not automatically contradict this result. All values are simulated; no performance evidence is supplied by this teaching record.

12. **Hypothesis.** The comparison-first idea is linked to episode 10 but retains uncertainty and a proposed check. It is useful when deciding what to investigate. It cannot supply an approved navigation requirement. Alternative explanations remain possible, so neither polished wording nor a source link justifies promotion.

13. **Temporary priority.** The ongoing study changes current prioritization across Luma, making a temporary pin useful. The completion/date boundary and study-blocking exception keep it proportionate. After the study, continuing the same priority requires a new basis. A `valid_until` field expresses the intended window; actual expiry handling is a consumer responsibility.

14. **Lesson.** A specific misunderstanding supports separately naming source quality and model certainty in the next research materials. The record states the practical consequence without claiming that the best visualization has already been discovered. The strength lies in its bounded change in behavior, not in how forcefully it is phrased.

15. **Domain abstraction.** The invariant and research examples in 6, 10, and 14 suggest a broader principle: preserve the distinctions needed to judge evidence. This is potentially useful across research products, so the candidate has global scope and domain-specific relevance. One product's constructed examples do not establish transfer; the record remains a candidate.

16. **Non-software procedure.** Familiar reviewers improve a talk; a fresh listener tests the takeaway before receiving the intended answer. The procedure names an observable outcome without prescribing an entire creative process. Its memorization exception matters: exact repetition can be the goal of another task. This demonstrates procedural memory outside coding and debugging.

17. **Meta-engram.** Product research and public speaking share a relationship: the feedback used to refine an artifact can make reviewers familiar with it and distort a first-exposure assessment. The `meta` block maps the roles, lists predicted domains, and specifies a falsification test and exceptions. The mappings are constructed examples, not independent experiments; validation and composite confidence are zero. Do not copy its illustrative alignment assessments into a real record as measured scores.

18. **Retired predecessor.** The browser-storage direction explains older plans. Its retirement, validity window, and successor link allow historical recall without competing as current guidance. Preserve the actual old decision rather than silently rewriting it to match today's choice. A later return to the approach would be a new decision.

19. **Dormant intention.** A paused workshop retains a useful restart point and an existing outline. Its resumption condition prevents unfinished work from becoming a standing demand on every session. On explicit resumption, recover the context and reassess the intention. The fixture models a dormant state; it does not establish an automatic reactivation feature.

## Important relationships

Keep these distinctions when extracting several memories from one source:

| Relationship | Meaning to preserve |
| --- | --- |
| 10 → 12 | An observed episode can support a possible explanation without proving it. |
| 14 → 15, with 6 and 10 | A local lesson and related evidence can motivate a broader candidate principle. Scope expansion requires justification. |
| 9 + 16 → 17 | Map the same causal/functional roles across domains; a shared keyword or a general slogan is insufficient. |
| 18 → 8 | The newer decision replaces the older direction; keep explicit successor/predecessor links. |
| 13 versus 19 | An active temporary focus and a paused intention have different conditions for entering the working set. |

The `ABS` example generalizes within an evidence-product design domain. The `META` example transfers a structural relationship between different domains. Either can be provisional; neither is automatically more authoritative than its underlying evidence.

## Loading and size

Before the fictional study ends, an eligible Luma session has five intended pins: 01, 02, 05, 06, and 13. A usability-planning task may add 09 and 10, then explicitly inspect 12 as a hypothesis. A naming task for a different project may need only the two global pins and retrieved taste record 04. These are selection designs, not measured retrieval results or a guarantee about scope-filter implementation.

The five pinned statements total **155 words**. All 19 statements total **604 words**, excluding fixture markers. The full YAML is much larger because it also teaches provenance, lifecycle, applicability, and review. Do not confuse stored record size with injected payload size or load all records just because they are available.

## Adapting a record

Copy the useful structure, then write the new memory from actual source material. Assign a new identity, justify its scope and delivery, replace fictional evidence and dates, and choose the supported current state. Remove an example marker only after the record genuinely ceases to be an example.

Adapt these teaching shortcuts to the actual consumer:

- Several `summary` values are catalog titles. If a summary is the only injected text, replace a title such as “Recommendation preference” with the useful preference and its essential qualification, or load the full statement.
- Put a complete date, including year, in a temporary statement when it must stand alone. Example 13's September deadline is fully dated in metadata; a consumer that omits that metadata needs the year in the payload too.
- A benchmark statement can remain short when its measurement conditions are available on demand. Retrieve those conditions before comparing runs or making a workload-specific decision.

Use `structured_data.example.applies`, `near_miss`, and `review_trigger` as authoring prompts. These are teaching fields, not native triggers or automatic test execution. Routine production records need not retain this teaching scaffolding. A file/JSON Pointer anchor identifies the embedded source text here; confirm any different consumer's resolution behavior rather than assuming it.
