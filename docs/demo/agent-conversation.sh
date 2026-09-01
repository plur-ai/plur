#!/bin/bash
# A conversation with an assistant that has PLUR connected, showing the tool
# calls it makes underneath.
#
#   bash docs/demo/agent-conversation.sh
#
# Every tool call below is REAL: it goes over stdio to the built MCP server, the
# same protocol Claude Code and Cursor speak. The results are whatever the tool
# actually returned, not something written for the demo.
#
# It builds a throwaway store in a temporary directory and deletes it on exit,
# so your own memories are untouched.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CALL="node $HERE/mcp-call.mjs"
DEMO="$(mktemp -d)"
STORE="$DEMO/store"
# Same backstop as provenance-walkthrough.sh: a forgotten --path must land here,
# not in the reader's real store.
export PLUR_PATH="$STORE"
mkdir -p "$STORE"
trap 'rm -rf "$DEMO"' EXIT

B=$'\033[1m'; DIM=$'\033[2m'; BLUE=$'\033[38;5;75m'; GREY=$'\033[38;5;245m'
GREEN=$'\033[38;5;114m'; AMBER=$'\033[38;5;179m'; R=$'\033[0m'

# The pauses exist so a RECORDING is readable. Under test they are pure cost:
# the script would hold a worker slot for minutes doing nothing while spawning
# processes, and starve the rest of the suite. A scatter of unrelated timeouts
# across sixteen unrelated files is what that looks like from the outside.
pause() { [ -n "${DEMO_FAST:-}" ] || sleep "$1"; }

# A person typing.
you() { printf '\n%s┃ You%s\n' "$B$BLUE" "$R"; while IFS= read -r l; do printf '%s┃%s %s\n' "$BLUE" "$R" "$l"; done <<< "$1"; pause 1.6; }
# The assistant replying.
bot() { printf '\n%s┃ Assistant%s\n' "$B$GREEN" "$R"; while IFS= read -r l; do printf '%s┃%s %s\n' "$GREEN" "$R" "$l"; done <<< "$1"; pause 2.2; }
# A tool call the assistant makes, and what came back.
call() {
  printf '\n%s   ╭─ tool call ─────────────────────────────────────────────%s\n' "$GREY" "$R"
  printf '%s   │%s %s%s%s %s\n' "$GREY" "$R" "$AMBER" "$1" "$R" "$2"
  pause 1.0
  local out
  out="$($CALL "$STORE" "$1" "$2" 2>/dev/null | eval "${3:-cat}")"
  while IFS= read -r l; do printf '%s   │%s %s%s%s\n' "$GREY" "$R" "$DIM" "$l" "$R"; done <<< "$out"
  printf '%s   ╰──────────────────────────────────────────────────────────%s\n' "$GREY" "$R"
  pause 1.8
}
note() { printf '\n%s%s%s\n' "$DIM" "$1" "$R"; pause 1.6; }

clear
printf '%sTalking to an assistant that remembers%s\n' "$B$BLUE" "$R"
printf '%sPLUR connected over MCP. Every tool call below is real.%s\n' "$DIM" "$R"
pause 2.5

# ---------------------------------------------------------------------------
you "We always run migrations before deploys, never after. Remember that."

call plur_learn '{"statement":"Migrations run before deploys, never after","type":"behavioral"}' \
  "python3 -c \"import json,sys; d=json.load(sys.stdin); print('id:', d['id']); print('decision:', d['decision'])\""

bot "Noted."

# ---------------------------------------------------------------------------
you "A month later — where did that come from? Can I rely on it?"

call plur_provenance '{"search":"migrations deploys"}' \
  "python3 -c \"
import json,sys
d = json.load(sys.stdin)
print(d['summary'])
\""

bot "Honestly, not much. I have the memory and when I wrote it, but nobody
recorded who said it, whether it was stated or worked out, or what it
came from. The licence is the default — nobody chose it.

Those are absences, not blanks. I did not lose them; they were never
recorded. If this matters, tell me and I will record it properly."

# ---------------------------------------------------------------------------
you "It's from the runbook. Priya on platform confirmed it. Record it properly,
and it's CC BY 4.0 so the team can reuse it."

call plur_learn '{"statement":"Connection pools cap at 100 on the shared tier","type":"architectural","visibility":"public","source":"https://example.org/runbook","claim_class":"documented","license":"cc-by-4.0","attribution":{"asserted_by":"local:priya","runtime":{"name":"plur-mcp","version":"0.18.0"}}}' \
  "python3 -c \"import json,sys; d=json.load(sys.stdin); print('id:', d['id'])\""

