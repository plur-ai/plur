# Worked examples

Two provenance records for the same real engram, so you can see both the gap and
the goal.

These were built from an actual memory store, not invented. That matters. Writing
them against real data found three problems the design had missed.

| File | What it is |
|---|---|
| `example-today.jsonld` | what we can honestly produce right now |
| `example-target.jsonld` | the same engram once the capture work has landed |

Build them again with:

```bash
python3 build-example.py ENG-2026-08-12-002
```

Check them with:

```bash
python3 check.py
```

## What the two files show

The engram is a real one. It records what a funding round requires, taken from a
named web page. It has been used twice since it was written.

**Today's record already answers three of the five questions** a recipient needs:
when it was made, what it came from, and whether they may use it.

**It cannot answer the other two:** who made it, and what kind of claim it is. A
person stating something and a model guessing it look identical. That is the gap
the capture work closes, and the two files sit side by side so the difference is
visible rather than described.

## Three things building this taught us

**A record must be one flat list.** The first attempt wrapped everything in a
named group. It looked correct and passed a casual read. But an ordinary reader
saw only the wrapper and none of the contents — three statements instead of
sixty-four. Keep the list flat.

**A record must not name other engrams.** The log of an injection lists every
memory used together. The first attempt copied that list into the record. That
would have told the recipient the identifiers of five other memories held by the
sender. Now the record names only the engram it is about, and gives a count of the
others. **This is a privacy rule, not a formatting choice.**

**The log has duplicates.** The example showed the same injection recorded twice,
two milliseconds apart. Checking the whole store found 956 such pairs out of 3,209
entries. Filed separately. A record built from the log inherits that error.

## How they are checked

Two independent tools, neither of which shares any code with ours.

`rdflib` reads the file and reports what it found. `prov`, the reference
implementation of the standard, is then given the same content and must accept it.

The checker also tests the rules from the profile itself:

- no dangling references, so the record stands on its own
- the recipient can answer all five questions

Current state: both files parse, both are accepted by the reference
implementation, and neither has a dangling reference.
