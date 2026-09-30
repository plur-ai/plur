#!/bin/bash
# CONTROL (diagnosis only, not a pass for check d): the same Stop payload, but
# with cwd = a folder that the old project-marker gate (isPlurConfigured)
# accepts — it has a .mcp.json naming plur. If the rest of the auto-rate path
# works, this queues the turn and the worker posts feedback to the stub.
R=/private/tmp/pe2e.LXlt
SID=e2e-control-0001
CTL=$R/work/proj-control
mkdir -p $CTL
echo '{"mcpServers":{"plur":{"command":"plur-mcp"}}}' > $CTL/.mcp.json
cp $R/tmp/plur-auto-rate/claude-5b5856a0-628c-4957-ad51-c28097034dfa.injected $R/tmp/plur-auto-rate/claude-$SID.injected
cd $CTL
PAYLOAD="{\"session_id\":\"$SID\",\"hook_event_name\":\"Stop\",\"cwd\":\"$CTL\",\"stop_hook_active\":false,\"last_assistant_message\":\"The e2e harness marker word is **blue-heron-42**.\"}"
echo "\$ (control) echo <Stop payload, cwd proj-control with .mcp.json> | env HOME=$R/home PLUR_PATH=$R/plur TMPDIR=$R/tmp plur-hook hook-auto-rate claude"
echo "$PAYLOAD" | env HOME=$R/home PLUR_PATH=$R/plur TMPDIR=$R/tmp $R/home/.plur/bin/plur-hook hook-auto-rate claude
echo "exit=$?"
sleep 15
echo "\$ ls $R/tmp/plur-auto-rate"
ls -la $R/tmp/plur-auto-rate
for f in $R/tmp/plur-auto-rate/claude-$SID.*; do echo "--- $(basename $f)"; cat "$f"; echo; done
