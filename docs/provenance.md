# Recording where a memory came from

PLUR is our memory engine for AI agents. It can record where each engram came from, and write that record in a format
other software can read.

This page is for someone using it. The full specification is
[the provenance profile](../spec/ENGRAM-PROVENANCE-PROFILE.md).

---

## What a provenance record is

A short document answering five questions about one engram:

- who made it
- how — did a person state it, or did a model infer it?
- when
- what it came from
- whether you are allowed to reuse it

It is written as JSON-LD using PROV. PROV is a published standard from the World
Wide Web Consortium (W3C) for recording where things came from. Because it is a
standard, a tool that has never heard of us can still read our records.

**A provenance record does not say a statement is true.** It says where the
statement came from. Those are different things.

---

## Asking for a record

From a session, ask for it by name or by what the memory says:

```
plur_provenance { "search": "deploys migrations" }
plur_provenance { "id": "ENG-2026-08-21-086" }
```

You get a readable answer, not a document. Add `"format": "record"` when you
actually want the JSON-LD, and `"save": true` to store it.

The tool lives behind `plur_admin`, like most of the surface — the lean profile
exposes only the eleven tools used every session, to keep the schema small.

To record provenance in the first place, pass it when you learn:

```
plur learn "Migrations run before deploys" \
  --asserted-by local:maintainer \
  --claim-class asserted \
  --source https://example.org/runbook \
  --license cc-by-4.0
```

Leave any of them out and the record says so, rather than guessing.

From a terminal:

```bash
plur provenance "deploys migrations"     # a readable summary
plur provenance ENG-2026-08-21-086       # by identifier
plur provenance "deploys" --record       # the JSON-LD document
plur provenance "deploys" --write        # save it, and print where
```

And when exporting a pack:

```bash
plur packs export my-pack --provenance
```

---

## Try it on your own memories first

Before turning anything on, see what a record looks like for a memory you already
have. This reads your store and writes nothing:

```bash
pnpm --filter @plur-ai/core try:provenance
```

It picks a recent engram, builds a record, and tells you whether a stranger
receiving it could answer the five questions. Pass an engram identifier to choose
one, or `-- --write` to save the record to a temporary file.

Expect some "NO" answers on older memories. Nothing recorded who asserted them,
so the record does not guess. That gap is what this feature closes going forward,
and seeing it is the quickest way to understand what the record is for.

---

## Turning it on

Nothing is written by default. Add this to `~/.plur/config.yaml`:

```yaml
provenance:
  generate: on_export      # never | on_export | always
```

| Mode | What happens |
|---|---|
| `never` | Nothing is written. The default. |
| `on_export` | A record is written when engrams leave, in a pack. **Recommended.** |
| `always` | A record is written every time an engram is created. |

`never` is the default for two reasons. A record per engram repeats the history
log, which already holds the same events. And a record only starts to matter when
an engram **leaves** your machine — inside your own store it defends against
almost nobody.

---

## Where records go

Under your PLUR home directory, beside the history log:

```
~/.plur/provenance/ENG-2026-08-21-001/2026-08-21T09-00-00-000Z.jsonld
```

One directory per engram. One file per record, named by the time it was written.

Records accumulate rather than overwrite. A record is a snapshot of something
that keeps changing, so a later record does not make an earlier one wrong.

---

## Building one yourself

```ts
import { Plur } from '@plur-ai/core'

const plur = new Plur({ path: '~/.plur' })

// Build a record without storing it
const record = await plur.provenanceFor('ENG-2026-08-21-001')

// Build one and store it
const reference = await plur.writeProvenance('ENG-2026-08-21-001')
```

Both take options:

| Option | Default | What it does |
|---|---|---|
| `mode` | `portable` | `portable` stands on its own. `local` may refer to your own files. |
| `includeStatement` | `false` | Include the engram's own text. |

---

## Two things the record deliberately leaves out

