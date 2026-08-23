#!/bin/bash
# The provenance user journey, end to end, with a comment beside every step.
#
#   bash docs/demo/provenance-walkthrough.sh
#
# Read-only with respect to your own memories: it builds a throwaway store in a
# temporary directory and deletes it on the way out. It never touches ~/.plur.
#
# Recorded with asciinema; see docs/demo/README.md.

set -u
CLI="${PLUR_CLI:-$(cd "$(dirname "$0")/../.." && pwd)/packages/cli/dist/index.js}"
DEMO="$(mktemp -d)"
STORE="$DEMO/store"
PACK="$DEMO/pack"
RECIPIENT="$DEMO/recipient"
mkdir -p "$STORE" "$RECIPIENT"
trap 'rm -rf "$DEMO"' EXIT

# Colours, and a slow-typing effect so the recording is readable.
B=$'\033[1m'; DIM=$'\033[2m'; C=$'\033[36m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[0m'
say()  { printf '\n%s# %s%s\n' "$DIM" "$1" "$R"; sleep 1.2; }
head2(){ printf '\n%s%s%s\n%s\n' "$B$C" "$1" "$R" "$(printf '─%.0s' $(seq 1 62))"; sleep 0.8; }
run()  { printf '%s$ %s%s\n' "$G" "$1" "$R"; sleep 0.6; eval "$1"; sleep 1.4; }

clear
printf '%sRecording where a memory came from%s\n' "$B$C" "$R"
printf '%sA throwaway store in %s — your own memories are untouched.%s\n' "$DIM" "$DEMO" "$R"
sleep 2

# ---------------------------------------------------------------------------
head2 "1. An ordinary memory, recorded the way most people start"

say "No extra flags. Just the thing you learned."
run "node $CLI learn 'Migrations run before deploys, never after' --path $STORE --json"

say "Now ask where it came from. This is the whole feature in one command."
run "node $CLI provenance 'migrations deploys' --path $STORE --json | python3 -m json.tool"

say "Read the 'not_recorded' list. Those four things are genuinely unknown —"
say "nobody wrote them down. The tool says so rather than leaving a blank,"
say "because a blank reads as zero and 'unknown' does not."

# ---------------------------------------------------------------------------
head2 "2. The same memory, recorded properly"

say "Three flags say who is answerable, what kind of claim it is, and"
say "which licence governs reuse. --source says what it came from."
run "node $CLI learn 'Connection pools cap at 100 on the shared tier' \\
    --asserted-by local:maintainer \\
    --claim-class documented \\
    --source https://example.org/runbook \\
    --license cc-by-4.0 \\
    --visibility public \\
    --path $STORE --json"

say "Ask again. Nothing is missing this time."
run "node $CLI provenance 'connection pools' --path $STORE --json | python3 -m json.tool"

say "Note the three machine-readable answers: may_reuse_commercially,"
say "may_redistribute, licence_recognised. They fail CLOSED — an unknown"
say "licence yields false, never null, because a consumer written"
say "'if (x !== false)' would read null as permission."

# ---------------------------------------------------------------------------
head2 "3. Sharing it: a pack carries provenance without being asked"

say "A pack is how memories leave your machine, so this is where origin"
say "starts to matter to somebody else. It ships by default."
run "node $CLI packs export team-conventions --output $PACK --path $STORE --json | python3 -m json.tool"

say "One record per engram, plus one for the pack as a whole."
run "ls -1 $PACK $PACK/provenance"

# ---------------------------------------------------------------------------
head2 "4. Receiving it: what a recipient can check BEFORE installing"

say "The gate belongs at the boundary. Afterwards it changes nothing."
run "node $CLI packs preview $PACK --path $RECIPIENT --json | python3 -c \"
import json,sys
d = json.load(sys.stdin)
print('integrity :', d['integrity']['status'])
print('records   :', d['provenance']['record_count'], 'of', d['engram_count'], 'engrams')
print('asserted  :', d['provenance']['asserted_by'])
print('verified  :', d['provenance']['verified'])
for l in d['provenance']['licences']:
    print('licence   :', l['name'], '- chosen by the author:', l['chosen'])
print()
print(d['provenance']['verification_note'])
\""

say "Read that last line twice. NOTHING here is signed, so everything the"
say "pack says about itself is a claim by whoever built it. There is no"
say "tick and no badge anywhere in this output, deliberately."

say "Tamper with the pack and the integrity check notices."
run "sed -i '' 's/Connection pools/Connection pool/' $PACK/engrams.yaml"
run "node $CLI packs install $PACK --path $RECIPIENT --json | python3 -m json.tool"

say "Put it back, and it installs."
run "sed -i '' 's/Connection pool /Connection pools /' $PACK/engrams.yaml"
run "node $CLI packs install $PACK --path $RECIPIENT --json | python3 -c \"
import json,sys
d = json.load(sys.stdin)
print('installed :', d['installed'], 'engrams')
print('integrity :', d['integrity_check']['status'])
\""

# ---------------------------------------------------------------------------
head2 "5. Correcting a memory"

say "Record a correction that replaces the earlier one."
run "node $CLI learn 'Connection pools cap at 200 on the shared tier since August' \\
    --supersedes ENG-2026-08-23-002 \\
    --asserted-by local:maintainer --claim-class documented \\
    --path $STORE --json 2>/dev/null | head -1"

say "Now ask about the OLD memory. It says what replaced it, in the first"
say "line, and is never reported complete."
run "node $CLI provenance ENG-2026-08-23-002 --path $STORE --json | python3 -c \"
import json,sys
d = json.load(sys.stdin)
print('superseded_by :', d.get('superseded_by'))
print('complete      :', d['complete'])
\""

say "Provenance RECORDS the correction. What recall and injection do with"
say "that is PLUR's decision, not provenance's — and it is unchanged."

# ---------------------------------------------------------------------------
head2 "6. The document itself, for machines"

say "Everything above is a readable summary of this."
run "node $CLI provenance ENG-2026-08-23-002 --record --path $STORE --json | python3 -c \"
import json,sys
r = json.load(sys.stdin)['record']
print(json.dumps(r['@context'], indent=2))
sub = [n for n in r['@graph'] if n.get('@id','').startswith('engram:ENG')][0]
for k in ('engram:claimClass','engram:license','engram:maySharePlainly',
          'prov:wasAttributedTo','prov:hadPrimarySource','engram:supersededBy'):
    if k in sub: print(f'{k:24}', json.dumps(sub[k]))
pol = sub.get('odrl:hasPolicy', {})
print('odrl permissions        ', json.dumps(pol.get('odrl:permission')))
print('odrl prohibitions       ', json.dumps(pol.get('odrl:prohibition')))
\""

say "Valid W3C PROV in JSON-LD, with licences expressed as ODRL policy."
say "Checked against two outside implementations, not only our own."

printf '\n%sDone. The throwaway store is deleted on exit.%s\n\n' "$B$G" "$R"
sleep 2
