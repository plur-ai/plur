# Contributing to PLUR

Thanks for contributing. This file covers how changes get reviewed and
merged. For the release process see [RELEASING.md](RELEASING.md); for
agent/automation working rules see [CLAUDE.md](CLAUDE.md).

## Reviewing and merging

Every change lands through a reviewed pull request — no direct pushes to
`main`.

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

Release commits and tags follow [RELEASING.md](RELEASING.md). The release is
guarded by a manifest gate that aborts on undeclared PRs before publish (see
plur-ai/plur#544) — don't work around it; declare the PRs.
