# The Engram Provenance Profile

**A W3C PROV binding for engram lineage**

| | |
|---|---|
| **Version** | 0.1 (draft) |
| **Status** | PROPOSED — non-normative for Engram Standard v1 |
| **Date** | 2026-08-20 Thu |
| **Profile of** | [ENGRAM-STANDARD-v1.md](./ENGRAM-STANDARD-v1.md) |
| **Supersedes** | §9 "Provenance binding (PROV-O + Swarm anchor)" of that document |
| **License** | CC-BY-4.0 (spec), Apache-2.0 (reference code) |

---

## Conformance terminology

This profile inherits the conformance terminology and maturity labels of
ENGRAM-STANDARD-v1 (**MUST**/**SHOULD**/**MAY** per RFC 2119 / RFC 8174;
maturity labels **STABLE** / **RESERVED** / **PROPOSED**).

The profile as a whole is **PROPOSED**. Implementers MAY ignore it. Where a
section describes behaviour that already exists in the reference implementation,
it is marked *(existing)* and cites the code.

---

## 1. Scope and motivation

### 1.1 What this profile covers

How the provenance of a single **engram** — where it came from, what produced it,
from what it was derived, who is answerable for it, and under what terms it may
be reused — is expressed in the W3C PROV data model.

The unit is the engram. Packs, capsules and content anchoring are addressed only
where an engram's lineage passes through them.

### 1.2 What this profile does not cover

- **Storage, transparency and anchoring.** Where a provenance record is stored,
  whether it is submitted to a transparency log ([SCITT]), and whether its hash is
  anchored to a content-addressed store or a chain, are all out of scope — see
  §2.3 for how the layers relate. ENGRAM-STANDARD-v1 §9.3 sketches a Swarm anchor;
  that remains PROPOSED and independent. A provenance model is a prerequisite for
  anchoring, not the reverse: anchoring a record that cannot describe itself proves
  nothing, and anchoring a log that can be silently rewritten (§10.6) proves less.
- **Signing.** §7 of the standard is RESERVED. This profile does not fix a
  canonicalization or a signed message, and nothing here should be read as
  delivering authenticity. It delivers *description*.
- **Correctness.** Provenance establishes where a statement came from. It never
  establishes that the statement is true.
- **Non-repudiation.** This profile produces a description that is exactly as
  trustworthy as the log it is derived from (§6.4, §10.6). [GAR] puts the stakes
  plainly: without a non-suppressible substrate, "your agent's governance record is
  a log file — deletable, editable, and legally worthless." That substrate is a
  separate layer and is not delivered here.

### 1.3 The problem

The engram schema has carried a `provenance` block — `origin`, `chain`,
`signature`, `license` — since v1, marked STABLE for `origin`/`chain`/`license`
(standard §4.8). **Nothing in the reference implementation writes it.** The only
reader is a completeness counter (`packages/core/src/quality.ts:72`).
`provenance.chain` is neither read nor written anywhere in the TypeScript stack.

The substance nevertheless exists, scattered across five places:

| Where | What it holds | Status |
|---|---|---|
| `sources[]` | one `{scope, session_id, stored_at}` per write | *(existing)* the only populated provenance |
| `history/YYYY-MM.jsonl` | append-only event log, 17 declared types, 13 emitted | *(existing)* second source of truth per ADR-0002 |
| `relations.supersedes` / `superseded_by` | typed replacement edges | *(existing)* |
| `episode_ids` + `episodes.yaml` | session records carrying `agent`, `channel`, `session_id` | *(existing)* the only actor-bearing records |
| `structured_data.extraction` | `{confidence, source_commit, extractor_version}` | *(existing)* a documented convention, deliberately not schema-wired |

This profile does not invent engram provenance. It **names what already happens in
a standard vocabulary**, and specifies the capture gaps that make the account
incomplete (§10).

### 1.4 Why W3C PROV, and why this is not already solved

[PROV-AGENT] (Souza et al., IEEE e-Science 2025) extends W3C PROV for agentic
workflows, adding `AIAgent`, `AgentTool`, `AIModelInvocation`, `AIModel`,
`Prompt`, `ResponseData` and `AgentDecision`. It models the *execution* of agents
well. It explicitly does **not** model memory or persistent state.

[AgentTraces], surveying the field in 2026, states the gap directly —
*"Memory provenance remains underdeveloped"* — and notes that long-term memory
systems "often provide limited support for tracing where memory items came from."
It sets out what a memory write should carry:

> source type, timestamp, authoring agent, supporting evidence, transformation
> operation, confidence, and update history

and requires that a model distinguish **raw observations, extracted facts,
inferred memories, and revised memories**.

That is this profile's scope, and PLUR already produces most of the raw material.

---

## 2. Design principles

### 2.1 Provenance is a projection, not a third source of truth

[ADR-0002] settles the storage architecture and this profile does not disturb it:

> Two truth stores, split by kind. Engram YAML remains the sole source of truth for
> semantic state (what is believed). History JSONL is the append-only source of
> truth for observational events (what happened).

A PROV document is therefore **derived from engram YAML plus history JSONL**. It
is a rendering of state the system already holds, computed on demand.

Three consequences, all normative for this profile:

