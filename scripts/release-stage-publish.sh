#!/bin/bash
# Step 5a of release.sh: stage every npm package for the owner's approval (#1904).
#
# Usage: scripts/release-stage-publish.sh [--dry-run] --version <ver>
#          [--claw <ver>] [--dsh <ver>] [--opencode <ver>]
#
# The npm publish token can only STAGE a publish: `pnpm publish` and
# `npm publish` get 403 E_STAGE_REQUIRED. A staged version reaches the registry
# only when the owner approves it with the passkey. So this step:
#
#   1. packs each package from inside its own folder (`pnpm pack` rewrites the
#      `workspace:` references to real versions; `pnpm --filter ... pack` failed
#      for 0.23.1), in dependency order, core first;
#   2. stages each tarball: `npm stage publish <tgz> --access public --tag next`,
#      and records the stage id npm prints;
#   3. waits until npm has validated each one (about 10 minutes of `validating`,
#      then `staged`);
#   4. stops and asks the owner to approve each package with the passkey, core
#      first, and to type `approved` when done (`npm stage approve --auth-type=web`
#      cannot run from a non-interactive shell: npm masks the approval URL and
#      exits with EOTP, so the approval is the owner's own step);
#   5. waits until every approved version resolves on the registry.
#
# release.sh then smoke-tests from @next (Step 5b) and moves the dist-tags to
# latest (Step 5c); `npm dist-tag add` works with the same token, without 2FA.
#
# --dry-run prints every command it would run and runs none of them: it calls
# neither npm nor pnpm, so nothing is packed, staged or published.
#
# An empty --claw/--dsh/--opencode value means "not in this release", so
# release.sh can pass its variables through unconditionally.
#
# Environment:
#   STAGE_WAIT_MINUTES   how long to wait for npm's validation (default 30)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=false
VERSION=""
CLAW_VERSION=""
DSH_VERSION=""
OPENCODE_VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --claw) CLAW_VERSION="${2:-}"; shift 2 ;;
    --dsh) DSH_VERSION="${2:-}"; shift 2 ;;
    --opencode) OPENCODE_VERSION="${2:-}"; shift 2 ;;
    *) echo "FAIL: unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [ -z "$VERSION" ]; then
  echo "Usage: scripts/release-stage-publish.sh [--dry-run] --version <ver> [--claw <ver>] [--dsh <ver>] [--opencode <ver>]" >&2
  exit 1
fi

