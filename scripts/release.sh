#!/bin/bash
# PLUR Release Script
# Usage: ./scripts/release.sh <version> [--claw <claw-version>] [--dry-run] [--skip-tweet] [--preview-tweet]
#
# Modes:
#   default          Full release (bump, build, test, commit, tag, push,
#                    canary npm publish + smoke test + promote, PyPI publish,
#                    GH release, website deploy, tweet) for core/mcp/cli.
#                    Claw is NOT touched unless --claw is provided.
#   --claw <ver>     Also bump and publish @plur-ai/claw at <ver>. Claw has
#                    its own version track (independent of core/mcp/cli)
#                    because of ClawHub publish + plugin lifecycle. Bumping
#                    claw in lockstep with core would regress its npm version
#                    and fail publish. Specify explicitly when claw should
#                    ride along with this release.
#   --dry-run        Bump + build + test + tweet preview, then stop before commit.
#                    Files ARE mutated (versions bumped) — revert with git.
#   --preview-tweet  Print the tweet that would be posted for <version>, exit.
#                    No file mutations, no network. Use to iterate CHANGELOG
#                    copy until the tweet fits 280 chars.
#   --skip-tweet     Full release but don't post to X.
#
# Tweet validation: tweet text is generated from CHANGELOG and validated
# (length ≤ 270) BEFORE step 4 (git). A too-long tweet would fail at the X
# API call AFTER npm + PyPI + GH release have already published — partial-
# publish exposure. Validating early catches it before any irreversible
# action.
#
# Step order:
#   1.  Version bumps (10 places, claw separate if --claw)
#   2.  Build all packages
#   3.  Run tests
#   3.5 Validate tweet length (abort if > 270 chars)
#   4.  Commit + tag + push
#   5a. Publish npm to @next (canary)
#   5b. Smoke test (npx by exact version, assert --version reports correctly)
#   5c. Promote @next → @latest
#   6.  Publish PyPI (hermes)
#   7.  GitHub release
#   8.  Website deploy (rsync + curl verify softwareVersion)
#   9.  Post tweet
#
# Environment overrides:
#   WEBSITE_DIR     Path to website repo (default: ../website relative to plur)
#   DEPLOY_KEY      Path to SSH deploy key (default: ~/Data/.datacore/env/credentials/deploy_key)
#   DEPLOY_TARGET   rsync target (default: deploy@209.38.243.88:/var/www/sites/plur.ai/)
#
# Requirements:
#   - npm logged in as plur9
#   - PYPI_TOKEN_PLUR_HERMES in .datacore/env/.env
#   - X API credentials (PLUR_X_*) in .datacore/env/.env
#   - gh CLI authenticated
#   - pnpm installed
#   - rsync + ssh available (for website deploy)
#   - curl (for live-version verification)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# --- Parse args ---
VERSION=""
DRY_RUN=false
SKIP_TWEET=false
PREVIEW_TWEET=false
CLAW_VERSION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --skip-tweet) SKIP_TWEET=true; shift ;;
    --preview-tweet) PREVIEW_TWEET=true; shift ;;
    --claw)
      shift
      CLAW_VERSION="${1:-}"
      [ -n "$CLAW_VERSION" ] && shift
      ;;
    --*)
      echo "Unknown flag: $1" >&2
      shift
      ;;
    *)
      if [ -z "$VERSION" ]; then
        VERSION="$1"
      fi
      shift
      ;;
  esac
done

if [ -z "$VERSION" ] || [[ "$VERSION" == --* ]]; then
  echo "Usage: ./scripts/release.sh <version> [--dry-run] [--skip-tweet] [--preview-tweet]"
  echo "Example: ./scripts/release.sh 0.9.4"
  exit 1
fi

# Load env
ENV_FILE="$HOME/Data/.datacore/env/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
fi