1. A conformant implementation MUST NOT require a separate provenance store to be
   the authority for anything. If the projection and the stores disagree, the
   stores win.
2. Provenance MUST NOT be folded back into engram YAML as derived counters. ADR-0002
   already forbids this for co-fire edges; the same rule applies here.
3. A materialised PROV document is a **snapshot**. It MUST carry the time it was
   generated, because the underlying state continues to change.

### 2.2 Where the record lives

| Form | When | Notes |
|---|---|---|
| **Projection** | default | computed from YAML + history; nothing stored |
| **Sidecar `provenance.jsonld`** | export, share, sign, anchor | as anticipated by standard §9.2 |
| **On-engram binding** | always | the existing `provenance` block, finally populated (§4.1) |

Embedding a full PROV graph inside each engram's YAML is **rejected**: it
duplicates the history log, inflates every record in a file that is read on every
session start, and contradicts ADR-0002. The engram carries a *binding* — enough
to locate and verify its provenance — not the provenance itself.

### 2.3 Three layers, and this profile is only one of them

Provenance for a memory system decomposes into three independent questions. This
profile answers exactly one of them, and it is worth being explicit about which.

| Layer | Question | Standard | Status here |
|---|---|---|---|
| **Semantics / causality** | what derived from what, by whom, when | **W3C PROV** | this profile |
| **Transparency** | can the record be suppressed, edited or reordered | **SCITT** (IETF Supply Chain Integrity, Transparency and Trust) | out of scope, §10.6 is the prerequisite |
| **Availability** | can a third party fetch the bytes | content-addressed storage | standard §9.3, PROPOSED |

The layers are complementary and none substitutes for another. A PROV graph with
no transparency layer describes a history that can be silently rewritten; a
transparency log with no causal model records that something happened without
recording what it came from.

That second failure is not hypothetical. [GAR], the IETF Governance Audit Record
draft, builds governance evidence on SCITT and had to extend it with
`causal_parent_id` and `session_sequence_number` because, in its own words, base
SCITT is *"artifact-centric with no inherent causality."* PROV supplies that
causality natively through derivation, which is the reason this profile starts
with the semantic layer rather than the transparency one.

### 2.4 Reuse before invention

Where PROV-AGENT already has a term, this profile uses it. Where W3C PROV already
has a relation, this profile uses it rather than minting a synonym. The
`engram:` namespace is reserved for concepts genuinely specific to memory:
scope, commitment, activation, claim class, and the memory-specific activities.

---

## 3. Namespaces

| Prefix | IRI | Use |
|---|---|---|
| `prov` | `http://www.w3.org/ns/prov#` | W3C PROV-O |
| `engram` | `https://plur.ai/ns/engram#` | this profile |
| `pa` | PROV-AGENT vocabulary | agent/model/prompt terms (§4.4) |
| `odrl` | `http://www.w3.org/ns/odrl/2/` | usage policy (§8) |
| `xsd` | `http://www.w3.org/2001/XMLSchema#` | typed literals |

Engram, activity and agent IRIs are minted deterministically:

```
engram:ENG-2026-0819-021              an engram (current state)
engram:ENG-2026-0819-021/v3           a specific engram version (§4.2)
engram:act/EVT-1755600000-a4f21c      an activity, from a history event id
engram:agent/user/<id>                a human
engram:agent/software/<tool>@<ver>    a tool or extractor
engram:episode/EP-1755600000-x7k2     an episode
engram:pack/<name>@<version>          a pack
```

Store-namespaced engram ids (standard §3.4, `ENG-{PREFIX}-YYYY-MMDD-NNN`) map
verbatim; the prefix is part of the identifier.

---

## 4. The core mapping

### 4.1 An engram is a `prov:Entity`

```
engram:ENG-…  a  prov:Entity, engram:Engram
```

| Engram field | PROV / profile term | Notes |
|---|---|---|
| `id` | the IRI | |
| `statement` | `prov:value` | MAY be omitted when the record is shared and the statement is private |
| `content_hash` | `engram:contentHash` | *(existing)* SHA-256 of the normalized statement |
| `type` | `engram:engramType` | behavioral / terminological / procedural / architectural |
| `scope` | `engram:scope` | |
| `commitment` | `engram:commitment` | exploring / leaning / decided / locked |
| `status` | `engram:status` | see §6.2 for `retired` |
| `visibility` | `engram:visibility` | |
| `temporal.learned_at`, else earliest `sources[].stored_at` | `prov:generatedAtTime` | see the caveat below |
| `provenance.license` | `odrl:hasPolicy` | §8 |
| `derived_from`, `abstract` | `prov:wasDerivedFrom` | |
| `relations.supersedes` | `prov:wasRevisionOf` | §6.1 |
| `episode_ids` | `prov:wasDerivedFrom` an `engram:Episode` | |

> **Caveat, verified.** `temporal.learned_at` is **absent on ordinary engrams**.
> `buildTemporal()` (`packages/core/src/expiry.ts:139-149`) returns `undefined`
> unless an explicit validity window was supplied or an expiry phrase was
> extracted. Implementations MUST therefore fall back to the earliest
> `sources[].stored_at`, and MUST NOT assume `learned_at` exists. Standard §4.13
> makes the same point about the absence of a first-class `created_at`.

