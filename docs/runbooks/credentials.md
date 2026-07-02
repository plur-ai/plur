# Runbook: Human-bridge credentials (NPM_TOKEN + ClawHub OAuth)

**Status:** consolidated runbook per [#71](https://github.com/plur-ai/plur/issues/71)
**Audience:** maintainers/operators holding the `plur-ai` npm org and the `plur9` ClawHub account
**Frequency:** one-time setup, then rotation on expiry

Both credentials are "human-bridge" gates: a one-time browser/credential action
that agents cannot perform autonomously. They are operationally the same class
of problem, so one sitting (~15 min) resolves both.

> **Security rule:** this document names credentials and their storage
> locations. It must **never** contain an actual secret value — not in
> examples, not in verification output, not in commit history.

## Credential inventory

| Credential | What it is | Where it lives (names only) | Consumed by |
|---|---|---|---|
| `NPM_TOKEN` | npm granular access token for the `plur-ai` org, publish permission on `@plur-ai/*` | GitHub Actions repo secret `NPM_TOKEN` on `plur-ai/plur` | Publish-on-merge workflow `.github/workflows/publish.yml` (draft on [#59](https://github.com/plur-ai/plur/issues/59); **not yet landed** — see status below) |
| npm login session (`plur9`) | Interactive npm auth on the publishing machine | Local `~/.npmrc` of whoever ran `npm login` | Manual publish path — `pnpm --filter @plur-ai/<pkg> publish` per [`RELEASING.md`](../../RELEASING.md) and the "Publishing" section of [`CLAUDE.md`](../../CLAUDE.md) |
| ClawHub OAuth session (`plur9`) | Browser OAuth session for the `clawhub` CLI | Stored locally by the `clawhub` CLI on the machine where `clawhub login` was run | `clawhub publish ./packages/claw/clawhub` — creates/updates the `plur9/plur-memory` listing (H002 E0) |
| `CLH_TOKEN` | Headless ClawHub API token (alternative to browser OAuth) | Generated in the ClawHub dashboard; exported as env var `CLH_TOKEN` in CI or a shell | `clawhub login --token clh_...` for non-interactive publishes |

Not covered here (no shared secret involved): PyPI publishing
(`.github/workflows/publish-python.yml`) and MCP Registry publishing
(`.github/workflows/publish-mcp-registry.yml`) both use GitHub OIDC / Trusted
Publishing — no stored token, nothing to rotate.

## Gate 1 — `NPM_TOKEN` (npm publishing for `@plur-ai/*`)

### Which workflows consume it

- **Planned:** `.github/workflows/publish.yml` — the auto-detect-on-push
  variant drafted on [#59](https://github.com/plur-ai/plur/issues/59). It
  compares each `packages/*/package.json` version on `main` against
  `npm view <name> version` and publishes only the drifted packages, in fixed
  order `core → mcp → claw → cli`. The workflow file cannot ship until the
  secret exists.
- **Until then:** all npm publishes are manual, authenticated as `plur9` via a
  local `npm login` (see `RELEASING.md` → "Manual publish").

### Setup / rotation (~5 min, identical steps)

1. Generate a granular access token for the `plur-ai` org:
   <https://www.npmjs.com/settings/plur-ai/tokens> → Granular Access Token →
   packages: `@plur-ai/*` → permission: publish. Granular tokens carry an
   expiration date set at creation — note it and calendar the rotation.
2. Store it as the repo secret (paste the value into the prompt; never into a
   file or shell history):
   ```sh
   gh secret set NPM_TOKEN --repo plur-ai/plur
   ```
   (or GitHub UI: `plur-ai/plur` → Settings → Secrets and variables → Actions)
3. Verify the secret is registered (lists names only, never values):
   ```sh
   gh secret list --repo plur-ai/plur    # expect NPM_TOKEN in the list
   ```
4. Smoke-test once `publish.yml` is on `main`:
   ```sh
   gh workflow run publish.yml --repo plur-ai/plur   # no inputs; auto-detects drift
   # after ~2-3 min:
   for pkg in core mcp claw cli; do
     printf "%-6s main=%s npm=%s\n" "$pkg" \
       "$(node -p "require('./packages/$pkg/package.json').version")" \
       "$(npm view @plur-ai/$pkg version)"
   done                                   # expect main == npm for all four
   ```

### Failure symptoms when expired / absent

- **Publish workflow fails at the publish step** with npm `E401` /
  `ENEEDAUTH` (token expired or revoked) or an empty-credential error (secret
  never set).
- **Version drift accumulates:** `packages/<pkg>/package.json` on `main` is
  ahead of `npm view @plur-ai/<pkg> version`, so every merged version bump sits
  in "shipped on main / not on npm" limbo and `npx @plur-ai/cli@latest` serves
  a stale release to new users. Historical worst case: the `cli@0.9.2` esbuild
  brick stayed live on npm for 11+ days and `claw` drifted 9 days behind `main`
  (#71, #59).
- **Detection one-liner:** the `main`-vs-npm loop in step 4 above; any mismatch
  means the publish path is not firing.

## Gate 2 — ClawHub OAuth (`plur9`)

### What consumes it

Publishing and updating the `plur9/plur-memory` ClawHub listing from
`packages/claw/clawhub/` (its `SKILL.md` carries the listing frontmatter:
name `plur-memory`, version `0.1.0`). This is the entry point for hypothesis
H002 E0 — no listing, no measurement.

### Setup / rotation (~10 min, identical steps)

```sh
# 1. Install the CLI
npm i -g clawhub

# 2. Browser login as plur9 (opens https://clawhub.ai/cli/auth)
clawhub login
clawhub whoami             # expect handle: plur9

# 3. Publish (from the monorepo root)
clawhub publish ./packages/claw/clawhub \
  --slug plur-memory \
  --name "PLUR Memory" \
  --version 0.1.0 \
  --tags latest \
  --changelog "Initial release — persistent learning for AI agents via engrams."

# 4. Verify (no auth needed)
curl -sS -X POST "https://wry-manatee-359.convex.cloud/api/query" \
  -H 'content-type: application/json' \
  -d '{"path":"skills:getBySlug","args":{"slug":"plur-memory"},"format":"json"}' \
  | jq '.value != null'
# expect: true
```

There is no dry-run flag; step 4 is the smallest safe rehearsal.

**Headless alternative:** if browser login is impractical (CI), generate an API
token in the ClawHub dashboard, export it as `CLH_TOKEN`, and authenticate with
`clawhub login --token clh_...`.

### Failure symptoms when expired / absent

- `clawhub whoami` errors or reports the wrong handle → OAuth session expired;
  re-run `clawhub login`.
- `clawhub publish` fails with an authentication error → same fix.
- The step-4 verification returns `false` (`skills:getBySlug` → `null`) → the
  listing was never published; Gate 2 has not fired at all.

## Current status (snapshot 2026-07-02)

- `NPM_TOKEN`: **absent** — `gh secret list --repo plur-ai/plur` shows no
  `NPM_TOKEN`; `publish.yml` is not on `main`. npm publishing is keeping pace
  manually (all four packages `main` == npm as of this date), but every future
  bump depends on a human with `plur9` npm access until the secret + workflow
  land.
- ClawHub: **listing absent** — `skills:getBySlug{slug:'plur-memory'}` still
  returns `null`; Gate 2 has never fired.

When either state changes, update this snapshot (or delete the section once
both gates are permanently closed).