# Capture the ids the store minted, rather than predicting them.
#
# Ids are date-sequenced, so the literals that used to sit in the calls below
# named real engrams only on the day this was recorded, and the conversation
# broke the next morning.
POOLS=$($CALL "$STORE" plur_provenance '{"search":"connection pools"}' 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['engram_id'])")

bot "Recorded."

you "And now?"

call plur_provenance '{"search":"connection pools"}' \
  "python3 -c \"
import json,sys
d = json.load(sys.stdin)
print(d['summary'])
print()
print('nothing missing:', d['not_recorded'] == [], '| complete:', d['complete'])
\""

bot "Everything is there. Priya is on record as having asserted it, it came
from the runbook, it is documented rather than inferred, and it is
CC BY 4.0 — chosen, not defaulted."

# ---------------------------------------------------------------------------
you "Can I put that in the deck for the customer?"

note "This is the question the feature exists for, and the one that is easy to
answer wrongly. Reuse and sharing are different questions."

call plur_provenance '{"search":"connection pools"}' \
  "python3 -c \"
import json,sys
d = json.load(sys.stdin)
for k in ('may_leave_this_machine','may_reuse_commercially','may_redistribute','licence_recognised','licence_chosen'):
    print(f'{k:26}', d[k])
\""

bot "Yes. It is marked public so it may leave this machine, CC BY 4.0 permits
commercial use and redistribution, and somebody actually chose that
licence — so the answer rests on a decision, not on a default.

Credit is required. Attribute it to the runbook."

# ---------------------------------------------------------------------------
you "What about the first thing I told you — can I share that one?"

call plur_provenance '{"search":"migrations deploys"}' \
  "python3 -c \"
import json,sys
d = json.load(sys.stdin)
for k in ('may_leave_this_machine','may_reuse_commercially','licence_chosen'):
    print(f'{k:26}', d[k])
print()
print([l for l in d['summary'].split(chr(10)) if 'Not permission' in l or 'Nobody chose' in l][0].strip())
\""

bot "No. That one is private — it has not been cleared to leave this machine.

The licence line says reuse is allowed, but that governs the content if
somebody already has it. It is not permission to pass the memory on, and
nobody chose that licence anyway."

# ---------------------------------------------------------------------------
you "The cap changed to 200 last week. Correct it."

call plur_learn '{"statement":"Connection pools cap at 200 on the shared tier since August","type":"architectural","claim_class":"documented","attribution":{"asserted_by":"local:priya"},"supersedes":["'"$POOLS"'"]}' \
  "python3 -c \"import json,sys; d=json.load(sys.stdin); print('id:', d['id'])\""

# The correction's own id, for the record shown at the end. Read back from the
# superseded engram, so it is whatever the store actually assigned.
FIXED=$($CALL "$STORE" plur_provenance '{"id":"'"$POOLS"'"}' 2>/dev/null \
  | python3 -c "import json,sys; print((json.load(sys.stdin).get('superseded_by') or ['$POOLS'])[0])")

you "If someone asks about the old one, will they know?"

call plur_provenance '{"id":"'"$POOLS"'"}' \
  "python3 -c \"
import json,sys
d = json.load(sys.stdin)
for line in d['summary'].split(chr(10)):
    if 'SUPERSEDED' in line: print(line.strip())
print()
print('superseded_by:', d.get('superseded_by'), '| complete:', d['complete'])
\""

bot "Yes. Asking about the old memory now leads with the fact that it was
replaced, names what replaced it, and refuses to report itself as
complete — because there is something more to know about it.

I have recorded the correction. What my recall does with that is PLUR's
decision, not the record's."

# ---------------------------------------------------------------------------
you "Show me the actual document. I want to give it to our compliance team."

call plur_provenance '{"id":"'"$FIXED"'","format":"record"}' \
  "python3 -c \"
import json,sys
r = json.load(sys.stdin)['record']
print('@context:', ', '.join(r['@context'].keys()))
sub = [n for n in r['@graph'] if n.get('@id','').startswith('engram:ENG')][0]
for k in ('engram:claimClass','prov:wasAttributedTo','engram:license','engram:maySharePlainly'):
    if k in sub: print(f'{k:24}', json.dumps(sub[k]))
\""

bot "That is W3C PROV in JSON-LD, with the licence expressed as an ODRL
policy. It stands on its own — no supporting log needed — and it has
been checked against two implementations that share none of our code.

One thing to tell them plainly: none of this is signed. It records what
happened; it does not prove who wrote it."

printf '\n%sThe throwaway store is deleted on exit.%s\n\n' "$B$GREEN" "$R"
pause 2
