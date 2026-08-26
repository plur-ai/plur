# Recording where an engram came from

**A companion document to the Engram Standard, version 1**

In standards writing, a companion document like this is called a *profile*. It
does not replace the main standard. It takes one part of it and says exactly how
that part should work.

| | |
|---|---|
| **Version** | 0.5 (draft) |
| **Status** | Proposed, and implemented in the reference. OPTIONAL to follow: an implementation that ignores this document is still fully conformant to the Engram Standard. An implementation that writes provenance MUST follow this document, so that two such implementations agree. |
| **Companion to** | [The Engram Standard, version 1.3](./ENGRAM-STANDARD-v1.md) |
| **Profiles** | Section 9 of that standard, "Provenance binding". It refines that section; it does not replace it, and the standard governs wherever the two overlap. |
| **Date** | 2026-08-26 |
| **Licence** | Creative Commons BY 4.0 for the text, Apache 2.0 for any code |

**Revision history**

| Version | Date | What changed |
|---|---|---|
| 0.5 | 2026-08-26 | Section 10.1 completed. History events now carry an actor, and a record prefers it over the engram's attribution when saying who caused an activity — otherwise a correction is attributed to the person it corrected, the collapse an outside reviewer warned about on the epic. Section 10.1.2 added for `provenance.chain`, the last of the four origin fields nothing read or wrote: ancestors nearest first, bounded, cycle-guarded, and explicitly a shortcut the history log outranks. |
| 0.4 | 2026-08-26 | Section 10.1 is largely done: an identity now comes from `provenance.identity` in configuration, never from the operating system account, with a per-write override and the `unidentified` marker when nobody is set; the software that wrote an engram is recorded on every write. The marker counts as unanswered even though it is recorded, so a memory nobody is accountable for cannot report itself complete. Section 8 fails closed on the schema default too — it was closed on a licence we could not recognise and open on one nobody selected. That, rather than deleting `provenance.license`, is how engram-level copyright becomes opt-in without a major version. |
| 0.3 | 2026-08-26 | Licence work. Section 8 now separates a copyright licence from usage terms and says which one it maps. Section 8.4's boolean became `engram:licenseSource` with four values, because a licence the author configured once was being reported like the schema value nobody chose. Pack export now REQUIRES a chosen licence — the one field where silence does not produce silence, since the schema fills in a share-alike grant nobody agreed to. Members with no licence inherit the pack's, marked as inheritance rather than choice. Section 4.5 gained the requirement that a claim class be visible at injection, not only in a record nobody asks for mid-session — reported from outside against a working implementation. |
| 0.2 | 2026-08-25 | Section 5.3 rewritten from prose into a specification: the pack-level field table, the file layout inside a pack, which engrams a pack record may describe, which way the integrity dependency runs, and how a pack declares that it carries provenance. Section 9 corrected — it named a single file, which cannot hold a pack's worth of records. Wording corrected throughout: this document *profiles* section 9, it does not replace it. |
| 0.1 | 2026-08-20 | First draft. |

---

## Terms used in this document

Read this first. Everything below depends on it.

**Engram** — one thing an agent learned, stored as a small record. This is the
unit this document is about.

**Provenance** — the record of where something came from. Who made it, when, out
of what, and by what process.

**PROV** — a published standard from the World Wide Web Consortium (W3C) for
writing provenance down. It has only three building blocks:

- an **entity** is a thing, and here that means an engram
- an **activity** is something that happened to a thing, such as learning it
- an **agent** is who or what is responsible, such as a person, a tool or a model

**PROV-O** — the version of PROV written as a vocabulary for the web, so that
software can read it. This document uses PROV-O.

**JSON-LD** — a way of writing that vocabulary as ordinary JSON. It is JSON with
one extra field that says what each name means.

**Transparency log** — a log that can only be added to. Anyone can check that a
record was added, and that it has not been removed or reordered since.

**Projection** — a view built from data you already hold. It is not a second copy
kept alongside. This document builds provenance as a projection.

Appendix A lists the other short names used here.

---

## 1. What this document is for

### 1.1 What it covers

It says how to record where a single engram came from:

- what produced it
- what it was derived from
- who is answerable for it
- under what licence it may be reused

It uses the PROV standard to write this down. Software that has never heard of us
can then still read it.

The unit is one engram. Packs and capsules appear only where an engram's history
passes through them.

### 1.2 What it does not cover

**Storage.** This document does not say where a provenance record is kept. It
does not cover transparency logs. It does not cover anchoring a record to a
blockchain. Section 2.3 explains how those layers relate to this one.

**Signing.** Section 7 of the Engram Standard sets aside space for signatures. It
does not define how signing works. This document does not define it either.
Nothing here proves who wrote a record. It only describes what happened.

**Correctness.** Provenance tells you where a statement came from. It never tells
you the statement is true.

**Proof that cannot be denied.** What this document produces is only as
trustworthy as the log it is built from. Sections 6.4 and 10.6 explain why. The
Governance Audit Record draft puts the problem plainly. Without a log that nobody
can quietly edit, "your agent's governance record is a log file — deletable,
editable, and legally worthless."

### 1.3 The problem

Every engram already has somewhere to record its origin. The Engram Standard
defines four fields for it: `origin`, `chain`, `signature` and `license`. Three of
the four are marked stable.

**Nothing writes them.** We checked the whole codebase. One piece of code reads
the block, and it only counts how complete a record is
(`packages/core/src/quality.ts:72`). The `chain` field is never read and never
written anywhere.

The information does exist. It is just scattered across five places.

| Where | What it holds |
|---|---|
| `sources[]` | one entry per write, holding scope, session and timestamp |
| the history log | a file of events that is only added to, in `history/YYYY-MM.jsonl` |
| `supersedes` and `superseded_by` | which engram replaced which |
| `episode_ids` and `episodes.yaml` | session records, the only ones naming an agent |
| `structured_data.extraction` | how a record was extracted, and how sure the extractor was |

So this document does not invent anything. It gives a standard name to what
already happens. Section 10 then lists what is still missing.

### 1.4 Why use PROV, and why now

Two recent papers make this a good moment.

The first is **PROV-AGENT**, published at a 2025 conference of the Institute of
Electrical and Electronics Engineers (IEEE). It extends PROV to cover AI agents.
It adds names for the agent, the model, the prompt and the reply. So it covers
what an agent *does*. It does not cover what an agent *remembers*. The authors
say so directly. Their model has no way to describe an agent's stored state.

The second is a survey of the field from 2026. It names the same gap in one
sentence: *"Memory provenance remains underdeveloped."* It then lists what a
memory record ought to carry:

> source type, timestamp, authoring agent, supporting evidence, transformation
> operation, confidence, and update history

It also asks memory systems to tell four kinds of record apart. Things they
observed. Facts they extracted. Conclusions they inferred. Earlier records they
later revised.

That list is what this document sets out to deliver. We already produce most of
the raw material.

---

## 2. How this is designed

### 2.1 Provenance is a view, not another copy

We already decided how storage works, in an architecture decision record. Two
stores hold the truth, and each holds a different kind of truth:

- the engram file holds what is **believed** now
- the history log holds what **happened**, and is only ever added to

Provenance is built from both, when someone asks for it. It is not a third store.

Three rules follow:

1. If the view and the stores disagree, the stores win.
2. Never write the view back into the engram file as extra counters.
3. A saved provenance record is a snapshot. It must say when it was made, because
   the underlying data keeps changing.

### 2.2 Where the record lives

| Form | When | Notes |
|---|---|---|
| a view, built on demand | normally | nothing is stored |
| a portable record | when exporting or sharing | must stand on its own, see below |
| four fields on the engram | always | the existing origin block, finally filled in |

We do **not** put the whole provenance graph inside each engram file. It would
repeat the history log. It would also make that file bigger, and the file is read
at the start of every session. The engram holds a pointer, not the history.

### A record you send must stand on its own

