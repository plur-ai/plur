#!/bin/bash
# PLUR Release Script
# Usage: ./scripts/release.sh <version> [--dry-run] [--skip-tweet]
#
# Does everything:
#   1. Bumps version in all 12 locations
#   2. Builds all packages
#   3. Runs tests
#   4. Commits + tags + pushes
#   5. Publishes to npm + PyPI
#   6. Creates GitHub release from CHANGELOG
#   7. Posts release tweet
#
# Requirements:
#   - npm logged in as plur9
#   - PYPI_TOKEN_PLUR_HERMES in .datacore/env/.env
#   - X API credentials (PLUR_X_*) in .datacore/env/.env
#   - gh CLI authenticated
#   - pnpm installed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# --- Parse args ---
VERSION="${1:-}"
DRY_RUN=false
SKIP_TWEET=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --skip-tweet) SKIP_TWEET=true ;;
  esac
done

if [ -z "$VERSION" ] || [[ "$VERSION" == --* ]]; then
  echo "Usage: ./scripts/release.sh <version> [--dry-run] [--skip-tweet]"
  echo "Example: ./scripts/release.sh 0.6.0"
  exit 1
fi

# Load env
ENV_FILE="$HOME/Data/.datacore/env/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
fi

echo "=== PLUR Release $VERSION ==="
echo "Dry run: $DRY_RUN"
echo ""

# --- 1. Version bump (12 locations) ---
echo "--- Step 1: Version bump ---"

OLD_CORE=$(node -e "console.log(require('./packages/core/package.json').version)")
echo "Current version: $OLD_CORE → $VERSION"

# package.json files (4)
for pkg in core mcp claw cli; do
  node -e "
    const fs = require('fs');
    const path = './packages/$pkg/package.json';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    pkg.version = '$VERSION';
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  ✓ packages/$pkg/package.json"
done

# TypeScript VERSION constants (4)
sed -i '' "s/const VERSION = '.*'/const VERSION = '$VERSION'/" packages/mcp/src/server.ts
echo "  ✓ packages/mcp/src/server.ts"

sed -i '' "s/const VERSION = '.*'/const VERSION = '$VERSION'/" packages/mcp/src/index.ts
echo "  ✓ packages/mcp/src/index.ts"

sed -i '' "s/const VERSION = '.*'/const VERSION = '$VERSION'/" packages/cli/src/index.ts
echo "  ✓ packages/cli/src/index.ts"

# Claw version in plugin object and context-engine info
sed -i '' "s/version: '.*'/version: '$VERSION'/" packages/claw/src/index.ts
echo "  ✓ packages/claw/src/index.ts"

sed -i '' "s/version: '.*'/version: '$VERSION'/" packages/claw/src/context-engine.ts
echo "  ✓ packages/claw/src/context-engine.ts"

# openclaw.plugin.json
node -e "
  const fs = require('fs');
  const path = './packages/claw/openclaw.plugin.json';
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  data.version = '$VERSION';
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
"
echo "  ✓ packages/claw/openclaw.plugin.json"

# Test version assertions (2 files) — replace any semver in toBe() context
sed -i '' "s/toBe('[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*')/toBe('$VERSION')/g" packages/claw/test/hello.test.ts
echo "  ✓ packages/claw/test/hello.test.ts"

sed -i '' "s/toBe('[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*')/toBe('$VERSION')/g" packages/mcp/test/server.test.ts
echo "  ✓ packages/mcp/test/server.test.ts"

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

# --- 5. Publish npm ---
echo "--- Step 5: Publish npm ---"
for pkg in core cli mcp claw; do
  echo -n "  @plur-ai/$pkg..."
  pnpm --filter "@plur-ai/$pkg" publish --access public --no-git-checks 2>&1 | tail -1
done
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

# --- 8. Tweet ---
if [ "$SKIP_TWEET" = true ]; then
  echo "--- Step 8: Tweet (skipped) ---"
else
  echo "--- Step 8: Tweet ---"

  # Extract current version section from CHANGELOG
  SECTION=$(awk -v v="$VERSION" '$0 ~ "^## "v{p=1; next} /^## [0-9]/{if(p)exit} p' CHANGELOG.md)

  # Tweet template features: first 4 bullets become the tweet
  FEATURES=$(echo "$SECTION" | grep "^- " | head -4 | sed 's/^- /✅ /')

  # Headline count: extract "50+ improvements" style line if present
  HEADLINE=$(echo "$SECTION" | grep -Eo "^[0-9]+\+ improvements" | head -1)
  [ -z "$HEADLINE" ] && HEADLINE="Update:"

  # Main tweet — under 280 chars
  TWEET="🚀 New release: PLUR $VERSION

$HEADLINE

$FEATURES

Tell your agent to update.

github.com/plur-ai/plur/releases/tag/v$VERSION"

  # Reply tweet — manual install commands
  REPLY="Manual update:

Claude Code / Cursor / Windsurf:
npm update -g @plur-ai/mcp @plur-ai/cli

OpenClaw:
openclaw plugins install @plur-ai/claw

Hermes:
pip install --upgrade plur-hermes"

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
