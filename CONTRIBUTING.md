# Contributing to PLUR

Thanks for helping build PLUR — persistent, composable memory for AI agents.
This monorepo holds seven packages: `@plur-ai/core` (the engine), `@plur-ai/mcp`
(the MCP server), `@plur-ai/claw` (the OpenClaw plugin), `@plur-ai/cli` (the CLI),
`plur-hermes` (Hermes Agent plugin), `plur-ai` (Python SDK), and `plur-langchain`
(LangChain adapter). For the release process see [RELEASING.md](RELEASING.md); for
agent/automation working rules see [CLAUDE.md](CLAUDE.md).

## Getting started

pnpm workspace monorepo. From the repo root:

```bash
pnpm install
pnpm build
pnpm test
```

All tests must pass before you commit. `@plur-ai/claw` imports core's built
`dist` (not source), so after changing core, rebuild it before running claw
tests:

```bash
pnpm --filter @plur-ai/core build
```

## Making a change

1. **Issue first.** Open or pick an issue that describes the change.

2. **Claim it before you write any code.** Self-assign the issue
   (`gh issue edit <n> --add-assignee @me`). If it is **already assigned to
   someone else**, comment to coordinate before you start — do **not** open a
   parallel fix. If you can't assign (no write access), comment "Starting on
   this," and check for an existing such comment first. Assignment is the only
   signal that stops two contributors landing the same fix. **This applies to
   autonomous agents as much as to people**: an automated run must self-assign,
   or skip the issue if it is already claimed by another party, before it
   starts implementing.

3. **Branch from `development`.** `development` is the integration branch,
   where all feature and fix work lands; `main` is the release branch. Cut
   your branch from an up-to-date `origin/development`, with a descriptive
   name, e.g. `fix-sync-conflict` or `feat-remote-store-retry`:

   ```bash
   git fetch origin
   git checkout -b fix-sync-conflict origin/development
   ```

   A fresh clone may check out `main`. Do not branch from it: work cut from
   `main` usually conflicts with `development` and has to be rebased before
   it can merge.

   **Stacked work.** A pull request that depends on another one still in
   review may branch from, and target, that pull request's branch.
   `integration/**` branches are the branches the overnight agent stacks its
   work on. Pull requests into them skip the GitHub test matrix (`ci.yml`);
   the full CI runs once, when the integration branch comes into
   `development` through its own pull request. Instead,
   `.github/workflows/stacked-local-proof.yml` checks each one:

   - The description has a line `Promises: ID, ID` naming the promises the
     change makes green. None of them may already be green in the base's
     `evals/baseline.json`, and each must be green when the workflow runs it
     again.
   - Only product source and product tests change (`packages/*/src`, and
     `packages/*/test` outside `test/helpers`). A manifest, the lockfile, a
     build or vitest config, a workflow, a script, a shared helper, an eval
     or docs are refused.
   - Pull requests from forks are not run.

   [evals/README.md](evals/README.md) also asks such a pull request to paste
   the output of `scripts/evals-local.sh gate <its base>` into its
   description; the workflow does not rely on it.

4. **Write tests.** Every change to behavior needs a test. Add unit tests in
   the affected package's `test/` directory (named `*.test.ts`). For changes to
   `RemoteStore`'s wire surface, extend the stub server in
   `packages/core/test/helpers/stub-server.ts`. See [docs/test-pyramid.md](docs/test-pyramid.md)
   for the unit / integration / smoke breakdown and when each layer applies.

5. **Keep core offline and free.** Core must work with no external API calls —
   search runs locally at zero cost. Don't introduce a runtime network
   dependency into `@plur-ai/core`.

6. **Open a PR into `development` with the linked issue.** Keep commits to
   one logical change each.

   Set the base branch explicitly. The GitHub UI and `gh pr create` may
   propose `main`:

   ```bash
   gh pr create --base development
   ```

   Link the issue with a closing keyword **repeated for every issue**:

   ```
   Closes #545, closes #547, closes #553
   ```

   GitHub binds the keyword to the **first** reference only, so
   `Closes #545, #547, #553` links `#545` and silently ignores the rest. A PR
   that closed nine issues this way linked one; seven were closed by hand
   afterwards and one was missed entirely, staying open for days after it had
   shipped.

   **Closing keywords do not fire on `development` yet.** GitHub closes a
   linked issue only when the pull request merges into the default branch,
   which is still `main`. A pull request into `development` gets no linked
   issues: `Closes #1514` in #1773 and `Closes #1761` in #1765 left both
   issues open after the merge. Until `development` becomes the default
   branch, keep the closing keywords (repeated for every issue, as above) for
   traceability, and close each linked issue by hand once the pull request
   has merged. For work that only partly fixes an issue, write `Part of #N`
   instead.