This is the most important rule in the document.

A record you keep may point at the history log, because you have the log. A record
you **send** may not. Whoever receives an engram has none of our files.

So an exported record must contain everything it depends on. No references to logs
the reader cannot open. No identifiers only our store can resolve.

The test is simple. Give the record to someone with no access to us, and they must
be able to answer all of this:

- who made this, and how — a person stating it, a model inferring it, a pattern
  scraping it from a document
- when
- what it was derived from
- whether they are allowed to use it
- how much to trust it

The last two are what make the record useful under rules such as the European
Union's AI Act. They are also what let another agent decide whether to accept the
memory at all.

A record that fails this test is not a provenance record. It is a note to
ourselves.

### 2.3 Three layers, and this document is only one

Provenance splits into three separate questions. This document answers one.

| Layer | The question it answers | The standard |
|---|---|---|
| **Meaning** | what came from what, and who is responsible | PROV, in this document |
| **Transparency** | can the record be quietly edited or deleted | a transparency log |
| **Availability** | can a stranger fetch the bytes | content-addressed storage |

No layer replaces another. A provenance graph with no transparency layer
describes a history that someone could rewrite without trace. A transparency log
with no provenance records that something happened, but not what led to it.

There is a live example of the second problem. The Governance Audit Record is a
draft standard at the Internet Engineering Task Force (IETF), the body that
publishes internet standards. It builds audit evidence on top of a transparency
log standard called SCITT. Its authors had to add two extra fields to track cause
and effect. In their words, SCITT is *"artifact-centric with no inherent
causality"*. It records items, not what led to what.

PROV already handles cause and effect. That is why this document starts with
meaning rather than transparency.

### 2.4 Reuse before invention

Where PROV-AGENT already has a name for something, we use it. Where PROV already
has a relationship, we use it rather than inventing a synonym. We add our own
names only for things specific to memory. Those are scope, commitment, activation,
and the kinds of claim in section 4.5.

---

### 2.5 Adding fields for a particular field of work

Later we will record provenance for particular domains. A medical dataset, a land
registry, a supply chain — each has facts worth recording that mean nothing to the
others.

The standard already allows this, and our own Engram Standard follows the same
principle: unknown fields survive a round trip untouched.

Four rules keep it safe:

1. A domain adds fields under **its own prefix**, never `engram:` or `prov:`.
2. A domain **never redefines** an existing term to mean something else.
3. A reader **must keep** fields it does not recognise, and must not fail on them.
4. A reader **must not** treat an unrecognised field as trustworthy.

So a land-registry record might add `geo:parcelId` beside the core fields. A reader
that knows nothing about land registries still reads the core record correctly, and
passes the extra field along untouched.

---

## 3. Names and identifiers

Every name in a PROV record needs a prefix. The prefix tells software which
vocabulary the name belongs to.

| Prefix | Stands for |
|---|---|
| `prov:` | the W3C provenance vocabulary |
| `engram:` | this document |
| `pa:` | the PROV-AGENT vocabulary |
| `odrl:` | a licence vocabulary, explained in section 8 |
| `xsd:` | standard data types, such as dates |

Identifiers are built the same way every time:

```
engram:ENG-2026-0819-021              an engram as it stands now
engram:ENG-2026-0819-021/v3           one particular version of it
engram:act/EVT-1755600000-a4f21c      something that happened, from a log event
engram:agent/user/<name>              a person
engram:agent/software/<tool>@<ver>    a tool
engram:episode/EP-1755600000-x7k2     a session record
engram:pack/<name>@<version>          a pack
```

---

## 4. The mapping

### 4.1 An engram is a thing

In PROV terms, an engram is an entity.

| Engram field | Becomes | Notes |
|---|---|---|
| `id` | the identifier | |
| `statement` | `prov:value` | may be left out when sharing a record privately |
| `content_hash` | `engram:contentHash` | already exists |
| `type` | `engram:engramType` | |
| `scope` | `engram:scope` | |
| `commitment` | `engram:commitment` | how firmly the belief is held |
| `status` | `engram:status` | section 6.2 covers retired records |
| the earliest write time | `prov:generatedAtTime` | read the warning below |
| `provenance.license` | `odrl:hasPolicy` | see section 8 |
| `derived_from`, `abstract` | `prov:wasDerivedFrom` | |
| `relations.supersedes` | `prov:wasRevisionOf` | see section 6.1 |
| `episode_ids` | `prov:wasDerivedFrom` a session | |

> **A warning about time.** The obvious field to use is `temporal.learned_at`.
> Do not rely on it. On ordinary engrams it is missing. The code that builds it
> returns nothing unless someone supplied an expiry date
> (`packages/core/src/expiry.ts:139-149`). Use the earliest entry in `sources[]`
> instead.

**Filling in the four dormant fields.** This document finally gives them a
meaning.

| Field | What it should hold |
|---|---|
| `origin` | one address naming where this came from, such as `session:<id>` |
| `chain` | the ancestors, nearest first |
| `license` | an address pointing at a machine-readable licence |
| `signature` | unchanged: still set aside, still always empty |

Treat `chain` as a shortcut, not as the truth. Rule 1 of section 2.1 still
applies. The history log wins.

### 4.2 Versions

An engram changes in place. A counter goes up. On one code path, a pointer to the
previous version is written.

This document treats each version as a separate thing:

```
engram:ENG-…/v3   was a revision of   engram:ENG-…/v2
```

The reason is simple. A statement that has been rewritten is not the same thing
as the one it replaced. Without separate versions, a revision looks identical to
an unrelated derivation.

### 4.3 Log events become activities

Each event in the history log becomes one activity. This vocabulary was not
invented. It was already there, in the list of event types the code writes.

| Log event | Activity | Main relationship |
|---|---|---|
| `engram_created` | learning | generated the engram |
| `engram_updated` | revising | was a revision of |
| `engram_merged` | consolidating | derived from several parents |
| `engram_promoted` | promoting | derived from a session |
| `procedure_evolved` | revising | was a revision of |
| `engram_retired` | retiring | **was invalidated by** |
| `recurrence_detected` | recurring | scope widened, belief strengthened |
| `contradiction_detected` | detecting a conflict | see section 6.3 |
| `feedback_received` | receiving feedback | see section 7.2 |
| `engram_decremented` | dereferencing | **not** invalidation — see section 6.2 |
| `co_injection` | injecting | used these engrams |
| `injection_outcome` | recording an outcome | links a verdict to an injection |

`engram_decremented` matters more than its size suggests. Forgetting an engram
reduces a reference count and only retires it at zero, so a reduction that is
mapped to retirement reports a memory as withdrawn when it is still believed.
It gets its own activity for that reason, and it is never `prov:wasInvalidatedBy`.

**Events with no activity.** Some events the code writes are deliberately not
mapped: re-scoping, near-duplicate detection, duplicate absorption, a session
scope change, a reported failure. They are bookkeeping about where an engram
sits, not steps in how it came to be. An implementation MAY map them under its
own prefix; it MUST NOT invent `engram:` names for them, and a reader MUST NOT
treat their absence as evidence nothing happened.

Some event types are declared in the code and never written at all. Do not invent
activities for those either. An activity in a record should mean the event
occurred, and a vocabulary entry for something nothing emits is a promise the log
cannot keep.

### 4.4 Who is responsible

There are four kinds of agent.

| Kind | Example |
|---|---|
| a person | the user who stated or corrected something |
| an agent runtime | the assistant that called the learn tool |
| a model | the model behind a decision |
| a tool | an extractor or importer, with its version |

Responsibility passes up the chain:

```
the extraction tool   acted on behalf of   the person who ran it
```

**When nobody is identified.** Our memory engine often runs with no identity
configured, so this is the common case, not the exception.

| Situation | What to write |
|---|---|
| an identity is configured | that identity |
| none is configured | a fixed address meaning *nobody was identified* |
| the software that wrote it | always recorded, since we always know our own name and version |