**The on-engram binding.** This profile gives the dormant `provenance` block a
defined meaning at last:

| Field | Meaning under this profile |
|---|---|
| `provenance.origin` | a single IRI or URI naming the immediate origin — `session:<id>`, `git:<remote>@<commit>`, `doc:<path>`, `pack:<name>@<version>`, `import:<system>` |
| `provenance.chain` | ordered ancestor engram IRIs, nearest first — the flattened `wasDerivedFrom` walk |
| `provenance.license` | an ODRL policy IRI (§8) |
| `provenance.signature` | unchanged: RESERVED, producers MUST write `null` |

`provenance.chain` is a **cache of a derivable fact**, not an authority. Per §2.1
the history log wins on disagreement.

### 4.2 Engram versions

An engram mutates in place: `engram_version` increments and, on one path only,
`previous_version_ref = {event_id, changed_at}` is written
(`packages/core/src/index.ts:3698` — `reportFailure`, the sole writer in the
codebase).

This profile models each version as a **distinct entity**, related by revision:

```
engram:ENG-…/v3  prov:wasRevisionOf  engram:ENG-…/v2
engram:ENG-…     prov:specializationOf  … (the version-independent identifier)
```

Rationale: `prov:wasRevisionOf` is defined between entities, and a statement that
has been rewritten is not the same entity as the one it replaced. Without
versioned entities, a revision is indistinguishable from an unrelated derivation.

A conformant projection MUST emit versioned entities where the version history is
recoverable, and MAY emit only the current entity where it is not. Today the
history log makes v(n-1) recoverable only for `procedure_evolved` (§10.2).

### 4.3 History events are the activity vocabulary

Each history event *(existing:* `packages/core/src/history.ts:5-10`*)* becomes one
`prov:Activity`. The event id (`EVT-…`) supplies the activity IRI, so activities
are addressable and de-duplicable.

| History event | Activity class | Principal relations |
|---|---|---|
| `engram_created` | `engram:Learn` | `prov:generated` the engram |
| `engram_updated` | `engram:Revise` | `prov:wasRevisionOf` |
| `engram_merged` | `engram:Consolidate` | multi-parent `prov:wasDerivedFrom` |
| `engram_promoted` | `engram:Promote` | `prov:wasDerivedFrom` an episode |
| `procedure_evolved` | `engram:Revise` | `prov:wasRevisionOf` + `previous_version_ref` |
| `engram_retired` | `engram:Retire` | **`prov:wasInvalidatedBy`** (§6.2) |
| `engram_decremented` | `engram:Dereference` | reference count decrease only |
| `recurrence_detected` | `engram:Recur` | scope broadening, commitment escalation |
| `contradiction_detected` | `engram:DetectTension` | §6.3 |
| `feedback_received` | `engram:Feedback` | §7.2 |
| `co_injection` | `engram:Inject` | `prov:used` the injected engrams (§7.1) |
| `injection_outcome` | `engram:Outcome` | links a verdict to an injection |
| `failure_reported` | `engram:ReportFailure` | `prov:wasInformedBy` → `engram:Revise` |

Activities carry `prov:startedAtTime` / `prov:endedAtTime` from the event
timestamp (equal, for instantaneous events) and `prov:wasAssociatedWith` the
responsible agent (§4.4).

Four declared event types are **never emitted** — `scope_promoted`,
`buffer_pruned`, `weekly_review`, `engram_route_failed`. A projection MUST NOT
invent activities for them.

### 4.4 Agents and delegation

Three agent kinds, aligned with PROV-AGENT where they overlap:

| Kind | Class | Example |
|---|---|---|
| Human | `prov:Person` | the user who asserted or corrected a statement |
| Agent runtime | `pa:AIAgent`, `prov:SoftwareAgent` | the assistant that called `plur_learn` |
| Model | `pa:AIModel` | the model behind an LLM-mediated decision |
| Tool | `prov:SoftwareAgent` | an extractor, importer, or migration, with version |

Responsibility is expressed by delegation, which is the point of the construct:

```
engram:agent/software/plur-encode@0.2.0  prov:actedOnBehalfOf  engram:agent/user/<id>
```

An LLM-mediated decision is an `pa:AIModelInvocation` activity that
`prov:used` a `pa:Prompt` and generated a `pa:ResponseData`, associated with the
`pa:AIModel`. This is how a dedup MERGE verdict, a meta-engram formulation, or a
procedure rewrite becomes answerable rather than anonymous.

> **Verified gap.** No actor of any kind is recorded today. `HistoryEvent` has no
> actor field. The engram has no author, agent, model or tool field. Enterprise
> stamps `created_by` (`migrations/013-engrams-created-by.sql`) but
> `RemoteStore.reshape()` (`packages/core/src/store/remote-store.ts:99-113`) drops
> it on read-back, so the client view of a remote engram has no author either.
> Until §10.1 is addressed, agents in a projection are largely inferred from the
> `source` string, and a conformant projection MUST mark such agents
> `engram:inferredAgent true` rather than assert them.

### 4.5 Claim class