# Tweet length budget: X allows 280 chars. We cap at 270 to leave headroom
# for emoji-counted-as-2 quirks and trailing-newline accounting differences
# between bash and the X API tokenizer. If the tweet is over 270, we abort
# with a helpful diagnostic before any irreversible action.
TWEET_MAX=270

# --- Tweet generation (deterministic; called from multiple places) ---
# Reads CHANGELOG.md for $VERSION, sets globals: TWEET, REPLY, TWEET_LEN.
# Returns 0 on success, 1 if CHANGELOG section is empty.
generate_tweet() {
  local section features headline
  section=$(awk -v v="$VERSION" '$0 ~ "^## "v{p=1; next} /^## [0-9]/{if(p)exit} p' CHANGELOG.md)
  if [ -z "$section" ]; then
    return 1
  fi
  features=$(echo "$section" | grep "^- " | head -4 | sed 's/^- /✅ /')
  # Headline: prefer "Tagline:" or "Tagline." pattern in first non-blank
  # non-bullet line of the section, fall back to "Update:".
  headline=$(echo "$section" | awk 'NF && !/^- / && !/^###/ {print; exit}')
  [ -z "$headline" ] && headline="Update:"

  TWEET="🚀 New release: PLUR $VERSION

$headline

$features

Tell your agent to update.

github.com/plur-ai/plur/releases/tag/v$VERSION"

  REPLY="Manual update:

Claude Code / Cursor / Windsurf:
npm update -g @plur-ai/mcp @plur-ai/cli

OpenClaw:
openclaw plugins install @plur-ai/claw

Hermes:
pip install --upgrade plur-hermes"

  TWEET_LEN=${#TWEET}
  return 0
}

# --- Preview-tweet mode: generate, print, exit. No file mutations. ---
if [ "$PREVIEW_TWEET" = true ]; then
  if ! generate_tweet; then
    echo "ERROR: CHANGELOG.md has no section for $VERSION."
    echo "       Add a '## $VERSION (YYYY-MM-DD)' heading with bullet-list content first."
    exit 1
  fi
  echo "=== Tweet preview for $VERSION ==="
  echo ""
  echo "--- Main tweet ($TWEET_LEN / $TWEET_MAX chars) ---"
  echo "$TWEET"
  echo ""
  echo "--- Reply ---"
  echo "$REPLY"
  echo ""
  if [ "$TWEET_LEN" -gt "$TWEET_MAX" ]; then
    echo "✗ Tweet exceeds $TWEET_MAX-char budget by $((TWEET_LEN - TWEET_MAX)) chars."
    echo "  Tighten the first 4 bullets in CHANGELOG.md '## $VERSION' section."
    exit 2
  fi
  echo "✓ Tweet fits within $TWEET_MAX-char budget."
  exit 0
fi

echo "=== PLUR Release $VERSION ==="
echo "Dry run: $DRY_RUN"
echo ""

# --- 1. Version bump (12 locations) ---
echo "--- Step 1: Version bump ---"

OLD_CORE=$(node -e "console.log(require('./packages/core/package.json').version)")
echo "Current version: $OLD_CORE → $VERSION"

# package.json files for core/mcp/cli (claw is handled separately below)
for pkg in core mcp cli; do
  node -e "
    const fs = require('fs');
    const path = './packages/$pkg/package.json';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    pkg.version = '$VERSION';
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  ✓ packages/$pkg/package.json"
done

# TypeScript VERSION constants (3) — core has no VERSION constant; mcp + cli do
sed -i '' "s/const VERSION = '.*'/const VERSION = '$VERSION'/" packages/mcp/src/server.ts
echo "  ✓ packages/mcp/src/server.ts"

sed -i '' "s/const VERSION = '.*'/const VERSION = '$VERSION'/" packages/mcp/src/index.ts
echo "  ✓ packages/mcp/src/index.ts"

sed -i '' "s/const VERSION = '.*'/const VERSION = '$VERSION'/" packages/cli/src/index.ts
echo "  ✓ packages/cli/src/index.ts"

# mcp test version assertion
sed -i '' "s/toBe('[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*')/toBe('$VERSION')/g" packages/mcp/test/server.test.ts
echo "  ✓ packages/mcp/test/server.test.ts"

# Claw is on an independent version track — only bump if --claw was provided
if [ -n "$CLAW_VERSION" ]; then
  echo "  --- claw bumps (independent track: $CLAW_VERSION) ---"
  node -e "
    const fs = require('fs');
    const path = './packages/claw/package.json';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    pkg.version = '$CLAW_VERSION';
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  ✓ packages/claw/package.json"

  sed -i '' "s/version: '.*'/version: '$CLAW_VERSION'/" packages/claw/src/index.ts
  echo "  ✓ packages/claw/src/index.ts"

  sed -i '' "s/version: '.*'/version: '$CLAW_VERSION'/" packages/claw/src/context-engine.ts
  echo "  ✓ packages/claw/src/context-engine.ts"

  node -e "
    const fs = require('fs');
    const path = './packages/claw/openclaw.plugin.json';
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    data.version = '$CLAW_VERSION';
    fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  "
  echo "  ✓ packages/claw/openclaw.plugin.json"

  sed -i '' "s/toBe('[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*')/toBe('$CLAW_VERSION')/g" packages/claw/test/hello.test.ts
  echo "  ✓ packages/claw/test/hello.test.ts"
else
  CURRENT_CLAW=$(node -e "console.log(require('./packages/claw/package.json').version)")
  echo "  (claw stays at $CURRENT_CLAW — pass --claw <version> to bump and publish)"
fi

# Hermes pyproject.toml
sed -i '' "s/^version = \".*\"/version = \"$VERSION\"/" packages/hermes/pyproject.toml
echo "  ✓ packages/hermes/pyproject.toml"

echo ""

# --- 2. Build ---
echo "--- Step 2: Build ---"
pnpm build 2>&1 | grep -E "success|error"
echo ""

# --- 3. Test ---
echo "--- Step 3: Test ---"
TEST_OUTPUT=$(pnpm test 2>&1 || true)
PASS_COUNT=$(echo "$TEST_OUTPUT" | grep -o '[0-9]* passed' | head -1)
FAIL_COUNT=$(echo "$TEST_OUTPUT" | grep -o '[0-9]* failed' | head -1 || echo "0 failed")
echo "Tests: $PASS_COUNT, $FAIL_COUNT"

# Allow only the known openclaw integration failure
# Exclude known environment-dependent tests:
# - openclaw-integration: requires OpenClaw runtime
# - real-extraction: calls Anthropic API, flaky in CI
FAIL_LINES=$(echo "$TEST_OUTPUT" | { grep "FAIL " || true; } | { grep -v "openclaw-integration\|real-extraction\|Failed Suites" || true; })
REAL_FAILS=$(echo "$FAIL_LINES" | grep -c "FAIL" || true)
if [ "$REAL_FAILS" -gt 0 ] 2>/dev/null; then
  echo "ERROR: $REAL_FAILS unexpected test failures. Aborting."
  echo "$FAIL_LINES"
  exit 1
fi
echo ""

# --- 3.5. Validate tweet BEFORE any irreversible action ---
# The tweet is auto-generated from CHANGELOG bullets. If it exceeds X's 280-
# char limit, the X API call would fail at step 8 — AFTER npm + PyPI + GH
# release have already published. That's partial-publish exposure. Catch it
# here, before commit/tag/push/publish, when everything is still revertable.
if [ "$SKIP_TWEET" != true ]; then
  echo "--- Step 3.5: Tweet validation ---"
  if ! generate_tweet; then
    echo "ERROR: CHANGELOG.md has no '## $VERSION' section. Add it first."
    exit 1
  fi
  echo "Tweet length: $TWEET_LEN / $TWEET_MAX chars"
  if [ "$TWEET_LEN" -gt "$TWEET_MAX" ]; then
    echo ""
    echo "✗ Tweet exceeds $TWEET_MAX-char budget by $((TWEET_LEN - TWEET_MAX)) chars."
    echo "  Tighten the first 4 bullets of '## $VERSION' in CHANGELOG.md, then:"
    echo "    ./scripts/release.sh $VERSION --preview-tweet"
    echo "  Re-run release once it fits."
    echo ""
    echo "--- Current tweet ---"
    echo "$TWEET"
    exit 1
  fi
  echo "✓ Tweet fits. Preview:"
  echo ""
  echo "$TWEET"
  echo ""
fi

if [ "$DRY_RUN" = true ]; then
  echo "=== DRY RUN — stopping before publish ==="
  echo "Would commit, tag v$VERSION, push, publish all packages, create GH release, post tweet."
  exit 0
fi

# --- 4. Commit + tag + push ---
echo "--- Step 4: Git ---"
git add -A
git commit -m "chore: release v$VERSION"
git tag "v$VERSION"
git push origin main
git push origin "v$VERSION"
echo ""

# --- 5a. Publish npm to @next tag (canary) ---
# Publish to the `next` dist-tag first, smoke-test, then promote to `latest`.
# Reduces partial-publish blast radius: if the smoke test fails, @latest still
# points to the prior good release. Users on @latest are unaffected.
# Recovery: `npm dist-tag rm @plur-ai/<pkg> next` (the version stays published
# but unflagged — npm's 72-hour unpublish rule means we can't delete; we ship
# a 0.9.5 patch and deprecate 0.9.4 via `npm deprecate`).
echo "--- Step 5a: Publish npm @next (canary) ---"
for pkg in core cli mcp; do
  echo -n "  @plur-ai/$pkg@$VERSION → @next..."
  pnpm --filter "@plur-ai/$pkg" publish --access public --no-git-checks --tag next 2>&1 | tail -1
done
if [ -n "$CLAW_VERSION" ]; then
  echo -n "  @plur-ai/claw@$CLAW_VERSION → @next..."
  pnpm --filter "@plur-ai/claw" publish --access public --no-git-checks --tag next 2>&1 | tail -1
else
  echo "  @plur-ai/claw: skipped (no --claw flag)"
fi
echo ""

# --- 5b. Smoke test from npm ---
# Install the just-published version by exact version number (not by tag) in
# a clean tmpdir and assert it reports the expected version. This catches
# the broken-publish case 0.9.2 hit (esbuild regression — the package
# installed but `--version` would crash). If smoke fails, abort BEFORE
# promoting to @latest so @latest stays on the prior good release.
echo "--- Step 5b: Smoke test from @next ---"
SMOKE_DIR=$(mktemp -d)
pushd "$SMOKE_DIR" > /dev/null
SMOKE_OK=true
for pkg_check in "cli:$VERSION"; do
  pkg_name="${pkg_check%%:*}"
  pkg_ver="${pkg_check##*:}"
  echo -n "  npx -y @plur-ai/$pkg_name@$pkg_ver --version → "
  smoke_out=$(npx -y "@plur-ai/$pkg_name@$pkg_ver" --version 2>&1 || echo "EXEC_FAILED")
  if echo "$smoke_out" | grep -q "$pkg_ver"; then
    echo "✓ ($smoke_out)"
  else
    echo "✗"
    echo "      Expected version $pkg_ver in output, got: $smoke_out"
    SMOKE_OK=false
  fi
done
popd > /dev/null
rm -rf "$SMOKE_DIR"
if [ "$SMOKE_OK" != true ]; then
  echo ""
  echo "✗ Smoke test FAILED. @next is published but @latest is unchanged."
  echo "  To revert @next:"
  echo "    npm dist-tag rm @plur-ai/core next"
  echo "    npm dist-tag rm @plur-ai/mcp next"
  echo "    npm dist-tag rm @plur-ai/cli next"
  if [ -n "$CLAW_VERSION" ]; then
    echo "    npm dist-tag rm @plur-ai/claw next"
  fi
  echo "  Then ship a fix as the next patch (e.g. $VERSION → next-patch) and re-run."
  exit 1
fi
echo "✓ Smoke test passed."
echo ""

# --- 5c. Promote @next → @latest ---
# Past this point, @latest is updated. Users on @latest start receiving the
# new version. PyPI publish + GH release + tweet follow.
echo "--- Step 5c: Promote @next → @latest ---"
for pkg in core cli mcp; do
  echo -n "  @plur-ai/$pkg@$VERSION → @latest..."
  npm dist-tag add "@plur-ai/$pkg@$VERSION" latest 2>&1 | tail -1
done
if [ -n "$CLAW_VERSION" ]; then
  echo -n "  @plur-ai/claw@$CLAW_VERSION → @latest..."
  npm dist-tag add "@plur-ai/claw@$CLAW_VERSION" latest 2>&1 | tail -1
fi
echo ""

# --- 6. Publish PyPI ---
echo "--- Step 6: Publish PyPI ---"
cd packages/hermes
rm -rf dist/
python3 -m build 2>&1 | tail -1
TWINE_USERNAME=__token__ TWINE_PASSWORD="$PYPI_TOKEN_PLUR_HERMES" python3 -m twine upload dist/* 2>&1 | tail -1
cd "$REPO_ROOT"
echo ""

# --- 7. GitHub release ---
echo "--- Step 7: GitHub release ---"
# Extract current version section from CHANGELOG (stop at next ## heading)
RELEASE_NOTES=$(awk -v v="$VERSION" '$0 ~ "^## "v{p=1; next} /^## [0-9]/{if(p)exit} p' CHANGELOG.md)
if [ -z "$RELEASE_NOTES" ]; then
  RELEASE_NOTES="Release v$VERSION — see CHANGELOG.md for details."
fi
gh release create "v$VERSION" --title "v$VERSION" --notes "$RELEASE_NOTES" 2>&1 | tail -1
echo ""

# --- 8. Website deploy ---
# Closes engrams ENG-2026-0422-052/053 — plur.ai must be updated as part
# of every release, not as a follow-up. Looks for the website repo at
# $WEBSITE_DIR (default: ../website relative to plur monorepo) and the
# deploy key at $DEPLOY_KEY (default per ENG-2026-0329-019). Skips
# gracefully if either is missing.
WEBSITE_DIR="${WEBSITE_DIR:-$REPO_ROOT/../website}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/Data/.datacore/env/credentials/deploy_key}"
DEPLOY_TARGET="${DEPLOY_TARGET:-deploy@209.38.243.88:/var/www/sites/plur.ai/}"

echo "--- Step 8: Website deploy ---"
if [ ! -d "$WEBSITE_DIR" ]; then
  echo "  ⊘ Website dir not found at $WEBSITE_DIR — skipped"
  echo "    Set WEBSITE_DIR env var to override"
elif [ ! -f "$DEPLOY_KEY" ]; then
  echo "  ⊘ Deploy key not found at $DEPLOY_KEY — skipped"
  echo "    Set DEPLOY_KEY env var to override"
else
  echo "  Deploying $WEBSITE_DIR → $DEPLOY_TARGET"
  rsync -avz -e "ssh -i $DEPLOY_KEY -o StrictHostKeyChecking=accept-new" \
    "$WEBSITE_DIR/" "$DEPLOY_TARGET" \
    --exclude='.git' --exclude='node_modules' --exclude='.DS_Store' 2>&1 | tail -5
  # Verify the live softwareVersion matches. Caddy auto-serves; cache TTL
  # is short. A mismatch likely means we deployed to the wrong path
  # (engram ENG-2026-0402-048: must be /var/www/sites/plur.ai, not /var/www/plur.ai).
  sleep 2
  LIVE_VERSION=$(curl -s --max-time 10 https://plur.ai/ | grep -Eo '"softwareVersion":\s*"[0-9.]+"' | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "unreachable")
  if [ "$LIVE_VERSION" = "$VERSION" ]; then
    echo "  ✓ plur.ai serving softwareVersion=$VERSION"
  else
    echo "  ⚠️ plur.ai serving softwareVersion=$LIVE_VERSION (expected $VERSION)"
    echo "     Likely cache delay; retry in 30s. If persistent, check:"
    echo "     - Deploy path: must be /var/www/sites/plur.ai/ (NOT /var/www/plur.ai/)"
    echo "     - Caddy config: confirm root pointing to /var/www/sites/plur.ai/"
  fi
fi
echo ""

# --- 9. Tweet ---
if [ "$SKIP_TWEET" = true ]; then
  echo "--- Step 9: Tweet (skipped) ---"
else
  echo "--- Step 9: Tweet ---"
  # $TWEET and $REPLY are already populated and validated by step 3.5.
  # This block just posts them.

  echo "$TWEET"
  echo ""
  echo "--- Reply ---"
  echo "$REPLY"
  echo ""

  # Post main + reply via X API v2 (OAuth 1.0a)
  node -e "
    const crypto = require('crypto');
    const https = require('https');

    const apiKey = process.env.PLUR_X_API_KEY;
    const apiSecret = process.env.PLUR_X_API_SECRET;
    const accessToken = process.env.PLUR_X_ACCESS_TOKEN;
    const accessSecret = process.env.PLUR_X_ACCESS_TOKEN_SECRET;

    if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
      console.error('Missing X API credentials (PLUR_X_*)');
      process.exit(1);
    }

    function postTweet(text, replyToId) {
      return new Promise((resolve, reject) => {
        const method = 'POST';
        const url = 'https://api.x.com/2/tweets';
        const bodyObj = { text };
        if (replyToId) {
          bodyObj.reply = { in_reply_to_tweet_id: replyToId };
        }
        const body = JSON.stringify(bodyObj);

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = crypto.randomBytes(16).toString('hex');

        const params = {
          oauth_consumer_key: apiKey,
          oauth_nonce: nonce,
          oauth_signature_method: 'HMAC-SHA1',
          oauth_timestamp: timestamp,
          oauth_token: accessToken,
          oauth_version: '1.0',
        };

        const paramString = Object.keys(params).sort()
          .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
          .join('&');

        const baseString = method + '&' + encodeURIComponent(url) + '&' + encodeURIComponent(paramString);
        const signingKey = encodeURIComponent(apiSecret) + '&' + encodeURIComponent(accessSecret);
        const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

        const authHeader = 'OAuth ' + Object.entries({...params, oauth_signature: signature})
          .map(([k, v]) => encodeURIComponent(k) + '=\"' + encodeURIComponent(v) + '\"')
          .join(', ');

        const req = https.request(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
          },
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            if (res.statusCode === 201) {
              const json = JSON.parse(data);
              resolve(json.data.id);
            } else {
              reject(new Error('Tweet failed (' + res.statusCode + '): ' + data));
            }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    }

    (async () => {
      try {
        const mainId = await postTweet(process.argv[1], null);
        console.log('Main tweet posted: https://x.com/plur_ai/status/' + mainId);
        const replyId = await postTweet(process.argv[2], mainId);
        console.log('Reply posted: https://x.com/plur_ai/status/' + replyId);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
    })();
  " "$TWEET" "$REPLY"
fi

echo ""
echo "=== Release v$VERSION complete ==="
echo ""
echo "Published:"
echo "  npm: @plur-ai/core@$VERSION @plur-ai/mcp@$VERSION @plur-ai/claw@$VERSION @plur-ai/cli@$VERSION"
echo "  PyPI: plur-hermes==$VERSION"
echo "  GitHub: https://github.com/plur-ai/plur/releases/tag/v$VERSION"