Write the *unidentified* marker rather than leaving the field out. Leaving it out
is ambiguous. A reader cannot tell whether nobody was identified, or whether the
record simply predates us capturing identity at all. The marker says we looked and
found nobody.

**Never take the identity from the operating system account.** That would write a
personal name by default, without anyone choosing to share it.

The identity is set in the configuration file. It may be overridden for a single
write. Any address is acceptable: a local name, a Decentralized Identifier, or an
identifier for a running process.

Note that the software is always known. So even an unidentified record still says
*what* wrote it, and that the software acted for someone unnamed.

**A large gap.** No actor is recorded today. Log events have no field for one.
Engrams have no author field. The enterprise server does record a creator. That
field is then dropped when the client reads the record back
(`packages/core/src/store/remote-store.ts:99-113`). Until section 10.1 is done, a
tool building this view has to guess the agent from a text field. When it guesses,
it must mark the guess as a guess.

### 4.5 What kind of claim is this

The 2026 survey asks for four kinds of record to be told apart. Our repository
extraction tool already uses similar words. We reuse them rather than invent new
ones.

| Kind | What it means | Typical source |
|---|---|---|
| `observed` | a plain record of something that happened | a captured session |
| `documented` | taken from prose a human wrote | a document, or a text match |
| `structural` | read off the shape of a thing | a repository layout |
| `asserted` | stated outright by a person or agent | a direct learn call |
| `inferred` | worked out by a model from other engrams | consolidation |
| `revised` | a rewrite of an earlier version | a correction |

This is the most useful single field for anyone deciding how much to trust a
memory. Today it cannot be recovered for most engrams.

**It has to be visible where the memory is used, not only in the record.**

A provenance record is an artifact somebody asks for. Nobody asks for one
mid-session. So a claim class that lives only in the record does not reach the
moment it exists for — the moment an engram is put in front of a model as
context.

This was reported from outside, against a working implementation: *"a memory
surfaced in context with nothing distinguishing something the user explicitly
stated from something an earlier consolidation pass inferred, and the agent
treated both as equally authoritative because nothing in the record said
otherwise."*

An implementation that captures `claim_class` and does not surface it at
injection has not delivered this section. At minimum, a memory whose class is
`inferred` — worked out by a model, with nothing else standing behind it — MUST
be distinguishable from one a person stated, in whatever form the context is
rendered.

Marking every class is not required and is probably wrong: `documented` and
`structural` were extracted from something real that can be checked, and a marker
on statements that need no caveat is noise, which is how markers stop being read.

---

## 5. Every way an engram is born

Paths marked with a dagger (†) lose information today. Section 10 says what is
missing.

| # | How it starts | Kind of claim |
|---|---|---|
| 1 | someone states it directly | asserted |
| 2 | an agent summarises at the end of a session † | inferred |
| 3 | a captured session is promoted into an engram | observed |
| 4 | a text pattern matches a document † | documented |
| 5 | a tool reads a code repository | structural |
| 6 | a model is asked to state what it knows | inferred |
| 7 | a near-duplicate is rewritten † | revised |
| 8 | two records are merged † | inferred |
| 9 | a pattern is drawn from several engrams | inferred |
| 10 | a pack is installed † | whatever the pack said |
| 11 | records are imported from another system † | whatever that system said |
| 12 | a review comment becomes a correction | documented |
| 13 | the same thing is learned again in another scope | unchanged |
| 14 | one engram replaces another | revised |
| 15 | a plugin captures it in the background † | varies, see section 5.2 |
| 16 | a framework adapter writes it † | inferred |
| 17 | something is written straight to the server † | unknown |

### 5.1 Notes on particular paths

**Path 2 has the most engrams and the least provenance.** The session identifier
is passed into the very tool call that creates the engram. It is used two lines
later. It is not passed to the code that writes the engram
(`packages/mcp/src/tools.ts:2164`). Fixing that one line would give most engrams a
session to point at.

**Path 4 keeps nothing.** It stores neither the text it read nor which pattern
matched. An engram extracted this way looks exactly like one a person typed.

**Path 5 already does this properly.** The repository extraction tool writes an
origin and a chain. It keeps a receipt for every run, naming the model, the prompt
and a hash of that prompt. It records a typed reason for every row it drops. It
replaces names with pseudonyms through one shared function. All of that is then
thrown away at the network boundary. See section 10.4.

**Path 10 attaches nothing to the engram.** The pack name, version and creator
live in a separate registry file. Nothing records who installed a pack, or when.

**Path 17 is the only path with a real recorded author.** That author is erased in
transit, before the client ever sees it.

### 5.2 One label, three different kinds of claim

Path 15 is the clearest argument for section 4.5. The editor plugin writes engrams
from five different triggers. Today they are told apart only by a short text
label.

| What triggered it | The label | What kind of claim it really is |
|---|---|---|
| the user corrected the agent mid-turn | `openclaw:ingest` | asserted |
| the conversation was compacted | `openclaw:compact` | inferred |
| the model reported what it had learned | `openclaw:self-report` | inferred |
| a text pattern matched after a turn | `openclaw:afterTurn` | documented |
| the user ran the save command | `openclaw:slash` | asserted |

Three different kinds of claim. The distinction that matters most is between *the
user said this* and *the model claims it learned this*. Right now that survives
only as a text prefix, which every reader has to decode.

Each of these also throws away the confidence score that decided whether to write
at all. Each has the session identifier in hand, and does not pass it on.

---

### 5.3 A pack has provenance too

A pack is how engrams leave one machine and reach another. So a pack needs a record
of its own, not only one record per engram inside it.

In standard terms a pack is a thing, assembling it is something that happened, and
the pack contains the engrams as members.

A pack-level record answers a question no single engram can:

> Is this pack worth anything?

It carries who assembled it, when, and out of what. From the engrams inside it, a
reader can also see:

- how many were stated by a person, and how many were inferred by a model
- what dates they span
- whether every engram carries a licence, or only some

Two packs of the same size are not equal. One may be direct statements from a named
expert. The other may be machine guesses from an unnamed source. Without a record
they look identical from the outside.

Everything from here to the end of this section is what an implementer needs. It
is written out because a pack is the one artifact that crosses between parties,
so two implementations disagreeing about it is not a cosmetic problem.

#### 5.3.1 Where the files go

A pack that carries provenance ships a `provenance/` directory beside the files
the Engram Standard already defines (its §5.1):

```
<pack-name>/
├── SKILL.md
├── engrams.yaml
├── INTEGRITY
└── provenance/
    ├── pack.jsonld            one record for the pack as a whole
    └── <engram-id>.jsonld     one record per engram, named by its identifier
```

Section 9 of this document describes a single file, because it was written with
one engram in mind. A pack needs one record per engram plus one for the pack, so
the layout above is what applies to packs. Both forms are the same JSON-LD.

A pack SHOULD declare the directory in its manifest, as `metadata.provenance:
true` (Engram Standard §5.2), so a reader can tell without probing the
filesystem. The declaration is written by the producer and is inside the §5.5
integrity hash, unlike the records themselves — but it is still a claim, not
evidence. A reader MUST verify that the directory exists and that the records
parse before relying on any of it, and MUST NOT treat an absent declaration as
proof that no records are present.

#### 5.3.2 Which engrams a pack record may describe

**Only the engrams the pack actually ships.** A producer excludes engrams under
the export privacy rule (Engram Standard §5.4) — private ones, and any whose
content trips a secret scan. Those exclusions MUST apply to the provenance
records as well.

This is not a detail. A provenance record names an engram, its claim class, its
content hash and often who asserted it. Writing a record for an engram the
content path refused would leak, through the provenance directory, exactly what
the privacy scan was there to hold back. **Provenance must never become a second
way to ship something the content path already refused.**

Nor may the pack record's counts include them. A count over the excluded set
would tell a recipient how many memories were withheld, which is itself a
disclosure.