7. **Green before merge.** `pnpm test` and `pnpm build` must pass.

8. **Record the outcome on the issue.** Closing keywords, or closing by hand
   while they do not fire on `development` (step 6), cover the ordinary case.
   When they don't — a partial fix, a change of approach, or work with
   no diff to point at — say so on the issue itself.

   This matters most for **configuration and process changes**, which leave no
   trace in the repository. A branch-protection issue had two of its four
   options implemented within a day and was never updated; the next reader had
   to re-derive the current state from the API to find out what was left.

### Labels and @-mentions are signals, not assignments

A label (`P0`, `enhancement`, `research`, …) *describes and prioritizes* an
issue — it is triage and FYI, and never means anyone has committed to doing the
work. @-mentioning someone in a comment informs them; it does not assign them.
**Only assignment creates an expectation that the work will happen.**

- **Working on it?** Assign it to yourself (see step 2).
- **Want someone else to do it?** Assign it to *them* — don't just label the
  issue or @-mention them and assume it will be picked up.
- **Handing off work you were assigned?** Reassign it to the new owner and say
  why, so the assignee always reflects who is actually on it.
- **Unassigned means nobody is on it**, no matter how many labels it carries.

This binds autonomous agents as much as people: a label is never a work order.

### What the priority labels oblige

Priority is a claim about *sequencing*, not about how much you care. Each level
carries an obligation, and a level that obliges nothing is noise:

| Label | Means | Obligation |
|---|---|---|
| `P0` | Drop other work | Someone is on it now. Expect roughly one open at a time |
| `P1` | Before the next release | Assigned, or explicitly next up. **Target: 8 open** |
| `P2` | Wanted, not scheduled | None. The honest default for real work with no date |
| `P3` | Would accept a PR | None |

**Check the existing set before adding `P1`.** The label is a comparison, not a
description: if the set is already at target, adding one means demoting
another. A backlog where a third of open issues are `P1` has stopped
distinguishing anything — the target exists to make that visible at filing
time rather than at audit time.

**Re-level rather than let age do it silently.** A `P0` or `P1` that nobody has
touched in three weeks is evidence about the label, not about the work. Lower
it, or assign it.

## Reviewing and merging

Every change lands through a reviewed pull request — no direct pushes to
`main` or `development`. The one exception is the release commit: when there
is a version bump to commit, `scripts/release.sh` commits it
(`chore: release vX.Y.Z`) and pushes it straight to `main` with its tag.
When the versions were already bumped (0.22.0), it only tags the commit it
verified. Branch protection on `development` requires only the CI checks,
not a pull request or a review, and does not bind admins: the whole rule —
through a pull request, with a review — is policy there, not enforced.

Which branch a pull request targets:

1. **Feature and fix pull requests target `development`.** This is the
   normal case; see "Making a change" above.

