# Manifest gate — dry run against the tree, 2026-09-04

Sprint item S02-5. Walked `RELEASING.md`'s Step 3.6 manifest gate and the
version manifest **without publishing**, as the acceptance required. Five
findings; v0.20.0 cannot be cut until the first three are fixed.

Baseline: last tag `v0.19.4`. Compared `v0.19.4..origin/main`.

---

## 1. The gate would ABORT — no `## 0.20.0` section exists

`CHANGELOG.md` begins at `## 0.19.4`. Step 3.6 aborts when a user-facing PR
merged since the last tag is not declared in *this version's* section, and
there is no section to declare into.

Three user-facing commits are undeclared:

| Commit subject | PR | Type |
|---|---|---|
| `fix(batch): return per-item namespaced ids from plur_learn_batch (#930, #854)` | **#950** | fix — must be declared |
| `fix(core): strip line terminators in Plur.learn() (#952)` | **#953** | fix — must be declared |
| `fix(dsh): log load failures in loadEngine instead of swallowing them` | **#941** | fix — must be declared |

Skipped correctly by the gate's own rule (non-user-facing types): the two
`docs:` tool-count commits. Note one of those is written `fix(docs): correct
tool count to 43` — its TYPE is `fix`, so the gate will demand it even though
its scope is docs. Either declare it or re-word it; the gate reads the type.

Also worth resolving before writing the section: the two tool-count commits
disagree with each other. One says the full profile is 43, the other 44.

## 2. Half-done version bump — `packages/claw` is two minors behind

| Package | Version | Published |
|---|---|---|
| `packages/claw` | **0.17.1** | yes |
| `packages/cli` | 0.19.4 | yes |
| `packages/core` | 0.19.4 | yes |
| `packages/mcp` | 0.19.4 | yes |
| `packages/migrate` | 0.19.4 | yes |
| `packages/hermes` (pyproject) | 0.19.4 | yes |
| `packages/dsh` | 0.1.0 | yes — independent line, verify intentional |
| `packages/ui` | 0.1.0 | `private: true`, not published — fine |

`claw` is the exact case the acceptance predicted: a bump that stopped
part-way and is free to find now. Confirm whether `claw` is meant to track the
monorepo version or run its own line — `dsh` clearly runs its own, so the
answer is not automatic.

## 3. `v0.19.2` was tagged and never written up

The tag exists (2026-08-30) and `CHANGELOG.md` has no `## 0.19.2` section. It
jumps 0.19.3 → 0.19.1. Whatever shipped in 0.19.2 is undocumented.

## 4. The inverse — `0.18.1` was written up and never tagged

`CHANGELOG.md` has a `## 0.18.1` section; there is no `v0.18.1` tag. One of the
two is wrong.

## 5. Release dates were dropped after 0.17.2 — the CHANGELOG date fix

`## 0.17.2 (2026-08-04)` and `## 0.17.1 (2026-08-03)` carry dates. Every
section from 0.18.0 onward carries none. Dates recovered from the tags, ready
to apply:

```
## 0.18.0 (2026-08-18)
## 0.18.1 (no tag — see finding 4)
## 0.19.0 (2026-08-28)
## 0.19.1 (2026-08-29)
## 0.19.2 (2026-08-30)   <- section missing entirely, see finding 3
## 0.19.3 (2026-08-31)
## 0.19.4 (2026-08-31)
```

**Not applied here.** This checkout is on branch `rb946`, and editing
`CHANGELOG.md` on a feature branch is how the fix gets stranded — which is the
same failure mode as the 82 commits sitting off `main` in the Data repo. Apply
on `main` in one commit.

---

## What this run demonstrates

The task was selected by nightshift's own `find_ai_tasks`, carried `SURFACE:
core`, `ROADMAP: R-070` and a `DONE_WHEN` it could check itself, and finished
without needing anyone's approval — the acceptance stopped at "record what
would have failed", not at "merged". That boundary is the whole point of the
W37 sprint design.