#### 5.3.3 Which way the integrity dependency runs

The pack integrity hash covers `SKILL.md` and `engrams.yaml` only (Engram
Standard §5.5). Files under `provenance/` are therefore **not** covered by it,
and adding them to the hash would be a breaking change to a stable section.

So the dependency runs the other way round. **The record commits to the pack;
the pack does not commit to the record.** The pack record carries the pack's
integrity value in `engram:packIntegrity`, so:

- change the pack, and the value recorded in the provenance record stops
  matching what the pack now hashes to — the mismatch is detectable
- change the provenance record alone, and nothing detects it

An implementation MUST NOT present a provenance record as evidence of the pack's
integrity. It is a description that happens to name the hash. The `INTEGRITY`
file and the install registry remain the authority, and the section 10.6
argument applies here in full: this becomes proof only when an outside party
holds a checkpoint the producer cannot reach.

Ordering follows from this: compute the pack hash first, then build the record.

#### 5.3.4 The pack record

One bundle, one pack entity, one assembly activity, and a shallow stub for every
member so the record has no dangling reference.

**The bundle**

| Field | Value |
|---|---|
| `@id` | `engram:record/pack/<name>@<version>` |
| `@type` | `["prov:Bundle", "prov:Entity"]` |
| `prov:generatedAtTime` | when the record was made, not when the pack was assembled |
| `engram:describes` | the pack identifier |
| `engram:recordIsSelfContained` | always `true` for a pack — the recipient has none of the producer's files |

**The pack**

| Field | Holds |
|---|---|
| `@id` | `engram:pack/<name>@<version>` (section 3) |
| `@type` | `["prov:Entity", "prov:Collection", "engram:Pack"]` — a collection, because that is what PROV calls a thing with members |
| `engram:packName`, `engram:packVersion` | the manifest name and version |
| `prov:generatedAtTime` | when the pack was assembled |
| `prov:wasGeneratedBy` | the assembly activity below |
| `prov:hadMember` | one entry per engram shipped |
| `engram:engramCount` | how many members |
| `engram:packIntegrity` | the pack's `sha256:` value, per section 5.3.3 |
| `engram:license` + `odrl:hasPolicy` | the licence in the pack's own manifest, mapped by section 8. See below — this is not the same question as the licences inside |
| `prov:wasAttributedTo` | who assembled it, when a creator is recorded. Omitted otherwise — never guessed |

**A pack's licence and its engrams' licences are two different questions, and
neither overrides the other.**

The distinction is not academic. A single engram is one short assertion. A pack
is a curated collection, and a collection attracts rights in its own right — the
selection and the arrangement, and in the European Union the sui generis database
right. So the pack's licence is the one a recipient asks about first, and it is
the one an engram-by-engram record cannot answer.

The two can disagree without anybody doing anything wrong: an MIT-licensed pack
of share-alike engrams is an ordinary thing to assemble by accident. A record
MUST NOT resolve the disagreement, because it has no standing to. It states both
and says which governs what: the pack licence covers the collection, each
engram's licence covers its own content, and a reuser has to satisfy both. When
they differ, the record marks it with `engram:memberLicensesDiffer` so a reader
does not have to compare the lists to notice.

**A producer MUST NOT export a pack without a chosen licence.**

This is the one field where "not recorded" is not an available answer. Every
other unset field degrades honestly to silence; a licence does not, because the
manifest schema supplies `cc-by-sa-4.0` on parse. Silence therefore does not
produce silence — it produces a share-alike grant, over other people's memories,
to whoever receives the pack, attributed to an author who never agreed to it.
Refusing to export is the only way not to do that quietly.

A licence set once in configuration satisfies this. It is a decision made in
advance, not an absence of one, and the record says which it was (section 8.4).

`unlicensed` is an acceptable value and is itself a choice: it states plainly
that no grant is being made. That is a different act from leaving the field out,
and the record must not conflate them.

Members with no licence of their own inherit the pack's, marked
`inheritedFromPack` — see section 8.4 for why that is inheritance rather than
application.

**What a reader can judge before opening a single engram.** These are summaries
over the members, and they are the reason a pack record exists at all.

| Field | Holds |
|---|---|
| `engram:claimClassCounts` | a count per claim class (section 4.5). Engrams with none are counted under `unstated`, so the total always equals `engram:engramCount` and a reader can see how much of the pack is unclassified |
| `engram:licenseChosenCount` | how many engrams carry a licence somebody actually picked |
| `engram:licenseDefaultedCount` | how many carry the schema default instead (section 8.4) |
| `engram:licensesChosen` | the distinct chosen licences, sorted. The default is deliberately NOT listed here: listing it would read as "somebody licensed this pack that way" when nobody did |
| `engram:earliestEngram`, `engram:latestEngram` | the span of member dates. Omitted when no member has a date |

Two counts rather than one is deliberate. A single "licensed" count is ambiguous
between "has a licence" and "somebody chose one", and every per-engram record in
a pack carries a licence either way. A reader has to be able to tell how much of
a pack anybody actually decided about.

**The assembly**

| Field | Value |
|---|---|
| `@id` | `engram:act/assemble-<name>-<version>` |
| `@type` | `["prov:Activity", "engram:AssemblePack"]` |
| `prov:startedAtTime`, `prov:endedAtTime` | both the assembly time; a pack build is recorded as a moment, not a duration (section 11.2) |
| `prov:generated` | the pack |
| `prov:wasAssociatedWith` | the creator, when one is recorded |

**The members**, deliberately shallow — the per-engram files carry the detail,
and repeating it here would double the pack's provenance for nothing:

| Field | Holds |
|---|---|
| `@id` | `engram:<id>` |
| `@type` | `["prov:Entity", "engram:Engram"]` |
| `engram:engramType` | the engram's type |
| `engram:claimClass` | when recorded |
| `engram:contentHash` | when recorded — this is what ties the stub to the engram in `engrams.yaml` |

#### 5.3.5 The per-engram records inside a pack

Built exactly as sections 4 and 6 specify, with two constraints that follow from
a pack crossing to a stranger:

1. **Portable mode, always.** A pack record names no other engram, carries no
   session identifier, and refers to nothing the recipient cannot resolve
   (section 2.2). A local-mode record inside a pack is a defect.
2. **No history activities.** The history log does not travel with the pack, and
   a record that referenced it would fail the standing-on-its-own test. What the
   engram itself carries — its licence, claim class, attribution, revision links
   — travels; the log-derived activity list does not.

A worked pack record built by the reference implementation is in
`spec/examples/example-pack.jsonld`. Where this section and that file disagree,
the file is the one that has been checked against outside tools — say so in an
issue rather than guessing.

---

## 6. How an engram changes over time

### 6.1 Replacing one engram with another

`supersedes` becomes "was a revision of". That is a special kind of "was derived
from". So a reader that only understands derivation still sees the link.

The reverse link is a convenience we store for speed. Do not write it out as a
separate relationship. It can always be worked out.

> **Known limitation.** The reverse link is written only in the main local store.
> Targets in other stores are never updated. A one-sided link is normal, not
> corruption. A reader must cope with it.

Replacement today carries **no time, no reason and no actor**. So nothing tells
you whether an engram was replaced because the world changed, or because the old
statement was simply wrong. That difference matters to anyone auditing a belief.

### 6.2 Retiring an engram

A retired engram becomes one that "was invalidated by" a retiring activity, along
with the time it happened.

This relationship is what makes a memory system auditable. Without it, a record
nobody believes any more looks the same as a record that never existed.

Two behaviours matter here.

**Retirement is counted.** Forgetting an engram reduces a reference count. The
engram is only retired when that count reaches zero. A reduction is not
invalidation.

**Compacting deletes the text for good.** After a compaction, a retired engram is
gone from the engram file. It survives only in the history log. A reader must
still describe it, because this is exactly the case where provenance earns its
keep. It must also mark the record as compacted, because the statement itself
cannot be recovered.

