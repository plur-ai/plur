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

## Long-term: publish-on-merge workflow

The right long-term shape is a GitHub Actions workflow that detects `packages/*/package.json`
version bumps on `main` and publishes + tags them automatically. A draft is on file in
[#59](https://github.com/plur-ai/plur/issues/59) and lands as `.github/workflows/publish.yml`
when merged through the GitHub UI (the agent that drafted it lacks `workflow` token scope).

This `RELEASING.md` is the durable bridge for the period before that workflow merges, and
remains a useful reference for one-off / out-of-band publishes after it does.
