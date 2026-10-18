#!/usr/bin/env bash
# The promise evals, run on this machine instead of on GitHub (owner, 2026-10-18:
# "For CI and evals, we should do as much local as possible"). Same steps and
# the same refusals as the jobs in .github/workflows/evals.yml.
#
#   scripts/evals-local.sh gate [BASE]   separation check, harness tests, gate against
#                                        origin/BASE (default main). The proof a stacked
#                                        pull request pastes into its description.
#   scripts/evals-local.sh nightly       model provisioned and verified offline, holdout
#                                        hash and labels checked, then the full scoreboard
#                                        with the holdout and every planted bug (bite).
#   scripts/evals-local.sh agents        the agent-behaviour evals, 3 runs each, on the
#                                        Claude subscription login (never a paid API key).
#
# Results go to EVALS_OUT (default: a new temporary folder, printed at the end).
# Exit status is the first failing step's; "could not tell" is a failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE="${1:-}"
OUT="${EVALS_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/plur-evals-${MODE:-x}-XXXXXX")}"
mkdir -p "$OUT"
export PLUR_MODEL_CACHE_DIR="${PLUR_MODEL_CACHE_DIR:-$HOME/.cache/plur-model-cache}"

say() { printf '%s\n' "evals-local: $*" >&2; }

provision_model() {
  node evals/helpers/provision-model.mjs fetch
  # Its own process, downloads off: shows the cache alone is enough (R-07).
  node evals/helpers/provision-model.mjs verify
}

case "$MODE" in
  gate)
    BASE="${2:-main}"
    git fetch -q origin "+refs/heads/$BASE:refs/remotes/origin/$BASE"
    # Run after `pnpm install --frozen-lockfile && pnpm -r build`, as on GitHub.
    python3 scripts/test_check_eval_separation.py
    python3 scripts/check-eval-separation.py "origin/$BASE" | tee "$OUT/separation.txt"
    python3 scripts/test_evals_harness.py | tee "$OUT/harness.txt"
    # Install and build may not have rewritten the judge on the way to the gate.
    git diff --exit-code -- .evals evals scripts/check-eval-separation.py scripts/evals-local.sh package.json
    python3 .evals/gate.py --config evals/evals.yaml --base "origin/$BASE" | tee "$OUT/gate.txt"
    ;;
  nightly)
    provision_model
    HOLDOUT="${PLUR_EVAL_HOLDOUT_DIR:-$ROOT/../../1-tracks/engineering/evals-holdout/recall-v1}"
    if [ ! -d "$HOLDOUT" ]; then say "could not tell: holdout set not found at $HOLDOUT (set PLUR_EVAL_HOLDOUT_DIR)"; exit 1; fi
    export PLUR_EVAL_HOLDOUT_DIR="$(cd "$HOLDOUT" && pwd)"
    # Never score against a holdout that is not the pinned version, or has bad labels.
    python3 evals/gold/hash_set.py "$PLUR_EVAL_HOLDOUT_DIR" --expect "$(cat evals/gold/holdout-recall-v1.sha256)"
    python3 evals/gold/check.py evals/gold/recall-v1 --other "$PLUR_EVAL_HOLDOUT_DIR"
    python3 evals/gold/hash_set.py "$PLUR_EVAL_HOLDOUT_DIR/../dedup-v2" --expect "$(cat evals/gold/holdout-dedup-v2.sha256)"
    python3 evals/gold/check.py --dedup evals/gold/dedup-v2 --same-pairs-as evals/gold/recall-v1
    python3 evals/gold/check.py --dedup "$PLUR_EVAL_HOLDOUT_DIR/../dedup-v2" --same-pairs-as "$PLUR_EVAL_HOLDOUT_DIR"
    python3 .evals/run.py --config evals/evals.yaml --exclude-kind agent --json > "$OUT/scoreboard.json" || status=$?
    python3 .evals/bite.py --config evals/evals.yaml --json > "$OUT/bite.json" || status=${status:-$?}
    say "scoreboard: $OUT/scoreboard.json  planted bugs: $OUT/bite.json"
    exit "${status:-0}"
    ;;
  agents)
    # The subscription login only. A paid key in the environment is never used.
    unset ANTHROPIC_API_KEY
    provision_model
    IDS="$(python3 -c "import yaml;d=yaml.safe_load(open('evals/promises.yaml'));print(','.join(p['id'] for c in d['capabilities'] for p in c['promises'] if p.get('kind')=='agent'))")"
    python3 .evals/run.py --config evals/evals.yaml --agents --only "$IDS" --json > "$OUT/agents.json"
    say "agent evals: $OUT/agents.json"
    ;;
  *)
    say "usage: scripts/evals-local.sh gate [BASE] | nightly | agents"
    exit 2
    ;;
esac
say "results in $OUT"