One more gap. The tool that forgets an engram never passes a reason. Every
retirement done this way records an empty reason.

### 6.3 Conflicts

A conflict record becomes an activity linking the two engrams. It carries a copy
of both statements as they read at the time.

Those copies exist because either engram may be edited or retired later. That
makes a conflict record a small piece of provenance in itself. It is the only
place in the system that keeps a statement exactly as it was at a moment in time.

### 6.4 Ways a record can be made to disappear

The Governance Audit Record draft sets a high bar. The component that writes audit
records must write them automatically. It must sign them. It must not let anything
delete or change them.

Measured against that bar, an engram store has two ways to make records vanish.

| What | Effect |
|---|---|
| compacting | permanently deletes retired engrams from the engram file |
| purging conflicts | clears conflict links from every local store, with no log entry and no backup |

Both are deliberate features. The first keeps files from growing forever. The
second clears a list of conflicts already dealt with.

Both also mean this. **Do not present this view as evidence nobody can suppress.**
It is a description. It is exactly as trustworthy as the log beneath it. A good
implementation writes a log entry for each of these actions, so that even
suppression leaves a trace.

---

## 7. Being used, not just being made

The 2026 survey asks for more than origin. It asks which memories were used, in
what context, and what they went on to affect.

### 7.1 Injection

When engrams are selected and put in front of a model, the system already logs
which ones. It also logs a hash of the request, rather than the request text.
Keep it that way. Do not try to reconstruct the text.

**A record you send must not name the other engrams.** The log lists every memory
injected together. Copying that list into a shared record would tell the recipient
the identifiers of other memories the sender holds.

Name only the engram the record is about. Give a count of the others.

We found this by building a worked example from a real store. A record for one
engram would have disclosed five others. This is a privacy rule, not a formatting
preference.

### 7.2 Outcome

Feedback links a verdict back to the injection that came before it.

One existing rule must be preserved. Being ignored is recorded as the *absence* of
an outcome. The system never writes an "ignored" entry. So absence is not evidence
of rejection, and a reader must not treat it as one.

Positive feedback quietly strengthens a belief. It moves that belief one step up a
scale. Nothing records who gave the feedback. A belief hardens and the record does
not say why.

---

## 8. Making reuse checkable

Every engram already carries a licence. It defaults to Creative Commons
Attribution-ShareAlike 4.0, usually written BY-SA 4.0.

Today that licence is only a label. Software can display it. Software cannot act
on it.

This document writes the licence as a machine-readable policy instead. It uses a
web standard called the Open Digital Rights Language (ODRL). An agent can then
check whether a proposed use is allowed, without a person reading the licence
first.

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

There is a proven precedent. Croissant is a format for describing datasets, from
MLCommons, an industry group for machine-learning standards. Its 1.1 release, in
February 2026, pairs PROV for lineage with ODRL for permissions. Over 700,000
datasets use it. Their stated goal is that agents can "automatically verify
whether a proposed use is permitted."

This is what turns an engram from merely traceable into genuinely reusable.

### 8.2 The licence mapping

These are the licence names we use, and what each becomes. Every term below was
checked against the published vocabulary file, not guessed.

| Licence name | Permits | Requires | Forbids |
|---|---|---|---|
| `cc-by-4.0` | use, reproduce, distribute, derive | attribute | — |
| `cc-by-sa-4.0` *(the schema default)* | use, reproduce, distribute, derive | attribute, shareAlike | — |
| `cc-by-nc-4.0` | use, reproduce, distribute, derive | attribute | commercialize |
| `cc-by-nd-4.0` | use, reproduce, distribute | attribute | derive |
| `cc-by-nc-sa-4.0` | use, reproduce, distribute, derive | attribute, shareAlike | commercialize |
| `cc0-1.0` | use, reproduce, distribute, derive | — | — |
| `apache-2.0` | use, reproduce, distribute, derive | attribute | — |
| `mit` | use, reproduce, distribute, derive | attribute | — |
| `isc` | use, reproduce, distribute, derive | attribute | — |
| `bsd-2-clause` | use, reproduce, distribute, derive | attribute | — |
| `bsd-3-clause` | use, reproduce, distribute, derive | attribute | — |
| `mpl-2.0` | use, reproduce, distribute, derive | attribute, shareAlike | — |
| `lgpl-3.0` | use, reproduce, distribute, derive | attribute, shareAlike | — |
| `gpl-3.0` | use, reproduce, distribute, derive | attribute, shareAlike | — |
| `agpl-3.0` | use, reproduce, distribute, derive | attribute, shareAlike | — |
| `unlicense` | use, reproduce, distribute, derive | — | — |
| `proprietary` | — | — | use, reproduce, distribute, derive, commercialize |
| anything else | — | — | see section 8.3 |

Names are matched case-insensitively after trimming. The share-alike mapping for
the copyleft software licences is a *summary of the reciprocity obligation*, not
a claim that they are interchangeable with a Creative Commons ShareAlike term —
section 8.3's rule that the licence text is authoritative is what carries the
difference.

**`proprietary` is not a licence**, and the record must not treat it as one it
failed to recognise. It is a recorded decision to withhold permission: understood
perfectly, and the answer is no. It is the one entry with **no `odrl:uid`**,
because there is no licence text to follow — a reuser has to ask a person. An
implementation that routes it through the unrecognised branch produces the same
permissions and the opposite impression, and a reader acts on the impression.

Written out, our default looks like this:

```json
{
  "odrl:hasPolicy": {
    "@type": "odrl:Set",
    "odrl:uid": "https://creativecommons.org/licenses/by-sa/4.0/",
    "odrl:permission": [{
      "odrl:action": [
        "odrl:use", "odrl:reproduce", "odrl:distribute", "odrl:derive"
      ],
      "odrl:duty": [
        { "odrl:action": "odrl:attribute" },
        { "odrl:action": "odrl:shareAlike" }
      ]
    }]
  }
}
```

A licence that forbids something adds a prohibition beside the permission:

```json
"odrl:prohibition": [{ "odrl:action": "odrl:commercialize" }]
```

### 8.3 The policy is a summary, not the licence

This matters, and it must be repeated wherever the mapping is used.

**The licence text is authoritative. The policy is a machine-readable summary of
it.** If the two ever disagree, the licence wins.

So the policy always carries the canonical licence address in `odrl:uid`. A reader
that wants certainty follows that address and reads the licence. A reader that
wants a quick automated check uses the permissions and duties.

We are not translating law. We are giving software enough to make an obvious call
quickly, and a pointer to follow when the call is not obvious.

**Two different questions wear the word "licence", and this section answers only
one of them.**

A *copyright licence* answers "what rights do you grant me in this content?" It
is what CC-BY-SA, MIT and the rest express, and it bites only where a right
exists. That is the question section 8 maps.

*Usage terms* answer "what may I do with this memory, whatever the copyright
position?" — may it be redistributed, may a model be trained on it, may it leave
the machine at all. These bind by agreement rather than by copyright, so they
apply even to content nobody can own.

The distinction matters more here than in most places, because a single engram is
usually a short factual assertion, and facts attract little or no copyright in
most jurisdictions. So the copyright licence on a bare engram may be asserting a
right that does not exist, while the thing a user actually wants to control —
"do not pass this on", "do not train on it" — is a usage term.

ODRL expresses both; it is a policy language, not a copyright language. This
profile already relies on that: the `notShared` prohibition (section 8.4's
withheld case) is a usage term derived from scope and visibility, sitting in the
same policy as the copyright grant, and deliberately labelled with its own
reason so a reader can see it did not come from the licence.

A first-class usage-terms axis, distinct from `engram:license`, is **left open**.
It needs a vocabulary decision (ODRL has no standard action for model training)
and is not required for anything the profile currently specifies.

**An unknown licence grants nothing, and says so.** Not a permissive default,
not a guess.