2. **`main` receives release promotions from `development`, plus the
   exceptions below.** A promotion is a pull request from `development` into
   `main`, titled like "Release X.Y.Z: promote development to main" (#1775,
   #1799, #1804).
   See "Releases" below.

3. **Release-time fixes may target `main`.** These are fixes the release
   itself needs before it can finish, such as a changelog correction the
   manifest gate asks for (#1777, #1805) or a fix to the release script
   (#1778).

4. **Whatever lands on `main` goes back to `development`.** After a fix
   merges into `main`, open a pull request from `main` into `development`
   ("Merge main into development after the X.Y.Z release", #1779), so the
   next promotion neither conflicts nor drops the fix.

5. **A fix for a published version (a hotfix): ask the maintainers first.**
   There is no fixed rule yet. Since `development` began (#1656, 2026-10-18),
   one fix for a published version went straight into `main`: #1781, shipped
   as 0.22.1, came back to `development` through #1779. #1652 and #1206 also
   merged into `main`, on 2026-10-21, but were opened before `development`
   existed; they came back through #1766. Do not open a pull request against
   `main` for a hotfix without a maintainer's agreement.

Review rules:

- **A `CHANGES_REQUESTED` review is a block, not a suggestion.** The
  **reviewer** clears it — by re-reviewing and approving, or by dismissing
  their own review. The author does not merge over a standing
  `CHANGES_REQUESTED` by self-declaring the items addressed. After you push
  fixes, **re-request review and wait for the approval** before merging.
  Posting "addressed all items" and merging minutes later defeats the
  re-review, whose whole purpose is that the *reviewer* confirms the fixes
  actually resolve the findings.
- **New commits after an approval dismiss that approval** — get a fresh
  approving review before merge.
- **Admin override / bypassing the review gate is a human-only action of last
  resort, and must be explained.** It is reserved for a person in a clearly
  justified case — e.g. an emergency hotfix, or a CI/infra outage blocking an
  otherwise-approved PR. When a human overrides, they **must say so in a PR
  comment: that it was deliberate, and why.** An unexplained override is
  indistinguishable from impatience; the rationale is what makes it a decision
  rather than a bypass. **Automation must never merge via admin override** — if
  a bot cannot clear the gate legitimately (an approving review and green
  checks), it hands off to a human.

## Releases

A release reaches `main` in three steps:

1. **Promote.** A pull request from `development` into `main` carries the
   release (#1775, #1799, #1804). A release can take more than one
   promotion, when fixes land on `development` after the first one.

2. **Release from `main`.** After the promotion merges, the release runs from
   `main`: `scripts/release.sh <version>` refuses to run unless the checkout
   is `main` and equals `origin/main`. Release commits and tags follow
   [RELEASING.md](RELEASING.md).

3. **Merge back.** If the release left commits on `main` that `development`
   lacks (release-time fixes, the release commit), bring them back with a
   pull request from `main` into `development` (#1779).

The release is guarded by a manifest gate that aborts on undeclared PRs before
publish (see plur-ai/plur#544) — don't work around it; declare the PRs.

## Conventions

- **A field is not delivered until something reads it at the point of decision.**
  Capturing a value and storing it correctly is half a feature. Name the surface
  that consumes it, and write the test that proves it appears there, in the same
  change that adds the field. If you cannot name a reader, you have added a
  column, not a capability.

  This is the most expensive recurring mistake in this repository, and it does
  not look like a bug — everything works, the field is populated, tests pass.
  Four fields on the engram (`origin`, `chain`, `signature`, `license`) sat
  written-by-nothing for a year (plur-ai/plur#958). `claim_class` was then
  captured correctly and read only by a provenance record, which nobody asks for
  mid-session — so an inferred guess and a stated fact still rendered
  identically in the injected context, which an outside contributor had to point
  out to us.

  The question to ask on any new field: **who reads this, and are they reading it
  at the moment the decision gets made?** A field read only by an artifact
  produced on request is not read at the moment of decision. `field-readers.test.ts`
  enforces this for trust-bearing fields; add yours to that list.
- TypeScript, Vitest, tsup, Zod for validation.
- YAML for persistent storage (not JSON, not SQLite for primary data; SQLite is used only as an optional read index — YAML is always the source of truth).
- Engram id grammar is specified in
  [spec/ENGRAM-STANDARD-v1.md §3](spec/ENGRAM-STANDARD-v1.md): new ids are
  `ENG-YYYY-MM-DD-NNN` (same shape locally and server-assigned); the legacy
  compact `ENG-YYYY-MMDD-NNN` stays valid and every parser must accept both;
  packs use dateless `ENG-PACK-{NAME}-NNN`; merged store ids get a 3-letter
  prefix (`ENG-XXX-…`). Never write code that assumes only one date shape.
- **Qualify cross-repository references.** Write
  `plur-ai/enterprise#428`, not `enterprise#428`. A bare `#N` is read as an
  issue in *this* repository by GitHub, by tooling, and by anyone skimming —
  two such references produced false matches in a backlog audit, each appearing
  to be work landing on an unrelated local issue.
- No AI attribution in commits, PRs, or issues: do not add `Co-Authored-By:` AI
  lines, `🤖 Generated with` footers, or any other AI-assistant credit to commits,
  PR descriptions, or issue comments.
- Apache-2.0 licensed — by contributing you agree your contribution is
  licensed under the same terms.

## Reporting bugs and requesting features

Open an issue with a clear description and, for bugs, the smallest reproduction
you can manage. Check open issues first to avoid duplicates.

**Label it when you file it — a TYPE and a priority.** TYPE is what kind of
work it is (`bug`, `enhancement`, `documentation`, `feature`, `research`,
`testing`, `proposal`); priority is one of `P0`–`P3` as defined above. An
unlabelled issue is invisible to every label-based view, which is how two audit
requests sat in the backlog carrying no labels at all.

**This binds automated runs too.** Both unlabelled issues were filed by
automation, and an agent that can open an issue can set its labels in the same
call.
