# Releasing

This repo publishes four npm packages from `packages/`:

| Package | npm name |
|---|---|
| `core` | `@plur-ai/core` |
| `mcp` | `@plur-ai/mcp` |
| `claw` | `@plur-ai/claw` |
| `cli` | `@plur-ai/cli` |

`hermes` (Python) ships through a separate PyPI pipeline and is out of scope for this guide.

## Manual publish (one package)

When `main` has a version bump that hasn't reached npm yet — e.g. `@plur-ai/claw@0.9.10` is on
`main` but `npm view @plur-ai/claw version` still returns `0.9.9` — anyone with publish rights on
the `@plur-ai` npm scope can ship it from a clean checkout in under a minute:

```sh
git checkout main && git pull
pnpm install --frozen-lockfile
pnpm --filter @plur-ai/claw build
pnpm --filter @plur-ai/claw publish --access public --no-git-checks
```

Substitute the package name as needed (`@plur-ai/core`, `@plur-ai/mcp`, `@plur-ai/cli`).

### Why `pnpm publish`, not `npm publish`

- `packages/claw/package.json` declares dependencies like `"@plur-ai/core": "workspace:*"`.
  `pnpm publish` rewrites those to the concrete published version on the way out;
  `npm publish` would ship the literal `workspace:*` string and break the installed tarball.
- `--no-git-checks` skips pnpm's clean-tree assertion so local build artifacts don't block the
  publish.

### Verify (no auth, ~2s)

```sh
npm view @plur-ai/claw version   # expect the version that's on main
```

Once the npm version matches `main`, the drift is closed.

### Tag the release

`pnpm publish` does not push a git tag. After a successful publish:

```sh
TAG="@plur-ai/claw@$(node -p "require('./packages/claw/package.json').version")"
git tag "$TAG"
git push origin "$TAG"
```

## Consumer-side bump after a `core` (or other dependency) fix

When a fix lands in a workspace package that other packages depend on — most often `core`,
which `cli`, `mcp`, and `claw` all consume — bumping and publishing the dep alone is **not
enough** to ship the fix to users.

`workspace:*` pins are concretized at **publish time**, not at install time. So a consumer
that was published before the fix carries a hard pin to the broken dep version, even after
the fixed dep is on npm `latest`. `npm i @plur-ai/<consumer>@latest` will still pull the
broken dep.

This is what bricked `@plur-ai/cli@0.9.2` for 5 days (2026-04-22 → 2026-04-27): `core@0.9.3`
shipped a fix for `autoDiscoverStores` (#59 thread), but `cli@0.9.2` had already been
published with `@plur-ai/core: 0.9.2` baked into its `dependencies` field. Every
`npx @plur-ai/cli@latest` invocation returned `Dynamic require of "os" is not supported`
until `cli@0.9.3` was bumped (#64) and republished.

### Recipe — after publishing a `core` fix

1. For each workspace consumer of `core` (`cli`, `mcp`, `claw`), check the `core` pin baked
   into the latest published artifact:
   ```sh
   for pkg in cli mcp claw; do
     printf "%-20s -> " "@plur-ai/$pkg"
     npm view "@plur-ai/$pkg@latest" dependencies.@plur-ai/core
   done
   ```
2. If a consumer's published `core` pin is older than the fix, that consumer is shipping the
   broken dep. Bump it: follow the nine-place version-bump checklist in `CLAUDE.md`
   (package.json + in-source `VERSION` constants + test assertions), open a PR, merge.
3. After merge, run the **Manual publish** recipe above for each bumped consumer.
4. Verify the pin landed:
   ```sh
   npm view @plur-ai/cli@latest dependencies   # expect: { "@plur-ai/core": "<fixed-version>" }
   ```

The eventual publish-on-merge workflow (#59) should encode this auto-cascade: when `core`
bumps, every workspace consumer also bumps in the same release so the published artifact
graph stays internally consistent.

## Long-term: publish-on-merge workflow

The right long-term shape is a GitHub Actions workflow that detects `packages/*/package.json`
version bumps on `main` and publishes + tags them automatically. A draft is on file in
[#59](https://github.com/plur-ai/plur/issues/59) and lands as `.github/workflows/publish.yml`
when merged through the GitHub UI (the agent that drafted it lacks `workflow` token scope).

This `RELEASING.md` is the durable bridge for the period before that workflow merges, and
remains a useful reference for one-off / out-of-band publishes after it does.