[AgentTraces] requires distinguishing raw observations, extracted facts, inferred
memories and revised memories. PLUR Encode already carries `claim_class` and
`origin_stage` (`encode/assemble/runner.py:78-79`) with a stratum vocabulary
(`encode/assemble/strata.py:34-47`: `documented`, `enforced`, `observed`,
`process`, `structural`). This profile reuses that vocabulary rather than minting
a parallel one, and adds the two classes Encode has no need for:

| `engram:claimClass` | Meaning | Typical origin |
|---|---|---|
| `observed` | a raw record of something that happened | episode capture |
| `documented` | extracted from prose written by a human | doc extraction, regex ingest |
| `structural` | derived from the shape of an artifact | repo structure, metrics |
| `asserted` | stated directly by a human or agent in session | `plur_learn` |
| `inferred` | produced by a model from other engrams | meta-engram, dedup MERGE |
| `revised` | a rewrite of a prior version | `procedure_evolved`, dedup UPDATE |

`engram:claimClass` is the single most useful field for a consumer deciding how
much weight to give a memory, and it is currently unrecoverable for most engrams.

---

## 5. Origination taxonomy

Every way an engram can come into existence, with its PROV pattern. Paths marked
† lose information today that the pattern requires; see §10.

| # | Path | Entry point | Claim class | Pattern |
|---|---|---|---|---|
| 1 | Direct assertion | `plur_learn` | `asserted` | `Learn` associated with the agent, attributed to the user |
| 2 | Session-end summary † | `plur_session_end` | `inferred` | `Learn` `wasDerivedFrom` the episode; **session id not passed today** |
| 3 | Episode promotion | `plur_episode_to_engram` | `observed` | `Promote`; `wasDerivedFrom` `engram:Episode` |
| 4 | Regex ingest † | `plur_ingest` | `documented` | `hadPrimarySource` the document; extractor as `SoftwareAgent` |
| 5 | Repo extraction | PLUR Encode | `structural` / `documented` | `hadPrimarySource` `git:<remote>@<commit>`; Receipt as `prov:Bundle` |
| 6 | Model elicitation | Encode reconcile | `inferred` | `AIModelInvocation` with model + prompt hash |
| 7 | Dedup UPDATE † | `learn-async` | `revised` | `wasRevisionOf` the prior version |
| 8 | Dedup MERGE † | `learn-async` | `inferred` | multi-parent `wasDerivedFrom` |
| 9 | Meta-engram | `plur_extract_meta` | `inferred` | `wasDerivedFrom` each evidence engram |
| 10 | Pack install † | `plur_packs_install` | inherited | `wasDerivedFrom` `engram:Pack`; pack `prov:hadMember` |
| 11 | Migration import † | `plur import` | inherited | `hadPrimarySource` the external system |
| 12 | Correction from review | GitLab handler | `documented` | `hadPrimarySource` the MR URL; attributed to the human author |
| 13 | Cross-scope recurrence | `_recordCrossScopeRecurrence` | unchanged | `Recur` activity; records the pre-broadening scope |
| 14 | Supersession | `context.supersedes` | `revised` | `wasRevisionOf` (§6.1) |
| 15 | Ambient capture † | OpenClaw ContextEngine | varies — see §5.2 | `Learn` associated with the runtime, `wasDerivedFrom` the turn |
| 16 | Framework adapter † | LangChain `PlurMemory` | `inferred` | `Learn`; no chain or session id captured |
| 17 | Direct API write † | enterprise `POST /api/v1/engrams` | unknown | attributed to `created_by`; **lost on client read-back** |

### 5.1 Notes on individual paths

**Path 2** is the highest-volume and lowest-provenance path in the system. The
session id is an argument of the very tool call that creates the engram and is
used two lines later for `plur.capture`, but is not passed to `learn`
(`packages/mcp/src/tools.ts:2164`). Fixing this single call site would populate
`sources[].session_id` for the majority of engrams.

**Path 4** stores neither the ingested content nor which of the five regexes fired
(`packages/core/src/index.ts:376-382`), so an ingested engram is indistinguishable
from a hand-written one. `hadPrimarySource` has nothing to point at.

**Path 5** is the reference implementation of this profile in all but name. Encode
already writes `provenance = {origin: "git:<source>", chain: [run_id]}` plus
`structured_data.extraction`, maintains a receipt chain with model, `prompt_id`,
`prompt_version` and `prompt_sha256` (`encode/elicit/runner.py:328-338`), records
every dropped row with a typed `GapReason`, and pseudonymises actors through a
single salted funnel. It is then discarded at the wire (§10.4).

**Path 10** attaches nothing to the engram. Pack name, version, creator and
integrity hash live only in `packs/registry.yaml`; the `pack` schema field stays
`null` and the loaded `_pack` marker is transient. Nothing records who installed a
pack, when, or from where, at engram granularity.

**Path 17** is the only path with a real recorded author — enterprise stamps
`created_by` — and it is erased in transit, so the client can never see it (§4.4).

### 5.2 Ambient capture is three claim classes wearing one label

Path 15 is the clearest argument for §4.5. OpenClaw writes engrams from five
distinct triggers, distinguished today only by a `source` string:

| Trigger | Source string | True claim class |
|---|---|---|
| user correction detected mid-turn | `openclaw:ingest` | `asserted` |
| context compaction | `openclaw:compact` | `inferred` |
| model self-report block | `openclaw:self-report` | `inferred` |
| regex fallback after a turn | `openclaw:afterTurn` | `documented` |
| explicit `/learn` command | `openclaw:slash` | `asserted` |

