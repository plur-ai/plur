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

**CLI fallback pins (audit 1228-c):** the 0.22.0 preparation pins `_NPX_CLI_VERSION` in both Python bridges to 0.22.0 and names that version in their READMEs for leading-dash queries. Keep those pins aligned with every standard release; `release.sh` updates them together.

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

## Pre-release audit discipline (issue #1058 retrospective)

The independent audit of 0.19.0 found two blocking defects that our own
three-audit cycle (evaluator, data-loss, adversarial) had **already found and
fixed — in one place each**. The malformed-config clobber (#1059) was fixed on
the hooks legs and missed on the MCP legs of the *same functions*; the tmp-dir
hardening (#1060) was applied to the Antigravity adapter and missed on the
Codex and Cursor families with the *same threat model*. The audits weren't too
shallow; the fixes were too narrow. These rules exist so that stays a
one-release lesson:

1. **A finding is a bug class, not a bug instance.** No audit finding is
   "fixed" until you have swept for its siblings: the other harness adapters,
   the other config legs in the same function, the other counter/sentinel
   implementations. Grep for the pattern you just fixed; the sweep is part of
   the fix, not a follow-up. (The structural end-state is shared code — one
   `ensureSessionDir`, one `readConfigForWrite` — because a fix to shared code
   propagates by construction. #1034 tracks that refactor.)

2. **Run the suite in a clean environment at least once before releasing.**
   `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null pnpm test`, from a
   clean worktree, ideally under a scratch `HOME`. Three 0.19.0 test failures
   (#1062) were invisible on the maintainer's machine and deterministic on a
   machine with a global gitignore — an environment PLUR's own users are
   *unusually likely* to have. "Passes on my machine" is a fact about the
   machine.

3. **Every "verified live" claim in a code comment names the event it covers;
   everything else gets a tracked issue before release.** 0.19.0's Codex
   SessionStart/UserPromptSubmit delivery was live-verified; PostToolUse
   delivery was not, the comment didn't distinguish, and no issue tracked the
   gap until the external audit filed #1064. Unverified behaviour may ship —
   silently-assumed behaviour may not.

4. **Sweep the diff for stray files.** Before tagging, read
   `git diff --stat <last-tag>..HEAD` and account for every file that is not
   source, test, or docs the CHANGELOG explains. `packages/core/mig-seed.mjs`
   (#1066) — a dev scratch script with a hardcoded maintainer path — rode into
   a public repo inside an otherwise-reviewed PR.

5. **The paid agent evals pass on the release commit.** Run
   `gh workflow run evals.yml -f agents=true --ref <release branch>` and wait for
   the `agents` job to finish green (each agent promise must pass all three runs,
   `evals/README.md`). Nothing triggers this automatically; it is this step.

Step 3.55 of `release.sh` additionally refuses to ship a version whose own
CHANGELOG heading still says `(unreleased)` (#1065).

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
| `@plur-ai/opencode` | `--opencode <ver>` | opencode plugin lifecycle, currently 0.1.0; lockstep bumps would churn its npm version for releases that don't touch it |
| `plur-langchain` | (manual) | Ships on its own schedule |

Each track's files are listed in `CLAUDE.md` under "Version bumps". A partial bump
is caught by that package's own manifest test, not at publish time.

### Plugins depend on core by range (#1831)

Because the plugins are not republished with every core, they do not pin the core
they were built with. Each declares `@plur-ai/core` with the range `>=0.23.0 <1`;
in the workspace the dependency is `workspace:>=0.23.0 <1`, which `pnpm publish`
writes out as `>=0.23.0 <1`.

| Plugin | `@plur-ai/core` declared as | Why |
|---|---|---|
| `opencode` | peer and regular dependency, same range | opencode installs plugins with @npmcli/arborist, which installs peers, unless the user's npm config sets `legacy-peer-deps` |
| `claw` | peer and regular dependency, same range | OpenClaw installs with `npm install --omit=peer`; from 2026.6.5 it adds non-host peers to the plugin's project, before that it does not |
| `dsh` | regular dependency only | DeepSeek Harness profiles use pnpm with `nodeLinker: hoisted` and `autoInstallPeers: false`; pnpm 11 does not link a package declared as both peer and dependency there |

Measured 2026-11-05 with a test package that depends on another, installed with
`autoInstallPeers: false` (does the dependency resolve from the installed package?):

| pnpm | `nodeLinker` | peer and dependency | peer only | dependency only |
|---|---|---|---|---|
| 9.15.9 | hoisted | yes | no | yes |
| 10 | hoisted | yes | not measured | yes |
| 11.28.11 | hoisted | **no** (in the lockfile, not in `node_modules`) | no | yes |
| 11.28.11 | isolated | yes | no | yes |

The packed `@plur-ai/dsh` behaves the same way: in a profile built from the
DeepSeek Harness template, pnpm 11 links core 0.23.0 only when dsh declares it as
a dependency alone. npm (11.5.1, also with `--omit=peer --legacy-peer-deps`) and
OpenClaw 2026.7.1 install the peer-and-dependency form.

`release.sh` Step 0.5 runs `scripts/check-plugin-core-range.mjs` before it changes
anything, in `--dry-run` too. It fails (exit 1) when a plugin's workspace range, or
the core requirement of a published plugin that this run does not republish,
excludes the release version, and it stops (exit 2) when it cannot check, for
example when npm is unreachable. Step 9b runs it again in `--post` mode as a
warning. A 1.0 core fails the range on purpose: that release has to decide, per
plugin, whether to widen the range and republish.

**The first release after #1831 must republish all three plugins:**

```sh
./scripts/release.sh <version> --opencode <v> --claw <v> --dsh <v>
```

Until then, the published plugins still pin one exact, older core (on 2026-11-05:
opencode 0.21.5 pinned core 0.21.5, claw 0.20.0 pinned 0.20.0, dsh 0.1.0 pinned
0.17.2), so Step 0.5 fails for any release without the three flags. Republishing ships
everything on `main` for each plugin since its last publish; review that before
choosing the versions.

The range has a cost: a published plugin can run on a core release it was never
tested against. Within 0.x a core minor may remove or change an export a plugin
uses. When that happens, raise the plugin's lower bound and republish it. A smoke
test that installs the published plugins against the packed new core is tracked
in [#1844](https://github.com/plur-ai/plur/issues/1844).

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

- The workspace packages depend on each other through `workspace:` specifiers, and
  `pnpm publish` rewrites them on the way out: claw's `"@plur-ai/core": "workspace:>=0.23.0 <1"`
  becomes `>=0.23.0 <1`, and mcp's and cli's `workspace:*` becomes the exact version of the
  workspace core. `npm publish` would ship the literal `workspace:` string and break the
  installed tarball.
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
which `cli` and `mcp` consume — bumping and publishing the dep alone is **not
enough** to ship the fix to users. (The plugins `opencode`, `claw` and `dsh` depend on core
by range, so a fresh install picks up the fixed core without a republish; raise a plugin's
lower bound and republish it only when it must not run on the broken versions.)

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

1. For each workspace consumer of `core` that pins it exactly (`cli`, `mcp`), check the
   `core` pin baked into the latest published artifact:
   ```sh
   for pkg in cli mcp; do
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
