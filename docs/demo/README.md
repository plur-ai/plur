# Two recorded demos

**Start with the conversation.** It is how people actually meet this feature:
they talk to their assistant, and the assistant calls the tools.

| Demo | What it shows |
|---|---|
| `agent-conversation.sh` | Someone talking to an assistant that has PLUR connected, with every tool call shown underneath. |
| `provenance-walkthrough.sh` | The same ground from the command line, for anyone driving PLUR directly. |

Each has a recording, an image and a plain transcript under `recording/`.

`mcp-call.mjs` is the client the conversation uses. It speaks the protocol
Claude Code and Cursor speak — initialize, then `tools/call` — so the results in
the demo are whatever the tool really returned, not something written to look
good.

## The conversation

```
bash docs/demo/agent-conversation.sh
```

Six exchanges, in the order they come up in real life:

1. **"Remember that."** One `plur_learn` call, no ceremony.
2. **"Where did that come from?"** The honest answer, a month later: four things
   listed as *not recorded*, because nobody recorded them.
3. **"Record it properly."** Who asserted it, what kind of claim, what it came
   from, which licence.
4. **"Can I put this in the customer deck?"** The question the feature exists
   for — and the assistant answers from five machine-readable values rather than
   from prose.
5. **"Can I share the first one?"** No. Private, and the licence line is about
   reuse, not permission to pass it on. These are different questions and the
   demo shows the tool keeping them apart.
6. **"The number changed."** A correction, and what somebody asking about the
   old memory is told.

The last exchange states the boundary out loud: provenance **records** a
correction, and what recall does about it is PLUR's decision.

---

## The command-line walkthrough

## Running it

```
bash docs/demo/provenance-walkthrough.sh
```

It builds a throwaway store in a temporary directory and deletes it on the way
out. **It never touches your own memories.** Point it at a different build with
`PLUR_CLI=/path/to/index.js`.

To play the recording:

```
asciinema play docs/demo/recording/provenance-walkthrough.cast
```

To record it again after the code changes:

```
asciinema rec docs/demo/recording/provenance-walkthrough.cast --overwrite \
  --cols 100 --rows 34 --command "bash docs/demo/provenance-walkthrough.sh"
agg --font-size 15 --theme monokai \
  docs/demo/recording/provenance-walkthrough.cast \
  docs/demo/recording/provenance-walkthrough.gif
```

## What it shows, and why in that order

**1. An ordinary memory.** No flags. The point is what the answer looks like
when nobody recorded anything: four things listed as not recorded, and a
sentence saying they are absences rather than blanks. This is the honest case
and it is the common one.

**2. The same memory recorded properly.** The three flags, and an answer with
nothing missing. Also the three values a machine can act on, and why they fail
closed.

**3. Sharing.** A pack carries provenance without being asked, because a pack is
the moment memories leave your machine.

**4. Receiving.** What a recipient can check *before* installing — and the fact
that nothing is signed, so all of it is a claim by whoever built the pack. The
tamper case is shown because a check nobody has seen fail is not a check.

**5. Correcting.** Asking about the old memory tells you what replaced it.
Provenance **records** the correction; what recall and injection do about it is
PLUR's decision, and this work does not change it.

**6. The document.** Everything above is a readable view of one JSON-LD record:
W3C PROV, with licences as ODRL policy, checked against two outside
implementations rather than only our own.

## Keeping it honest

The script is run in continuous integration the same way anyone runs it, so a
change that breaks the journey breaks the build rather than being discovered in
a recording nobody re-made. If you change the output, re-record: a walkthrough
that no longer matches the tool is worse than none.

## A note on the pauses

Both scripts pause between steps so a recording is readable. Set `DEMO_FAST=1`
to drop them — the tests do, because a script that mostly sleeps holds a test
worker for minutes while spawning processes, and starves everything else. That
showed up as sixteen unrelated test files timing out, which is a confusing way
to learn it.

```
DEMO_FAST=1 bash docs/demo/agent-conversation.sh    # about a second
bash docs/demo/agent-conversation.sh                # paced for recording
```