Three different claim classes, and the distinction that matters most — *the user
said this* versus *the model claims it learned this* — survives only as an
unstructured prefix a consumer must parse. Each call site also discards the
extraction confidence that gated the write, and has `sessionId` in scope while
passing it to `capture` but not to `learn`
(`packages/claw/src/context-engine.ts:286` vs `:356`).

---

## 6. Lifecycle

### 6.1 Revision and supersession

`relations.supersedes` maps to `prov:wasRevisionOf`, which is a subproperty of
`prov:wasDerivedFrom` — so a consumer that understands only derivation still sees
the edge.

The reverse edge `superseded_by` is a materialised convenience *(existing:*
`packages/core/src/index.ts:4161-4174`*)* and MUST NOT be emitted as a separate
PROV relation; PROV edges are directional and the inverse is derivable.

> **Verified limitation.** Reverse-edge writing is best-effort and **local primary
> store only**; targets in other stores are never patched. An asymmetric graph is
> a normal outcome, not corruption. A projection MUST tolerate a `supersedes` edge
> whose target has no matching `superseded_by`.

Supersession today carries **no timestamp, no reason and no actor**, so nothing
distinguishes "superseded because the world changed" from "superseded because the
old statement was wrong" — a distinction that matters to anyone auditing a belief.
See §10.3.

### 6.2 Retirement and invalidation

`status: retired` maps to `prov:wasInvalidatedBy` an `engram:Retire` activity,
with `prov:invalidatedAtTime` from the event.

This is the relation [AgentTraces] calls *Invalidate*, and it is the one that
makes a memory system auditable: without it, a record that is no longer believed
is indistinguishable from one that never existed.

Two behaviours a projection MUST respect:

1. **Retirement is reference-counted.** `forget` decrements `reference_count` and
   only retires at zero *(existing:* `packages/core/src/index.ts:3013-3136`*)*. A
   decrement is `engram:Dereference`, not invalidation.
2. **`compact()` hard-deletes retired engrams from YAML**
   (`packages/core/src/index.ts:3137-3170`). After compaction the entity exists
   only in history. A projection MUST still emit the entity and its invalidation —
   an engram that was compacted away is precisely the case where provenance earns
   its keep — and MUST mark it `engram:compacted true`, since the statement text is
   irrecoverable.

Additionally, `plur_forget` via MCP **never passes a reason**: the tool's schema
accepts only `{id, search}` and all three call sites omit the second argument
(`packages/mcp/src/tools.ts:1002-1028`). Every MCP retirement therefore records
`reason: null`.

### 6.3 Contradiction

A tension record maps to an `engram:DetectTension` activity relating two entities,
with the tension's **statement snapshots** as `prov:value` on the activity. Those
snapshots exist precisely because engrams may later be edited or retired, making
the tension record a small provenance artifact in its own right — and the only
place in the system that preserves a statement as it was at a moment in time.

Resolution retires the loser unconditionally, ignoring reference count, and
records `reason: "tension <id> resolved in favor of <winnerId>"` — one of only two
places a lifecycle reason is written at all.

### 6.4 Suppression paths — stated, not hidden

[GAR] sets non-suppressibility as the property that separates evidence from
logging: the generating component "MUST generate audit artifacts automatically,
MUST sign them, and MUST NOT allow any agent, application, or principal to
suppress, modify, or delete them." Against that standard, an engram store today
has two deliberate suppression paths:

| Path | Effect |
|---|---|
| `compact()` | hard-deletes retired engrams from YAML; only the history line survives |
| `purgeTensions()` | wipes `relations.conflicts` across every local store, with no history event and no backup |

Both are legitimate features — the first bounds file growth, the second clears a
scan suppress-list. Both mean a projection MUST NOT be presented as
non-suppressible evidence. A conformant implementation SHOULD emit a history
event for each, so that suppression is itself recorded.

This is the honest boundary of the profile: it produces a *description* that is
as trustworthy as the log it is derived from, and §10.6 is what would make that
log trustworthy.

---

## 7. Retrieval and downstream use

[AgentTraces] requires tracking not only where a memory came from but which
memories were retrieved, in what context, and what they went on to affect.

### 7.1 Injection

`co_injection` *(existing)* records `{ids[], query_hash, tokens_used, source,
scope, session_id}` — deliberately the query **hash**, never the query text. It
maps to an `engram:Inject` activity that `prov:used` each injected entity.

`query_hash` becomes `engram:queryHash`. A projection MUST NOT attempt to
reconstruct query text.

### 7.2 Outcome

`injection_outcome` links a feedback verdict back to an injection. Note the
existing semantics, which a projection MUST preserve: *"'Ignored' is the ABSENCE
of an outcome for an injected engram — no synthetic ignore events are ever
written"* (`packages/core/src/history.ts:99-116`). Absence is not evidence of
rejection, and a projection MUST NOT emit an activity for it.

Feedback silently escalates commitment on the positive path
(`exploring → leaning → decided`, `packages/core/src/index.ts:2653-2657`) with no
record of who gave it. A belief hardens and the record does not say why.

---

