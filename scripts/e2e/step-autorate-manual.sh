#!/bin/bash
# Replay the Stop payload of session 3 into the installed auto-rate hook, by hand,
# to see where it stops. Same temp env as the real hook.
R=/private/tmp/pe2e.LXlt
SID=5b5856a0-628c-4957-ad51-c28097034dfa
cd $R/work/proj-a
PAYLOAD="{\"session_id\":\"$SID\",\"hook_event_name\":\"Stop\",\"cwd\":\"$R/work/proj-a\",\"stop_hook_active\":false,\"last_assistant_message\":\"The e2e harness marker word is **blue-heron-42**.\"}"
echo "\$ echo <Stop payload, session $SID, cwd proj-a> | env HOME=$R/home PLUR_PATH=$R/plur TMPDIR=$R/tmp plur-hook hook-auto-rate claude"
echo "$PAYLOAD" | env HOME=$R/home PLUR_PATH=$R/plur TMPDIR=$R/tmp $R/home/.plur/bin/plur-hook hook-auto-rate claude
echo "exit=$? stdout/stderr above (empty = silent)"
echo "\$ ls $R/tmp/plur-auto-rate"
ls -la $R/tmp/plur-auto-rate