**Other engrams.** When PLUR selects memories, it logs all of them together. A
record about one engram names only that one, and gives a count of the others.

The reason is privacy. Copying the full list would tell whoever receives your
record the identifiers of other memories you hold. We found this while building
the worked examples: a record for one engram would have disclosed five more.

**The statement itself.** Off by default. Sometimes you can share where something
came from when you cannot share what it says.

---

## Recording who wrote something

By default PLUR records the software that wrote an engram, and nothing about you.

To record yourself as well, pass it at the point of learning:

```ts
await plur.learn('Migrations run before deploys', {
  type: 'behavioral',
  attribution: {
    asserted_by: 'local:maintainer',
    runtime: { name: 'plur-mcp', version: '0.18.0' },
  },
  claim_class: 'asserted',
})
```

`asserted_by` takes any address. A local name, a Decentralized Identifier, or an
identifier for a running process all work. The provenance standard treats an
agent identifier as an ordinary address and does not care which kind.

**PLUR never reads your operating system account for this.** That would put your
name in a shared file without you choosing to.

When nobody is identified, the record says so plainly rather than staying silent.
Silence cannot be told apart from a record written before we captured identity at
all.

---

## What kind of claim it is

`claim_class` is the most useful single field for someone deciding how much to
trust a memory.

| Value | Meaning |
|---|---|
| `observed` | a plain record of something that happened |
| `documented` | taken from prose a human wrote |
| `structural` | read off the shape of a thing, such as a repository |
| `asserted` | someone stated it outright, rather than a model working it out |
| `inferred` | worked out by a model |
| `revised` | a rewrite of an earlier version |

Without it, a statement you typed and a conclusion a model reached look
identical once stored.

It is left unset when it genuinely cannot be determined. An unset value means
"we could not tell", which is honest. Defaulting it would assert something
nobody checked.

---

## Licences

Every engram carries a licence, defaulting to Creative Commons
Attribution-ShareAlike 4.0. In a record that licence becomes a machine-readable
policy, so an agent can check whether a use is allowed without a person reading
the licence first.

To choose one, pass it when you learn:

```ts
await plur.learn('Postgres caps connections at 100 on the shared tier', {
  type: 'architectural',
  license: 'cc-by-4.0',
})
```

**A licence nobody chose is marked as such.** The default applies either way,
but a record distinguishes a licence somebody picked from one that arrived by
default, and lists the unpicked one among the things nobody recorded. The
licence is the one field here with legal weight, so it is the last one that
should quietly look like a decision.

**A licence is not permission to share.** It governs reuse of the content by
somebody who already has it. Whether you may pass the memory on at all is a
separate question, answered by its scope and visibility — and engrams are
private unless you say otherwise. A record about a private memory says this on
the licence line, because that is the line that reads like permission.

**The licence text is authoritative.** The policy is a summary of it, and every
policy carries the canonical licence address so a reader wanting certainty can
follow it.

A licence we do not recognise produces a policy that **grants nothing**, and
says so:

```json
"odrl:permission": [],
"engram:licenseRecognised": false,
"engram:note": "… No permission is expressed here. … An empty permission list
                means nothing was determined, NOT that everything is allowed."
```

Earlier this produced no policy at all, on the reasoning that a guess is worse
than silence. It is — but silence is not what a reader receives. Software
checking policies saw a restriction on a memory licensed under one of the seven
names we know, and none whatsoever on one marked `proprietary`. The proprietary
one looked the *less* restricted of the two, because an absent policy was read
as permission.

Nothing is guessed either way. The difference is that the reader is now told
there is nothing here to rely on, instead of having to infer it from a missing
value.

### Answering "may I?" without reading prose

A summary carries three values a machine can act on:

| Field | Meaning |
|---|---|
| `may_reuse_commercially` | may the content be used in something sold |
| `may_redistribute` | may the content be passed on |
| `licence_recognised` | whether either answer above is worth anything |