An earlier draft said to emit *no policy at all*, reasoning that a guess is worse
than silence. It is — but silence is not what a reader receives. Someone testing
this pointed out the consequence: software checking policies saw a prohibition on
an MIT memory and nothing whatsoever on one marked `proprietary`, so the
proprietary one looked the **less** restricted of the two. Absence was being read
as permission, exactly backwards.

So an unrecognised licence produces a policy that expresses no permission and
says why:

```json
"odrl:hasPolicy": {
  "@type": "odrl:Set",
  "odrl:permission": [],
  "engram:licenseRecognised": false,
  "engram:note": "\"<name>\" is not a licence this software knows. No permission is expressed here. Read the licence itself before reusing anything under it. An empty permission list means nothing was determined, NOT that everything is allowed."
}
```

Still no guess. The difference is that the reader is told there is nothing here
to rely on, instead of having to infer it from a missing key.

**`engram:licenseRecognised` carries the distinction an empty permission list
cannot.** A recognised licence that grants nothing (`proprietary`) and an
unrecognised name both produce no permissions, and they mean opposite things —
"the answer is no" against "we could not tell". Every policy therefore states
`engram:licenseRecognised` explicitly, `true` or `false`.

**A grant nobody made does not answer a permission question either.** When the
licence came from the schema default — nobody chose it, at any point — the
permission answers are `false`, exactly as for a licence we cannot recognise.

Not doing this left the two failing in opposite directions: closed on a licence
we could not *recognise*, open on one nobody had *selected*. That is backwards,
since at least the unrecognised one was chosen by somebody. A record was
reporting `may_reuse_commercially: true` over a memory whose author had never
considered the question.

The JSON-LD still reports `cc-by-sa-4.0` and its policy, because §2.3 of the
Engram Standard makes a schema default part of the data model and a record has
no business contradicting it. What fails closed is the *answer to "may I?"*, not
the description. `configuredDefault` and `inheritedFromPack` answer normally — a
person decided in both cases, once in advance or once for the pack.

**This, rather than deleting the field, is how an engram stops asserting
copyright it may not hold.** Removing `provenance.license` outright would need a
major version (§10.2 of the standard forbids removing a STABLE field otherwise),
would discard licences authors deliberately chose, and would leave an engram
shared outside any pack with nothing to say at all. Making the *unchosen* case
grant nothing gets the same result — engram-level copyright becomes opt-in —
without breaking anything.

**Permission questions fail closed.** A consumer asking "may I reuse this
commercially?" gets `false` when the licence is unrecognised, never `null` and
never absent. A consumer written as `if (x !== false)` reads `null` as
permission, and for a field that gates reuse, not knowing has to mean no.
`engram:licenseRecognised` is where the difference between "no" and "we could not
tell" lives, so nothing is lost by failing closed.

Three rules for implementers. Map common licence names to policy addresses. Never
quietly widen the terms of a licence you do not recognise. Never let an absent
field be the only thing standing between a reader and a wrong conclusion.

---

### 8.4 A licence nobody chose

Every engram has a licence, because the schema gives it one when nobody says
otherwise. That default is not a decision anybody made, and a record must not
let the two look alike.

**There are four ways to arrive at a licence, not two.** A boolean collapsed
three of them, and the one that mattered most was a licence the user configured
once, deliberately, being reported exactly like the schema value nobody has ever
looked at.

| `engram:licenseSource` | Where it came from | Did somebody decide? |
|---|---|---|
| `chosen` | recorded on the engram itself | yes |
| `inheritedFromPack` | the pack this engram was exported inside | yes, but not about *this* engram |
| `configuredDefault` | the author's configured default (`provenance.default_license`) | yes — once, in advance |
| `schemaDefault` | `cc-by-sa-4.0`, from the schema | **no** |

Precedence runs down that table: the engram's own licence beats the pack's, which
beats the configured default, which beats the schema.

```json
"engram:license": "cc-by-sa-4.0",
"engram:licenseSource": "schemaDefault",
"engram:licenseIsDefault": true,
"engram:licenseSourceNote": "Nobody chose this licence at any point. …"
```

`engram:licenseIsDefault` is retained beside the four-state field, set whenever
the source is not a decision. A reader that only understands the boolean still
gets a correct, coarser answer instead of a wrong one.

**Inheritance is not application.** A pack licence is granted by whoever
assembled the pack, who may not hold rights over every engram in it — one may
quote somebody else's documentation. So a member with no licence of its own is
recorded as *inheriting*, never as having chosen. A record that flattened the two
would attribute a grant to an author who never made one.

The policy is still written out, because the default genuinely does apply. What
changes is that a reader can tell the difference, and a summary can list the
missing choice alongside everything else nobody recorded.

**Why this field exists at all.** The licence is the only field in a record with
legal weight. It was also the only invented one — a schema default printed among
recorded facts, under a footer promising that nothing was guessed. A reader who
trusts the footer draws exactly the wrong conclusion. Marking the default is
cheaper than the alternative, which is not printing it.

**A licence is not permission to share.** It governs what a recipient may do
with content they already hold. Whether the memory may be passed on at all is a
different question, decided by scope and visibility, and engrams are private
unless someone says otherwise. Any presentation of a licence has to keep those
two questions apart. Readers merge them otherwise, and the merge always fails in
the same direction: towards sharing something private.

---

### 8.1 What a recipient can decide from the record

Two questions matter to whoever receives an engram. The record should answer both
without a conversation.

**May I use this?** Answered by the licence, written as a policy (section 8).

**How much should I trust it?** Answered by four fields together:

| Field | What it tells the reader |
|---|---|
| claim class | whether a person stated it, or a model guessed it |
| who asserted it | a named party, or nobody at all |
| commitment | how firmly the original holder believed it |
| what it was derived from | whether the chain leads to a real source |

None of these is a score, and the document deliberately does not compute one. A
recipient weighs them for themselves. But a memory that was inferred by an unnamed
model from an unknown source should look different, at a glance, from one a named
person stated outright. Today those two look identical.

---

## 9. How to write it out

Write records as JSON-LD, the JSON form of the provenance vocabulary, in files
with a `.jsonld` extension.

Do not use PROV-JSON, an older and simpler format. JSON-LD is what the surrounding
ecosystem reads.

**One record per file, and one file per thing described.** An earlier draft said
to save a record in "a file named `provenance.jsonld`", which works for a single
engram and cannot hold a pack's worth of records. Where the files go:

| What | Where |
|---|---|
| a record for one engram, inside a pack | `provenance/<engram-id>.jsonld` (section 5.3.1) |
| a record for the pack itself | `provenance/pack.jsonld` (section 5.3.1) |
| a record kept in your own store | implementation's choice, but records for one engram MUST accumulate rather than overwrite — a record is a snapshot of state that keeps changing, so a later one does not make an earlier one wrong (section 2.1). The reference keeps a timestamped series per engram |
| a record sent on its own | any filename; it stands alone by construction (section 2.2) |

Do not overwrite a record with an identical one. Two records that differ only in
their own generation time say the same thing twice, and a directory of those
teaches a reader to distrust the series.

A saved record must say when it was made, and how much history it covers:

```json
{ "@id": "engram:record/ENG-2026-0819-021",
  "@type": ["prov:Bundle", "prov:Entity"],
  "prov:generatedAtTime": { "@value": "2026-08-20T09:00:00Z", "@type": "xsd:dateTime" },
  "engram:describes": { "@id": "engram:ENG-2026-0819-021" },
  "engram:recordIsSelfContained": true,
  "engram:historyEvents": 4,
  "engram:historyThrough": "2026-08" }
```

**Why the history coverage has to be there.** Without it, a record built from a
complete log and a record built from a log that was rotated, truncated, or never
consulted are the same document. "No retirement recorded" then reads as "not
retired", when it may only mean "we did not look that far back" — and that is
precisely the reading a provenance record exists to prevent.

`engram:historyThrough` is the month of the newest event the record was built
from, matching the `history/YYYY-MM.jsonl` files it is read out of.
`engram:historyEvents` is how many were used.

