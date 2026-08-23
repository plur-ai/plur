# The provenance walkthrough

A recorded terminal session showing the whole journey: recording where a memory
came from, sharing it, and checking it on the far side.

| File | What it is |
|---|---|
| `provenance-walkthrough.sh` | The script. Run it yourself. |
| `recording/provenance-walkthrough.cast` | The recording, for `asciinema play`. |
| `recording/provenance-walkthrough.gif` | The same thing as an image. |
| `recording/provenance-walkthrough.txt` | A plain transcript, for reading. |

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