Each is `null` when undetermined — an unrecognised licence — and `null` must
never be treated as yes.

A fourth value answers a **different** question, and the difference matters:

| Field | Meaning |
|---|---|
| `may_leave_this_machine` | may this memory be shared at all |

That one comes from the memory's scope and visibility, not from its licence. A
private memory under a permissive licence may not be shared, and a public
memory under a non-commercial licence may be shared but not sold. Keep the two
apart: the licence governs what someone may do with content they already hold.

---

## Packs

A pack is how engrams leave your machine, so this is where provenance starts to
matter. **Every exported pack carries it, without being asked.**

```
plur packs export my-pack
```

You get a `provenance/` directory inside the pack: one file per engram, plus one
for the pack itself. Pass `--no-provenance` to leave it out.

This is on by default while per-engram records inside your own store are off.
The two settings answer different questions. Inside your own store a record
mostly repeats the history log. The moment a pack leaves, it is the only thing
that travels with the memories.

### Reading a pack before you install it

```
plur packs preview <pack>
```

That tells you how many records the pack carries, who it names as answerable,
which licences appear, and whether each licence was chosen or defaulted. Add
`--provenance` for the full document.

It also reports whether the pack still matches the integrity value it shipped:

- **matches** — the pack arrived intact.
- **does not match** — it changed after it was built. Installing is refused.
- **no value shipped** — nothing was checked. This is not the same as a pass,
  and it does not say so.

**Nothing in a pack is signed.** So everything a pack says about its own origins
is a claim by whoever built it. The preview carries no tick and no badge, and
says this in as many words. A matching hash means the pack arrived intact — not
that its contents are trustworthy, and not that the sender is who they say.
Someone who edited the contents could edit the value beside them.

Exporting also scans the pack for credentials and instruction-override text.
That covers the engrams **and** the pack's own `SKILL.md`, which is a file the
recipient's assistant loads.

The pack record answers a question no single engram can: **is this pack worth
anything?** It says who assembled it and when, and from the engrams inside it,
how many were stated by a person versus inferred by a model, what dates they
span, and whether every engram carries a licence.

Two packs of the same size are not equal. One may be direct statements from a
named expert. The other may be machine guesses from an unknown source.

Records are only written for engrams that pass the privacy scan. If the pack
refused an engram, no record for it is written either. Provenance never becomes
a way around a refusal.

One detail worth knowing. A pack's integrity hash covers `SKILL.md` and
`engrams.yaml` only, so the provenance files are not covered by it. The
dependency runs the other way instead: the pack record carries the pack's hash.
Change the pack and the hash inside the record stops matching.

---

## Fields for your own field of work

Medical data, land registries and supply chains each have facts worth recording
that mean nothing to the others. You can add your own, under your own prefix:

```ts
await plur.provenanceFor('ENG-2026-08-21-001', {
  domain: {
    namespaces: { geo: 'https://example.org/geo#' },
    attributes: { 'geo:parcelId': '1234-5678' },
  },
})
```

Four rules apply, and the first two are enforced:

1. Use **your own prefix**, never `prov:` or `engram:`.
2. Never redefine an existing term to mean something else.
3. A reader keeps fields it does not recognise, and does not fail on them.
4. A reader does not treat an unrecognised field as trustworthy.

Breaking the first two throws rather than warns. A silently dropped field looks
like it was recorded, and a silently overwritten core term corrupts every reader
downstream.

---

## Checking a record

Records are ordinary JSON-LD. Any tool that reads that format will read ours.

Two worked examples live in [`spec/examples/`](../spec/examples/), built from a
real engram and checked against two implementations that share no code with
ours. `spec/examples/check.py` runs those checks.

---

## What this does not do yet

**It does not prove who wrote a record.** Signing is not implemented, and this
does not pretend otherwise.

**It does not make the history log tamper-proof.** The log can be edited. A
record built from an edited log inherits the edit.

Both are deliberate. See the profile for why, and what would have to happen
first.