When no events were consulted, `engram:historyEvents` is `0` and
`engram:historyThrough` is **omitted rather than filled in**. Describing the
engram alone is a different claim from covering a period and finding nothing in
it, and a record must not blur the two. A pack record always reports `0`: the
history log does not travel with a pack (section 5.3.5).

A bundle is itself a thing in PROV terms. That is what lets you describe, sign or
anchor the provenance record later.

---

## 10. What has to be captured first

This view is only as good as what goes into it. Below is what is missing. Each
item can be done on its own.

### 10.1 Who did it — DONE for the author; the log still has no actor

**What now happens.** An identity is a single address held in configuration
(`provenance.identity`). Any form: a local name, an email, a Decentralized
Identifier, an identifier for a running process. Every write records one of
three things in `attribution.asserted_by`:

| Situation | Recorded |
|---|---|
| the caller passed one for this write | that value — a per-engram override, for recording something on somebody else's behalf |
| an identity is configured | that identity |
| neither | the `unidentified` marker, written out rather than omitted |

`attribution.runtime` is recorded on **every** write without exception, because
software always knows its own name. A caller that also knows its version
supplies both.

Three rules an implementation MUST follow.

**Never derive an identity from the operating system account.** It is the
obvious value and the wrong one: it writes a real person's name into shared
records because they installed software, not because they chose to be named.

**The marker is recorded information, and it is not an answer.** `unidentified`
says we looked and found nobody — genuinely different from an absent field,
which cannot be told apart from a record predating identity capture. But it does
not say who is answerable, so a summary MUST still count it among what was not
recorded. Otherwise, once every engram carries the marker, a memory nobody is
accountable for reports itself complete.

**Changing an identity MUST NOT rewrite existing records.** Memories keep
whoever was recorded when they were written. Rewriting them to match a later
decision is editing history, and recording who said what is the entire point.

**It is self-asserted.** Nothing verifies it, packs are not signed, and no
surface may present it as though something did. The reference reports
`identity_stated`, deliberately not `identity_known`, because a tester read the
latter as verification and it returned true for a name they had invented.

**Log events carry an actor too.** A history event records who caused it, in the
same shape as the engram's `attribution`, and a record MUST prefer it over the
engram's when building the activity's `prov:wasAssociatedWith`.

They answer different questions, and merging them answers neither. An engram
asserted by one person and retired by another has two answers; a record that
uses the engram's attribution for both shows the retirement associated with the
asserter — the correction attributed to the person it corrected.

An implementation SHOULD stamp the actor in one place rather than at each event
site. The reference has 28 of them, and a policy applied at 28 call sites is one
that will be missed at the 29th.

Events written before the field was populated carry no actor. A reader MUST fall
back to the engram's attribution for those, and MUST NOT treat the absence as
meaning the asserter caused the event.

### 10.1.1 The original analysis

Nothing records an actor. Not the log, not the engram. This is the biggest gap.
Without it, every statement about responsibility is a guess.

Do not invent the shape. A published field list already exists, from work on
signed action records. It maps onto PROV cleanly.

| Their field | Becomes |
|---|---|
| agent identity | the agent's identifier |
| runtime name, version, model, tool digest | the software agent and the model |
| delegation reference | acted on behalf of |
| input and output digests | the identity of the thing |
| parent action | was informed by |

Two of their rules are worth copying word for word. **Store hashes, not
payloads**, and keep anything sensitive under a stated retention policy.
**Identify the running process, not a shared account.** If every action
authenticates as the same long-lived account, attribution collapses.

### 10.1.2 The derivation chain

`provenance.chain` holds the ancestors of an engram, nearest first. It was the
last of the four origin fields that nothing read and nothing wrote.

It is a **shortcut, not the truth**. Section 2.1 governs: where the chain and the
history log disagree, the log wins. It exists so a reader can see lineage without
walking a log they may not have — which is the normal case for a portable record.

Three rules.

**Nearest first, replacements before derivations.** An engram that replaces B,
which was derived from A, has B as its immediate ancestor.

**Bounded and cycle-guarded.** Supersession is acyclic by construction, but a
chain assembled from a store somebody can hand-edit must terminate regardless.
The reference visits nothing twice and stops at 32.

**Incomplete is allowed.** A chain built where ancestors are not to hand is
shorter, not wrong. That is what makes the log authoritative rather than the
chain.

### 10.2 Version history — required for section 4.2

Only one code path records a pointer to the previous version. The two most common
paths increase the version counter without it. So the chain of revisions is
already broken.

### 10.3 Reasons — recommended

Almost nothing records why. Not forgetting, not pinning, not promoting, not
replacing. Only two places write a reason at all.

### 10.4 What survives the network — required for sharing

When an engram is sent to a server, **four fields go**: the statement, the scope,
the domain and the type. Everything else is destroyed, including all provenance.

The repository extraction tool shows the right behaviour. It sends the whole record
on purpose. It then *reports* which fields the far end dropped, rather than
trimming them quietly. Its own comment explains why. Trimming first would hide the
loss.

### 10.5 Missing log entries — recommended

Several things happen with no log entry at all. Re-learning something already
known. Strengthening an engram on use. Pinning. Updating. Installing or removing a
pack. Demoting something sensitive.

Strengthening on use is the most frequent change in the whole system, and it is
invisible.

### 10.6 A history log that cannot be edited — deferred, and here is why

The history log is added to one line at a time. But it is append-only **by habit,
not by design**. There is no chain of hashes, so the file can be edited, shortened
or reordered, and nothing would show it.

An earlier draft of this document called fixing that "required before anchoring".
**That was wrong, and this section corrects it.**

Here is the flaw. A chain that one party writes from end to end is not evidence to
anybody else. Whoever can edit the log can rebuild the chain over the edit, and
nothing in the file betrays them. A chain only becomes proof when somebody else
holds a checkpoint the writer cannot reach.

So chaining inside the memory engine defends against almost nobody. The only
party it protects you from is yourself.

**The threat model starts at the boundary.** It becomes real the moment an engram
*leaves* — shared, published in a pack, sold. And at that moment the recipient is
trusting either the issuer, or an outside anchor. Local chaining buys them
nothing either way.

That points at a smaller job than the earlier draft implied:

1. record provenance properly at write time — the rest of section 10
2. at export, compute one fingerprint over the pack and its record
3. publishing that fingerprint somewhere outside is a separate, optional step

Step 3 is out of scope here, and the Swarm provenance toolkit already covers it.

Chaining is still cheap and still worth doing eventually. It catches accidental
corruption, and it gives you a single value worth anchoring. **It is simply not
the thing that has to come first.**

For the record, the mechanism, should anyone pick it up:

```
hash of entry 1 = sha256( entry 1 )
hash of entry 2 = sha256( entry 2 + hash of entry 1 )
hash of entry 3 = sha256( entry 3 + hash of entry 2 )
```

We already run this in production. The enterprise server keeps a signed, chained
audit table, verified end to end, in a table the application itself cannot bypass.
The core library does not. So it needs porting, not designing.

One limit worth stating even then. Our log is written by the same process that
changes the engram, and published guidance is to sign outside the application that
did the work. So chaining moves us from *undetectable* to *detectable by someone
holding a later hash*. On its own it does not reach proof that cannot be denied.

### 10.7 Why this engram, and not another — recommended

The log records which engrams were injected. It does not record the strength score
that caused them to be picked. So afterwards, "why was this one chosen?" cannot be
answered.

Recording the score and the rank turns a list of identifiers into an account of a
choice.

---

## 11. What does not survive the translation

### 11.1 Things an engram has that PROV cannot hold

| What | Why not |
|---|---|
| strength and decay | continuous state, not an event |
| commitment | PROV has no idea of how firmly something is believed |
| co-access links | a small cache, not provenance, by an earlier decision |
| feedback totals | only the individual verdicts survive |
| scope rules | PROV has no model of nested scopes |