## 8. Licensing: making reuse checkable

`provenance.license` already exists and already defaults to `cc-by-sa-4.0`. This
profile binds it to [ODRL] so that a consuming agent can *evaluate* it rather than
merely display it:

```json
{
  "@id": "engram:ENG-2026-0819-020",
  "odrl:hasPolicy": {
    "@type": "odrl:Set",
    "odrl:permission": [{
      "odrl:action": "odrl:use",
      "odrl:duty": [{ "odrl:action": "odrl:attribute" }]
    }]
  }
}
```

The precedent is [Croissant] 1.1 (MLCommons, February 2026), which combines
PROV-O lineage with ODRL usage policies across 700,000+ datasets so that agents
can "automatically verify whether a proposed use is permitted." This is the
mechanism by which an engram becomes *legitimately* reusable in an AI flow rather
than merely traceable: a pack consumer, a marketplace, or a training pipeline can
check permission without a human reading a licence string.

A conformant implementation SHOULD map common licence identifiers to ODRL policy
IRIs and MUST NOT silently widen the terms of an unrecognised licence.

---

## 9. Serialization

The interchange form is **PROV-O in JSON-LD**, per standard §9.2, as
`provenance.jsonld`.

PROV-JSON is NOT the interchange form for this profile. JSON-LD is what the
surrounding ecosystem consumes — Croissant, DSSC data spaces, and any triplestore.

A materialised document MUST carry the projection time and the source state it was
computed from:

```json
{ "@id": "engram:projection/0f3a9c21-5d7e-4b18-9a2c-1e6f8d40b7aa",
  "@type": "prov:Bundle",
  "prov:generatedAtTime": "2026-08-20T09:00:00Z",
  "engram:historyThrough": "2026-08" }
```

A `prov:Bundle` is itself an entity, which is what allows the provenance of the
provenance to be described, signed, and later anchored.

---

## 10. Capture requirements

A projection is only as good as its inputs. These are the gaps that must close for
the model above to hold. Each is independently implementable and independently
useful; none requires the others.

### 10.1 Actor — REQUIRED

No actor exists anywhere: not on `HistoryEvent`, not on the engram. This is the
single largest gap, because without it every attribution in a projection is
inferred (§4.4).

Add an actor to `HistoryEvent`, and an author binding to the engram, distinguishing
at minimum: human, agent runtime, model, automated hook.

The shape SHOULD be borrowed rather than invented. The signed-action-envelope
field set from [ZylosIdentity] maps onto PROV without friction:

| Envelope field | PROV |
|---|---|
| `agent_identity` | the `prov:Agent` IRI |
| `runtime { name, version, model, toolset_digest }` | `prov:SoftwareAgent` + `pa:AIModel` |
| `delegation_ref` | `prov:actedOnBehalfOf` |
| `input_digest` / `output_digest` | entity identity, hashes not payloads |
| `parent_action_id` | `prov:wasInformedBy` |

Two rules from the same source are worth adopting verbatim: **store hashes by
default**, keeping sensitive payloads under explicit retention policy; and
identify the *running process*, not a long-lived account — SPIFFE-style
short-lived workload identities, since "if every agent action authenticates as
the same long-lived service account, attribution collapses." DIDs cover the
cross-organisation case where no shared identity provider exists.

### 10.2 Version lineage — REQUIRED for §4.2

`previous_version_ref` is written by exactly one path. The dedup UPDATE and MERGE
paths bump `engram_version` without it (`packages/core/src/learn-async.ts:118,152`),
so the revision chain is broken for the most common mutation. Set it wherever
`engram_version` increments.

Resolving a `previous_version_ref` also requires scanning `data.event_id`, because
`HistoryEvent` has no top-level `id`. Promote it.

### 10.3 Reasons — RECOMMENDED

Lifecycle transitions carry no reason: forget (never passed via MCP), pin,
promote, demote, supersede, commitment escalation. Only tension resolution and
cross-scope auto-lock write one.

### 10.4 Transport fidelity — REQUIRED for any shared provenance

The remote wire sends **four fields**: `{statement, scope, domain, type}`
(`packages/core/src/store/remote-store.ts:276-313`). The enterprise bulk endpoint
reads five. Everything else — including all provenance — is destroyed in transit.

Encode's `PlurSink` is the model for correct behaviour here: it posts the full
candidate deliberately and *reports* `dropped_fields` rather than pre-trimming,
"because pre-trimming here would hide the loss" (`encode/emit/sinks.py:172-182`).
A provenance-aware sink SHOULD name its losses.

### 10.5 Missing events — RECOMMENDED

No history event is emitted for: `_recordDuplicate` (a re-assertion is invisible),
`_reactivateResults` (the most frequent mutation in the system), `setPinned`
(the highest-leverage flag, zero audit trail), `updateEngram`, `saveMetaEngrams`,
pack install/uninstall, or sensitivity demotion.

### 10.6 A tamper-evident history log — REQUIRED before any anchoring

`history.ts` appends with `fs.appendFileSync`. The log is append-only **by
convention, not by construction**: there is no hash chain, so a history file can
be edited, truncated or reordered with no detectable trace.

