# PLUR — Release Process Pitfalls

*Last updated: 2026-07-09*

> Scope note: this file intentionally covers only the release-process incident of 2026-07-09
> (v0.12.0 → v0.13.0). It is not a full architecture/onboarding overview — the project has none
> yet. Extend this file with an architecture section separately if one is ever written.

## What Happened (v0.12.0 incident, 2026-07-09)

A `0.12` branch had been created earlier to hold back an unaudited 25-commit batch of nightshift
agent ("Miles") features from release — but that branch only ever *added a reference*; it never
removed those commits from `main`. When `feat/cursor-integration` was later merged into `main`
(merge commit `e6b262d`), the merge was checked for "does the source branch have the right
commits" but `main`'s own state was never diffed against the last audited point. `main` already
carried the full unaudited batch, so `chore: release v0.12.0` (`94e0d4d`) shipped all 11
unreviewed features to npm/PyPI/GitHub — directly contradicting an explicit prior instruction to
hold them back for audit and ship an audited 0.11 instead.

Recovery: rather than reusing or unpublishing `v0.12.0`, the fix was built as a fresh release from
the last known-good tag (`v0.11.0`) forward — `v0.13.0` (`f4ef1ac`) is a descendant of `v0.11.0`,
not of `v0.12.0`'s bad state. `v0.12.0` was deprecated, not unpublished. The CHANGELOG entry for
0.13.0 states only "some features originally slated for this release were pulled back before
shipping because they weren't sufficiently tested" — deliberately scoped, per explicit
instruction, with no postmortem detail.

## Pitfalls

- **A branch that "holds back" commits only works if it removes them from the target too.**
  Creating `0.12` to quarantine unaudited work did nothing, because `main` was never rebased or
  reset to drop those commits — the quarantine branch and `main` diverged in name only. Before
  trusting a holdback branch, verify `git log <holdback-branch>..main` is empty (or contains only
  intended commits).

- **Check the merge *target*, not just the merge *source*.** The `feat/cursor-integration` merge
  was validated against what the feature branch was supposed to contain. Nobody checked whether
  `main` itself had already accumulated commits that shouldn't ship. Before merging into a shared
  branch, diff the target against the last known-good/audited tag first.

- **A bad npm version number cannot be reclaimed.** `npm unpublish` does not free `0.12.0` for
  reuse — npm blocks republishing an identical version string regardless. The correct recovery is
  `npm deprecate @plur-ai/<pkg>@0.12.0 "<message>"` plus a version bump (`0.13.0`), never an
  unpublish-and-reuse attempt.

- **Recover on a fresh branch from the last known-good tag, not by rewriting `main` live.**
  `v0.13.0` was built as a descendant of `v0.11.0`, sidestepping `v0.12.0`'s bad commits entirely.
  Reconciling `main`'s actual history with this state is a separate, lower-urgency follow-up — do
  not try to rewrite/force-push shared history live during incident response, and do not take any
  unilateral git remediation action on `main` without asking first.

- **`scripts/release.sh` had two latent bugs, both now fixed, both rooted in npm's post-publish
  propagation delay window:**
  - A dead `vitest.workspace.ts` was silently ignored once vitest 4.1.1 changed its workspace-config
    API, causing duplicate test discovery via worktree globbing. Fixed by replacing it with
    `vitest.config.ts` (`test.projects`) — see commit `8eaf731`/`fc1d574`.
  - An unguarded `smoke_out=$(npx ...)` command substitution crashed the whole script under
    `set -euo pipefail` instead of degrading into the script's own failure-handling path. Fixed
    with the exit-code-capture idiom: `cmd && var=0 || var=$?` (see `scripts/release.sh` line
    ~424). Any future `$(...)` substitution added to this script that can legitimately fail must
    use this pattern, not a bare assignment.

- **A test failure that only appears under the full parallel suite is not automatically a real
  defect.** A pglite/WASM `ErrnoError` surfaced during recovery testing; re-running the exact
  failing files in isolation passed cleanly, confirming resource contention under parallel load,
  not a logic bug. Reproduce in isolation before treating a parallel-only failure as real.

- **`plur-ai/website` has version references outside the monorepo's automated bump tooling.**
  `index.html`'s `softwareVersion` field and CLI install snippets are hardcoded and NOT covered by
  the ~9-location automated version-bump process. This has now been missed on both the 0.11.0 and
  0.13.0 bumps — check it manually on every release until the bump tooling is extended to cover
  the website repo.

## Standing Process Mandate (as of 2026-07-09)

Following this incident: **all features require explicit sign-off before being included in a
release** — no exceptions for autonomous-agent-authored work (nightshift/"Miles" specifically).
This is a hard gate on merges into any release-bound branch, not a best-practice suggestion. See
`.datacore/learning/preferences.md` ("Release Process Preferences") for the full statement.