### 11.2 Things PROV has that an engram cannot hold

| What | Why not |
|---|---|
| detail attached to a relationship | no field carries it |
| the plan an activity followed | not represented |
| nested graphs | an engram cannot hold one |
| several authors for one thing | there is only one author field |
| activities with a duration | log entries are single moments |

---

## 12. Worked examples

Complete, runnable examples live in `spec/examples/`. They are built from a real
engram in a real store, and checked against two outside tools.

Read those first if you are implementing this. The fragments below show single
ideas. The files show a whole record.

They come in pairs: what we can produce today, and what the same engram looks like
once the capture work has landed. The difference between the two files is exactly
the work listed in section 10.


### 12.1 Someone states something directly

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
      "engram:scope": "group:plur/plur-ai/comms",
      "engram:commitment": "leaning",
      "engram:contentHash": "sha256:9f2c…",
      "prov:generatedAtTime": {
        "@value": "2026-08-19T11:04:22Z", "@type": "xsd:dateTime"
      },
      "prov:wasGeneratedBy": { "@id": "engram:act/EVT-1755601462-a4f21c" },
      "prov:wasAttributedTo": { "@id": "engram:agent/user/maintainer" }
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
      "prov:actedOnBehalfOf": { "@id": "engram:agent/user/maintainer" }
    },
    { "@id": "engram:agent/user/maintainer", "@type": "prov:Person" }
  ]
}
```

### 12.2 A tool reads a code repository

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

The model that produced it is named too, so it can be held to account:

```json
{
  "@id": "engram:act/encode-run-2026-0803-01",
  "@type": ["prov:Activity", "engram:Learn", "pa:AIModelInvocation"],
  "prov:used": { "@id": "engram:prompt/sha256:6b1e…" },
  "prov:wasAssociatedWith": { "@id": "engram:model/gpt-5.6-sol" },
  "engram:promptVersion": "3"
}
```

### 12.3 One engram replaces another

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

## 13. A note on tooling

**Our own provenance library cannot express this yet.** We audited it on
2026-08-19. The gaps matter.

- There is **no way to say a thing was invalidated**. Section 6.2 makes that the
  most important relationship in a memory system.
- Revision and original-source links survive only as text labels. They are lost
  when a file is read back in.
- Detail attached to a relationship is declared in the types but not implemented.
- There is no way to describe a collection, so packs have nothing to map to.
- It writes only the older PROV-JSON format. It cannot write JSON-LD, which
  section 9 requires.

So it is a starting point, not a foundation. Whether to extend it or adopt an
existing library is a decision this document deliberately leaves open.

---

## 14. Decisions taken, and what is still open

The four questions below were first written too vaguely to answer. They are
restated here in plain terms, with the decision where one has been made.

### 14.1 Does each version of an engram get its own record? — decided: yes

**The question.** An engram can be rewritten. A model merges it with another, or a
failure causes the statement to be corrected. When that happens, is the result the
same engram with new text, or a new engram that replaced the old one?

**Why it matters.** If it is the same thing, we cannot say "this replaced that",
because in the standard's terms nothing was replaced. The rewrite becomes
indistinguishable from an unrelated derivation.

**Decision: treat each version as its own thing.** A statement that has been
rewritten is not the same statement. This lets the record say plainly that version
three replaced version two.

**What it needs first.** Only one code path currently records a pointer to the
previous version. The two most common paths increase the version counter without
one, so the chain is already broken. That is covered by the issue on version
history in the epic.

**The risk, stated plainly.** If we do this only where the data allows it, the
shape of the record depends on which code path happened to run. That is worse than
either consistent choice. So the version-history fix has to land first.

### 14.2 What happens to a record after the engram is deleted for good? — left open

**The question, in plain terms.** Our memory engine has an operation called
`compact()`. It
permanently removes retired engrams from the engram file to stop it growing
forever. This has nothing to do with compacting a conversation or a prompt — it is
housekeeping on our own storage.

After it runs, the engram's text is gone. Only the history log remembers the
engram existed.

**So the question is:** should a provenance record still describe a thing whose
content no longer exists anywhere? Or should compaction leave a different kind of
marker, saying "there was something here, and it is gone"?

**Left open**, because it does not block anything. The current wording says to
describe it and mark it as compacted. That is a reasonable default. Revisit it if
compaction turns out to matter in practice.

### 14.3 Should the extraction fields become real schema fields? — decided: yes

**The question, in plain terms.** When a tool extracts an engram from a document or
a repository, it records three useful things: how confident it was, which commit it
read, and which version of the extractor ran.

Those three live in `structured_data.extraction`, an untyped bag of anything. There
is a comment in the schema saying they were deliberately left out of the real
schema.

**Why it matters.** They are the closest thing to a provenance model already in the
code, and they are exactly the facts this document needs. Leaving them untyped
means nothing validates them, nothing guarantees they survive, and every reader has
to guess the shape.

**Decision: promote them to real, optional fields.** They already have a documented
shape, they are already written by the extraction tool, and this document depends
on them.

### 14.4 Should a shared record include the engram's own text? — decided: optional, and off by default

**The question, in plain terms.** Every engram has a `statement` — the actual
sentence it holds, such as "the deploy script must run before the migration".

When we send someone a provenance record, do we include that sentence, or only the
record of where it came from?

**Why it is a real question.** Sometimes the origin can be shared when the content
cannot. You might want to prove a memory came from an audited source without
revealing what it says.

**Decision: make it optional, and leave it out by default.** Including it is a
choice the sender makes each time. This is a policy setting, not a modelling
problem — the standard is happy either way.

---

## Appendix A — Other names used

| Short name | Full name |
|---|---|
| GAR | Governance Audit Record, a draft at the IETF |
| IEEE | Institute of Electrical and Electronics Engineers |
| IETF | Internet Engineering Task Force |
| MLCommons | an industry group for machine-learning standards |
| PROV-AGENT | an extension of PROV for AI agents, from a 2025 IEEE paper |
| PROV-JSON | an older, simpler way of writing PROV as JSON |
| ODRL | Open Digital Rights Language |
| PROV | the W3C provenance standard |
| PROV-O | PROV written as a web vocabulary |
| SCITT | a transparency-log standard at the IETF |
| SPIFFE | a standard for short-lived identities for running software |
| W3C | World Wide Web Consortium |

## Appendix B — Sources

| Source |
|---|
| W3C, *PROV-O: The PROV Ontology*, 2013 |
| W3C, *PROV-DM: The PROV Data Model*, 2013 |
| W3C, *ODRL Information Model 2.2*, 2018 |
| W3C, *JSON-LD 1.1*, 2020 |
| Souza and others, *PROV-AGENT*, IEEE e-Science, 2025, arXiv:2508.02866 |
| *From Agent Traces to Trust*, 2026, arXiv:2606.04990 |
| Sato and Soos, *Governance Audit Record*, IETF draft |
| Zylos Research, *Agent Identity and Signed Provenance*, 2026 |
| MLCommons, *Croissant 1.1*, 2026 |
| Regulation (EU) 2024/1689, articles 12 and 26 |

## Appendix C — How ready each part is

| Section | Topic | Status |
|---|---|---|
| 2 | provenance as a view | proposed |
| 4.1 | an engram as a thing | proposed |
| 4.2 | versions | proposed, waiting on 10.2 |
| 4.3 | activities | proposed |
| 4.4 | agents | proposed, waiting on 10.1 |
| 4.5 | kinds of claim | proposed |
| 5.3 | a pack's own record | proposed, implemented in the reference |
| 6.2 | invalidation | proposed |
| 6.4 | ways to suppress a record | background |
| 8 | licences | proposed |
| 9 | how to write it out | proposed |
| 9 | how to write it out | proposed |
| 10 | what to capture | required before any of sections 4 to 9 work |
| 10.6 | a log that cannot be edited | deferred — see the section for why |