Every other capture requirement improves what the record *says*. This one decides
whether the record can be *believed*, and it is the prerequisite for the
transparency layer in §2.3 — anchoring a log that can be silently rewritten
produces an artifact that looks like proof and is not.

The construction is standard and cheap ([ZylosIdentity]):

```
event_001_hash = sha256(event_001)
event_002_hash = sha256(event_002 || event_001_hash)
event_003_hash = sha256(event_003 || event_002_hash)
```

which makes deletion and reordering detectable to anyone holding a later
checkpoint hash. Note that **PLUR Enterprise already does exactly this** — a
signed, hash-chained audit table whose table is owned by a non-app role so the
application cannot bypass append-only. Core does not. The design is proven
in-house; it needs porting, not inventing.

One limitation to record rather than paper over: our history is written by the
same process that mutates the engram. [ZylosIdentity] recommends signing "outside
the mutable application database," so a core-only scheme cannot defend against a
compromised or buggy writer producing a self-consistent false history. Chaining
raises the bar from *undetectable* to *detectable by a holder of a later
checkpoint*; it does not reach non-repudiation on its own.

### 10.7 Selection state at injection time — RECOMMENDED

`co_injection` records which engrams were injected and the query hash, but not
the **activation strength that caused them to be selected**. After the fact,
"why was this engram chosen" is unanswerable.

This is the memory analogue of the `freshness_seconds` field in
[DecisionProvenance] — the age and state of the data *at the moment it was used*,
not when it was written. Recording retrieval strength and rank at injection turns
`engram:Inject` from a list of ids into an account of a selection.

---

## 11. What is lost, in both directions

Following the precedent of `prov-mapping.md`, both directions are stated.

### 11.1 Engram → PROV

| Engram concept | Status in PROV | Note |
|---|---|---|
| activation strengths, decay | not expressible | continuous state, not an event |
| `commitment` | `engram:commitment` only | no PROV analogue for belief strength |
| associations (`co_accessed`) | deliberately omitted | ADR-0002 calls these "a lossy, capped online cache — not provenance" |
| `feedback_signals` counters | aggregate only | individual verdicts survive as `Outcome` activities |
| scope semantics | `engram:scope` string | hierarchy and membership rules are out of PROV's model |

### 11.2 PROV → Engram

| PROV construct | Fate | Note |
|---|---|---|
| qualified influences, roles | lost | no engram field carries edge attributes |
| `prov:Plan` | lost | no representation of the procedure an activity followed |
| bundles | lost on ingest | an engram cannot hold a nested graph |
| multiple agents per entity | reduced to one | no multi-author field |
| activity intervals | collapsed to instants | history events are points in time |

---

## 12. Worked examples

### 12.1 Direct assertion (`plur_learn`)

```json
{
  "@context": {
    "prov": "http://www.w3.org/ns/prov#",
    "engram": "https://plur.ai/ns/engram#",
    "xsd": "http://www.w3.org/2001/XMLSchema#"
  },
  "@graph": [
    {
      "@id": "engram:ENG-2026-0819-020",
      "@type": ["prov:Entity", "engram:Engram"],
      "engram:claimClass": "asserted",
      "engram:engramType": "architectural",
      "engram:scope": "group:plur/plur-ai/comms",
      "engram:commitment": "leaning",
      "engram:contentHash": "sha256:9f2c…",
      "prov:generatedAtTime": {
        "@value": "2026-08-19T11:04:22Z", "@type": "xsd:dateTime"
      },
      "prov:wasGeneratedBy": { "@id": "engram:act/EVT-1755601462-a4f21c" },
      "prov:wasAttributedTo": { "@id": "engram:agent/user/crtahlin" }
    },
    {
      "@id": "engram:act/EVT-1755601462-a4f21c",
      "@type": ["prov:Activity", "engram:Learn"],
      "prov:startedAtTime": {
        "@value": "2026-08-19T11:04:22Z", "@type": "xsd:dateTime"
      },
      "prov:wasAssociatedWith": { "@id": "engram:agent/software/plur-mcp@0.18.0" }
    },
    {
      "@id": "engram:agent/software/plur-mcp@0.18.0",
      "@type": ["prov:SoftwareAgent"],
      "prov:actedOnBehalfOf": { "@id": "engram:agent/user/crtahlin" }
    },
    { "@id": "engram:agent/user/crtahlin", "@type": "prov:Person" }
  ]
}
```

### 12.2 Repo extraction (PLUR Encode)

```json
{
  "@id": "engram:ENG-2026-0803-114",
  "@type": ["prov:Entity", "engram:Engram"],
  "engram:claimClass": "structural",
  "prov:hadPrimarySource": { "@id": "git:github.com/plur-ai/plur@d1f6c5f" },
  "prov:wasGeneratedBy": { "@id": "engram:act/encode-run-2026-0803-01" },
  "prov:wasAttributedTo": { "@id": "engram:agent/software/plur-encode@0.2.0" },
  "engram:extractionConfidence": 0.82
}
```

with the eliciting model made answerable:

```json
{
  "@id": "engram:act/encode-run-2026-0803-01",
  "@type": ["prov:Activity", "engram:Learn", "pa:AIModelInvocation"],
  "prov:used": { "@id": "engram:prompt/sha256:6b1e…" },
  "prov:wasAssociatedWith": { "@id": "engram:model/gpt-5.6-sol" },
  "engram:promptVersion": "3"
}
```