# Dependency order: core first, everything else depends on it. dsh's viewer is
# bundled into its own dist, so there is no @plur-ai/ui to stage before it.
PKGS=(core cli mcp migrate)
VERS=("$VERSION" "$VERSION" "$VERSION" "$VERSION")
if [ -n "$CLAW_VERSION" ]; then PKGS+=(claw); VERS+=("$CLAW_VERSION"); fi
if [ -n "$DSH_VERSION" ]; then PKGS+=(dsh); VERS+=("$DSH_VERSION"); fi
if [ -n "$OPENCODE_VERSION" ]; then PKGS+=(opencode); VERS+=("$OPENCODE_VERSION"); fi
COUNT=${#PKGS[@]}

# pnpm names a scoped package's tarball <scope>-<name>-<version>.tgz.
tarball() { echo "plur-ai-$1-$2.tgz"; }

if [ "$DRY_RUN" = true ]; then
  echo "--- Step 5a (dry run): stage npm packages for passkey approval ---"
  echo "  Nothing is packed, staged or published. The real run executes, in order:"
  echo ""
  i=0
  while [ "$i" -lt "$COUNT" ]; do
    p="${PKGS[$i]}"; v="${VERS[$i]}"
    echo "  # @plur-ai/$p@$v"
    echo "  cd packages/$p && pnpm pack --pack-destination <pack-dir>/$p"
    echo "  npm stage publish <pack-dir>/$p/$(tarball "$p" "$v") --access public --tag next"
    i=$((i + 1))
  done
  echo ""
  echo "  Then it waits for each 'npm stage view <stage-id>' to show 'staged', and pauses"
  echo "  for the owner to approve each package with the passkey, core first:"
  i=0
  while [ "$i" -lt "$COUNT" ]; do
    echo "    npm stage approve <stage-id of @plur-ai/${PKGS[$i]}@${VERS[$i]}>"
    i=$((i + 1))
  done
  echo ""
  echo "  After the owner types 'approved', release.sh smoke-tests from @next (Step 5b)"
  echo "  and moves the dist-tags (Step 5c):"
  i=0
  while [ "$i" -lt "$COUNT" ]; do
    echo "    npm dist-tag add @plur-ai/${PKGS[$i]}@${VERS[$i]} latest"
    i=$((i + 1))
  done
  exit 0
fi

echo "--- Step 5a: Stage npm packages for passkey approval (@next) ---"
PACK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/plur-release-pack-XXXXXX")
IDS=()

# A failure part-way leaves some packages staged. Staging is not publishing: a
# staged version is invisible until approved, and can be dropped. Say exactly
# what is out there.
stage_failed() {
  echo ""
  echo "FAIL: $1"
  echo "  Nothing has been published: a staged version is not on the registry until approved."
  if [ "${#IDS[@]}" -gt 0 ]; then
    echo "  Staged so far this run:"
    j=0
    while [ "$j" -lt "${#IDS[@]}" ]; do
      echo "    @plur-ai/${PKGS[$j]}@${VERS[$j]}  stage id ${IDS[$j]:-unknown}"
      j=$((j + 1))
    done
    echo "  Either finish by hand (stage the rest, approve each with the passkey, then"
    echo "  continue from Step 5b), or drop them: npm stage reject <stage-id>"
  fi
  echo "  Tarballs: $PACK_DIR"
  exit 1
}

i=0
while [ "$i" -lt "$COUNT" ]; do
  p="${PKGS[$i]}"; v="${VERS[$i]}"
  dest="$PACK_DIR/$p"
  mkdir -p "$dest"
  echo "  @plur-ai/$p@$v"
  echo "    cd packages/$p && pnpm pack --pack-destination $dest"
  if ! (cd "packages/$p" && pnpm pack --pack-destination "$dest" > "$dest/pack.log" 2>&1); then
    cat "$dest/pack.log"
    stage_failed "could not pack @plur-ai/$p."
  fi
  tgz="$dest/$(tarball "$p" "$v")"
  if [ ! -f "$tgz" ]; then
    ls "$dest"
    stage_failed "packing @plur-ai/$p did not produce $(tarball "$p" "$v") (version not bumped?)."
  fi
  # npm would ship a literal workspace: specifier and break the install.
  if tar -xOf "$tgz" package/package.json | grep -q '"workspace:'; then
    stage_failed "@plur-ai/$p's packed package.json still has a workspace: reference."
  fi
  echo "    npm stage publish $tgz --access public --tag next"
  if ! stage_out=$(npm stage publish "$tgz" --access public --tag next 2>&1); then
    echo "$stage_out"
    stage_failed "npm did not stage @plur-ai/$p@$v."
  fi
  echo "$stage_out" | tail -1 | sed 's/^/    /'
  # npm prints "+ <name>@<ver> (staged with id <uuid>)".
  id=$(echo "$stage_out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1 || true)
  if [ -z "$id" ]; then
    echo "    ⚠ no stage id in npm's output; find it with: npm stage list @plur-ai/$p"
  fi
  IDS+=("$id")
  i=$((i + 1))
done
echo ""

# --- Wait for npm's validation ---
STAGE_WAIT_MINUTES="${STAGE_WAIT_MINUTES:-30}"
echo "--- Step 5a: Waiting for npm to validate the staged packages (up to $STAGE_WAIT_MINUTES min) ---"
stage_status() {
  npm stage view "$1" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.status||j.state||"")}catch{console.log("")}})' \
    || true
}
deadline=$(( $(date +%s) + STAGE_WAIT_MINUTES * 60 ))
i=0
while [ "$i" -lt "$COUNT" ]; do
  p="${PKGS[$i]}"; v="${VERS[$i]}"; id="${IDS[$i]}"
  echo -n "  @plur-ai/$p@$v "
  if [ -z "$id" ]; then
    echo "⚠ no stage id; check it on npmjs.com before approving"
    i=$((i + 1)); continue
  fi
  while :; do
    st=$(stage_status "$id")
    case "$st" in
      staged) echo " ✓ staged"; break ;;
      ""|validating|pending|queued) ;;
      *) echo " ⚠ status '$st': check it before approving (npm stage view $id)"; break ;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo " ⚠ still '${st:-unknown}' after $STAGE_WAIT_MINUTES min: check it before approving (npm stage view $id)"
      break
    fi
    echo -n "."
    sleep 30
  done
  i=$((i + 1))
done
echo ""

# --- The owner's passkey approval ---
echo "=================================================================="
echo "  OWNER ACTION: approve each staged package with your passkey."
echo "  Approve in this order (core first; the others depend on it):"
echo ""
i=0
while [ "$i" -lt "$COUNT" ]; do
  echo "    npm stage approve ${IDS[$i]:-<stage id: npm stage list @plur-ai/${PKGS[$i]}>}    # @plur-ai/${PKGS[$i]}@${VERS[$i]}"
  i=$((i + 1))
done
echo ""
echo "  Run those in your own terminal, or approve them on npmjs.com."
echo "  Type 'approved' here when every package is approved, or 'abort' to stop."
echo "=================================================================="
if ! { exec 3< /dev/tty; } 2>/dev/null; then
  stage_failed "no terminal to wait for the approval on. Approve the packages above, then continue from Step 5b by hand."
fi
while :; do
  reply=""
  read -r -u 3 -p "  > " reply || stage_failed "the approval prompt was closed before 'approved'."
  case "$reply" in
    approved) break ;;
    abort) stage_failed "aborted at the approval prompt." ;;
    *) echo "  Type 'approved' or 'abort'." ;;
  esac
done
exec 3<&-
echo ""

# --- Every approved version must resolve before the smoke test ---
echo "--- Step 5a: Waiting for the approved versions to resolve ---"
i=0
while [ "$i" -lt "$COUNT" ]; do
  p="${PKGS[$i]}"; v="${VERS[$i]}"
  echo -n "  @plur-ai/$p@$v "
  ok=false
  for _attempt in $(seq 1 60); do
    if npm view "@plur-ai/$p@$v" version > /dev/null 2>&1; then ok=true; break; fi
    echo -n "."
    sleep 10
  done
  if [ "$ok" != true ]; then
    echo " ✗"
    stage_failed "@plur-ai/$p@$v does not resolve 10 minutes after approval. Is it approved? (npm stage view ${IDS[$i]:-<id>})"
  fi
  echo " ✓"
  i=$((i + 1))
done
rm -rf "$PACK_DIR"
echo ""
