# Known Issues

This file tracks known, accepted issues for the current release line, with
machine-checkable sentinels that gate `release.sh` and CI.

## Stage 3b v2 — un-scoped write default (#177)

PR-1 (#353 audit) reverted the un-scoped WRITE default `local → global` and
fixed the READ side so no personal-family scope is excluded by a project-scoped
filter, on **all three read paths** (inject `scoreEngram`, the non-indexed
recall filter, and the default indexed SQLite path via a `personal` column),
using `isPersonalScope(scope) = !isSharedScope(scope)`.

Reverting the write default to `global` restores the cross-project bleed that
Stage 3b (#351) mitigated. Accepted for 0.10.0 because (a) the read-side
invisibility was a correctness blocker, and (b) `.plur.yaml` project-scope
config is the supported mitigation. The READ side is fully fixed; Stage 3b v2
re-implements the WRITE default behavior with the family-aware read filter as a
precondition.

STAGE3B_V2_TRACKING:https://github.com/plur-ai/plur/issues/362