### 12.3 Supersession

```json
[
  {
    "@id": "engram:ENG-2026-0815-007",
    "@type": ["prov:Entity", "engram:Engram"],
    "engram:status": "retired",
    "prov:wasInvalidatedBy": { "@id": "engram:act/EVT-1755700000-b1c2" },
    "prov:invalidatedAtTime": {
      "@value": "2026-08-18T14:20:00Z", "@type": "xsd:dateTime"
    }
  },
  {
    "@id": "engram:ENG-2026-0818-031",
    "@type": ["prov:Entity", "engram:Engram"],
    "engram:claimClass": "revised",
    "prov:wasRevisionOf": { "@id": "engram:ENG-2026-0815-007" }
  }
]
```

---

## 13. Implementation notes

**`prov-core` cannot express this profile today.** Audited 2026-08-19 against
`4-provenance/2-projects/prov-core`:

- `prov:wasInvalidatedBy` is **entirely absent** — and §6.2 makes it the most
  important relation in a memory model.
- `wasRevisionOf` and `hadPrimarySource` exist only as string tags on a derivation
  and **do not survive deserialization**.
- Qualified relations, including `prov:hadRole`, are type-only interface stubs
  with a `TODO` and no wiring.
- Collections / `hadMember` are absent, so §5 path 10 (packs) has no construct.
- Output is PROV-JSON only. There is **no PROV-O, RDF or JSON-LD serializer**,
  which §9 requires.
- Per-edge attributes are dropped on round-trip.

So prov-core is a starting skeleton, not a substrate. Choosing between extending it
and adopting an established PROV-O/JSON-LD library is an implementation decision
this profile deliberately leaves open.

---

## 14. Open questions

1. **Versioned entities (§4.2).** Adopting them makes `wasRevisionOf` meaningful
   but requires `previous_version_ref` on every mutation path (§10.2). Adopting
   them lazily — versioned where recoverable, flat otherwise — produces a graph
   whose shape depends on which code path happened to run, which may be worse than
   either consistent choice.
2. **Invalidation after compaction (§6.2).** Is an entity whose statement has been
   hard-deleted still meaningfully described, or should compaction emit a tombstone
   entity of a distinct class?
3. **Promoting `structured_data.extraction`.** It is the closest thing to a
   provenance model already in the codebase and it rides in an untyped passthrough
   bag, deliberately unwired (`packages/core/src/schemas/engram.ts:190-247`). This
   profile leans on it; should it become first-class?
4. **Statement disclosure.** §4.1 makes `prov:value` optional so a provenance
   record can be shared without the statement. Whether the default is to include or
   omit is a policy question, not a modelling one.

---

## Appendix A — Normative references

| Ref | Document |
|---|---|
| [PROV-O] | W3C, *PROV-O: The PROV Ontology*, Recommendation, 2013 |
| [PROV-DM] | W3C, *PROV-DM: The PROV Data Model*, Recommendation, 2013 |
| [ODRL] | W3C, *ODRL Information Model 2.2*, Recommendation, 2018 |
| [JSON-LD] | W3C, *JSON-LD 1.1*, Recommendation, 2020 |
| [RFC 2119] / [RFC 8174] | Key words for use in RFCs |
| [PROV-AGENT] | Souza et al., *PROV-AGENT: Unified Provenance for Tracking AI Agent Interactions in Agentic Workflows*, IEEE e-Science 2025, arXiv:2508.02866 |
| [AgentTraces] | *From Agent Traces to Trust: A Survey of Evidence Tracing and Execution Provenance in LLM Agents*, 2026, arXiv:2606.04990 |
| [Croissant] | MLCommons, *Croissant 1.1*, February 2026 |
| [ADR-0002] | `docs/adr/ADR-0002-derived-state-provenance.md` |
| [SCITT] | IETF, *Supply Chain Integrity, Transparency and Trust* architecture |
| [GAR] | Sato & Soos, *Governance Audit Record*, IETF draft `draft-sato-soos-gar` |
| [ZylosIdentity] | Zylos Research, *Agent Identity and Signed Provenance*, 2026-04-25 |
| [DecisionProvenance] | *Decision Provenance in Agentic Systems: Audit Trails That Actually Work*, 2026-04-19 |
| [AIAct] | Regulation (EU) 2024/1689, Arts. 12 and 26 |

## Appendix B — Maturity index

| Section | Topic | Maturity |
|---|---|---|
| §2 | Projection principle | PROPOSED |
| §4.1 | Engram as Entity + `provenance` binding | PROPOSED |
| §4.2 | Versioned entities | PROPOSED, blocked on §10.2 |
| §4.3 | Activity vocabulary | PROPOSED |
| §4.4 | Agents and delegation | PROPOSED, blocked on §10.1 |
| §4.5 | Claim class | PROPOSED |
| §6.2 | Invalidation | PROPOSED |
| §8 | ODRL licensing | PROPOSED |
| §9 | JSON-LD serialization | PROPOSED |
| §6.4 | Suppression paths | informative |
| §10 | Capture requirements | REQUIRED for conformance to §4–§9 |
| §10.6 | Tamper-evident history | REQUIRED before any anchoring |
