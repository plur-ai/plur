#!/usr/bin/env bash
# The judge is exactly as committed (fourth audit A4-01). Run after install and
# build, which ran the change's package scripts: none of them may have rewritten
# a judge file or added one. Covers every judge path -- the evals and their
# runner, every script (this one, the checkers, the harness tests), the root
# manifest, the workflows, and the shared test helpers evals import -- and
# counts untracked files too, so a new file shadowing a helper is caught.
set -euo pipefail
shopt -s nullglob
paths=(.evals evals scripts package.json .github)
for d in packages/*/test/helpers; do paths+=("$d"); done
changed="$(git status --porcelain --untracked-files=all -- "${paths[@]}")"
if [ -n "$changed" ]; then
  echo "The judge is not as committed after install and build:"
  echo "$changed"
  exit 1
fi
echo "judge intact: ${paths[*]}"
