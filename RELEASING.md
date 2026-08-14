# Releasing

This repo publishes four npm packages and three Python/PyPI packages from `packages/`:

**npm:**

| Package | npm name |
|---|---|
| `core` | `@plur-ai/core` |
| `mcp` | `@plur-ai/mcp` |
| `claw` | `@plur-ai/claw` |
| `cli` | `@plur-ai/cli` |

**Python/PyPI** (separate pipeline — build + twine, not pnpm):

| Package | PyPI name |
|---|---|
| `hermes` | `plur-hermes` |
| `python` | `plur-ai` |
| `langchain` | `plur-langchain` |

This guide covers the npm release workflow. Python packages follow the same versioning cadence but ship via `python -m build` + `twine upload`.

Publishing credentials (npm auth as `plur9`, the pending `NPM_TOKEN` repo secret, ClawHub OAuth)
are documented in [`docs/runbooks/credentials.md`](docs/runbooks/credentials.md).

## Manifest gate — the CHANGELOG must declare what ships (issue #544)

`scripts/release.sh` runs a **manifest gate** (Step 3.6) before any irreversible
step. It **aborts the release** if a *user-facing* PR merged since the last tag
is **not declared** in this version's CHANGELOG section as `(#N)`. This exists
because the 0.12.0/0.13.0 incident shipped 11 unreviewed PRs that no one had
declared; the gate would have caught it.

**What you must do before releasing:** ensure every user-facing PR that will ship
appears in the `## <version>` section of `CHANGELOG.md` with its `(#N)` ref. If
the gate aborts, it lists the missing PRs and your options.

**What the gate skips:** PRs whose squash-commit subject uses a **non-user-facing
conventional-commit type** — `chore`, `ci`, `docs`, `test`, `build`, `refactor`,
`style`. These are curated out of the CHANGELOG by convention and are **not**
required to be declared. Only `feat` / `fix` / `perf` (and any other type) must
appear. So a `ci(hermes): …` or `chore(deps): …` PR ships silently; a
`feat(core): …` or `fix(mcp): …` PR must be in the CHANGELOG or the release stops.

**If the gate flags a PR that is genuinely not user-facing**, retitle its squash
commit with the appropriate `chore`/`ci`/`docs`/etc. type so it is curated out —
don't add noise to the CHANGELOG just to satisfy the gate.

The gate is offline and deterministic (no GitHub API calls): it reads shipped PRs
from `git log <last-tag>..HEAD` subjects and declared PRs from the CHANGELOG
section, and compares the sets.

The gate parses PR numbers from the trailing `(#N)` on each squash-commit subject,
including multi-issue trailers like `(#521, #247)`. Non-user-facing conventional
types are curated out — the standard `chore`/`ci`/`docs`/`test`/`build`/`refactor`/
`style` plus this repo's internal `ops` (release tooling), `cmo` (marketing copy),
and `infra` (server-side infrastructure — heartbeat, ingress, telemetry server).

## Publish verification (npm smoke + PyPI verify)

`scripts/release.sh` publishes npm to the `@next` dist-tag first, smoke-tests, then
promotes to `@latest` (Step 5). The smoke test (Step 5b) covers **all three promoted
packages**, not just `cli`:

- `cli` and `mcp` are checked via `npx -y @plur-ai/<pkg>@<version> --version` (both ship a bin).
- `core` has no bin, so it is checked by installing the exact `@next` version and importing
  the ESM entry, asserting the `Plur` export loads at the expected version. This catches the
  import-time crash class that bricked `cli@0.9.2` (`Dynamic require of "os" is not supported`,
  #64) — the audited fixes live in `core`, so promoting it unchecked was a real gap (#584).

Each smoke check **retries on npm-propagation lag** (up to 6 attempts, 20s apart): a package
published to `@next` seconds earlier may not be visible to `npx` yet, returning `ETARGET`
("no matching version") — which is not a real failure. Only that signature is retried; any
other failure (crash, wrong version) fails fast. Without this, a propagation race aborts the
whole release after `@next` is published — 0.14.0 hit exactly that and needed a manual
promote → PyPI → GH release → website → tweet recovery.

Before any smoke check runs, Step 5a.5 waits (up to 5 minutes) for `@plur-ai/core@<version>` to
become resolvable via `npm view`. `cli` and `mcp` pin `core` at the exact version, so they cannot
resolve until it is visible — without that gate the FIRST package smoked absorbs the whole set's
propagation wait and its private retry budget decides the fate of the release. v0.17.2 died exactly
there: `cli` exhausted its retries while `mcp`, checked seconds later against a now-propagated
`core`, passed on its first retry. The packages were fine; the ordering was the bug.

If a smoke check still fails after retries, `@next` is published but `@latest` is untouched;
the script prints the revert commands and aborts before promotion.

**The abort message now distinguishes lag from a defect**, because the correct recovery is opposite
in each case. If every failure matched the propagation signature (`ETARGET` / no matching version)
and nothing crashed or reported a wrong version, the artefacts are good and the release should be
**resumed from the promote step** — not reissued. Printing "ship the next patch" for a propagation
timeout would burn a version number for no reason, which is what the v0.17.2 message did.

**Website version pre-flight (Step 3.8).** Step 8 only *deploys* the website (rsync); it does
not update content. The content bump (`softwareVersion` + `@plur-ai/cli@<version>` install
commands in `index.html`, plus any `spec.html` feature changes) is a **manual pre-step**. Step
3.8 aborts *before any publish* if `../website/index.html`'s `softwareVersion` ≠ `$VERSION`, so
a forgotten site bump fails fast instead of silently shipping a stale site (ENG-2026-0422-052).
Skipped when the website dir isn't present.

**PyPI (Step 6) is immutable and has no canary.** A dropped or partial `twine upload` cannot be
overwritten — only superseded by a new version — and it runs *after* npm `@latest` already moved,
so a silent miss leaves a half-published release. The script now verifies `plur-hermes==<version>`
is retrievable from PyPI after upload (with retries for propagation lag) and, if it can't confirm,
prints the recovery path: check the project history (usually just lag), re-run `twine upload`, or —
if the filename is already registered from a partial upload — bump to the next patch, because the
version is burned and cannot be reused.

## Independent version tracks

`core` / `mcp` / `cli` / `migrate` / `hermes` / `python` bump together on the
release version. Three packages do not, and are only touched when their flag is
passed:

| Track | Flag | Why it is independent |
|---|---|---|
| `@plur-ai/claw` | `--claw <ver>` | ClawHub publish + plugin lifecycle; lockstep bumps would regress its npm version |
| `@plur-ai/dsh` | `--dsh <ver>` | Pinned to a pre-1.0 DeepSeek Harness line; moves on that ecosystem's cadence |
| `plur-langchain` | (manual) | Ships on its own schedule |

Each track's files are listed in `CLAUDE.md` under "Version bumps". A partial bump
is caught by that package's own manifest test, not at publish time.

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
   broken dep. Bump it: follow the version-bump checklist in `CLAUDE.md`
   (standard-release surfaces: package.json + VERSION constants + test assertions + hermes/python pins), open a PR, merge.
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
