#!/usr/bin/env bash
# Windows real-editor gate (#1605, M8): a commit may be released only when the
# "Windows real editors" workflow (.github/workflows/windows-editors.yml)
# passed on that exact commit. No local run can stand in for it: it needs a
# Windows runner and the real editor CLIs.
#
#   scripts/release-windows-gate.sh <commit-sha>
#
# Reads the workflow's runs for the commit through the Actions API, filtered
# by that workflow file (so a same-named check from another workflow cannot
# satisfy it), and requires the most recent completed one to have concluded
# "success". Re-runs count: the newest attempt wins. No run, a run still in
# progress, any other conclusion, or a failed query is a refusal (exit 1).
# Prints one line per finding; never needs a token beyond `gh`'s read access.
set -uo pipefail

SHA="${1:-}"
REPO="${PLUR_RELEASE_REPO:-plur-ai/plur}"
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: release-windows-gate.sh <40-hex commit sha>" >&2
  exit 2
fi

RUNS=$(gh api --paginate "repos/$REPO/actions/workflows/windows-editors.yml/runs?head_sha=$SHA&per_page=100" \
  --jq '.workflow_runs[] | [.id, .status, (.conclusion // "none"), .updated_at, .event] | @tsv' 2>/dev/null) || {
  echo "  windows-editors: query-failed (gh api) — refusing"
  exit 1
}
if [ -z "$RUNS" ]; then
  echo "  windows-editors: missing — no Windows real-editor run on $SHA"
  exit 1
fi
LATEST=$(printf '%s\n' "$RUNS" | sort -t$'\t' -k4 | tail -1)
IFS=$'\t' read -r ID STATUS CONCLUSION UPDATED EVENT <<<"$LATEST"
echo "  windows-editors: $STATUS/$CONCLUSION (run $ID, $EVENT, $UPDATED)"
if [ "$STATUS" != "completed" ] || [ "$CONCLUSION" != "success" ]; then
  echo "  Windows real-editor checks are not green on $SHA: https://github.com/$REPO/actions/runs/$ID"
  exit 1
fi
exit 0
