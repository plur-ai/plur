# ADR-0006: Report only what was confirmed

Status: **Proposed**
Date: 2026-08-12
Authors: independent review pass over #842 / #849 / #851 / #853 / #855 / #856 / #859
Related: [#854](https://github.com/plur-ai/plur/issues/854), [#831](https://github.com/plur-ai/plur/issues/831), [#835](https://github.com/plur-ai/plur/issues/835), [#861](https://github.com/plur-ai/plur/issues/861), [#772](https://github.com/plur-ai/plur/issues/772), [#860](https://github.com/plur-ai/plur/issues/860)

## Context

A single review pass across seven PRs surfaced the same defect five times, in unrelated subsystems written at different times. In each case a caller-visible outcome was derived from **control flow reaching a point** rather than from **observing the effect**:

| Where | The claim | What was actually true |
|---|---|---|
| `packages/mcp/src/tools.ts` — `plur_learn` | Returns hardcoded `decision: 'ADD'` | The write path may have deduplicated, updated, or merged. The handler never asks |
| `packages/core/src/learn-async.ts` (pre-[#856](https://github.com/plur-ai/plur/pull/856)) | `decision = 'ADD'` when no LLM was configured | Only an exact content-hash check ran. A hash-only write reported identically to a semantically checked one |
| `.github/workflows/pr-issue-guard.yml` | `core.info("Auto-assigned #N to @user")` | `addAssignees` returns **201 and silently ignores** non-permitted logins. Logged success, nothing assigned ([#861](https://github.com/plur-ai/plur/issues/861)) |
| `.github/workflows/issue-mention-guard.yml` ([#859](https://github.com/plur-ai/plur/pull/859)) | Same, copied | Same, plus 6 of 8 measured firings targeted an npm scope rather than a person |
| `Plur.forget()` (pre-[#855](https://github.com/plur-ai/plur/pull/855)) | Success plus the retired statement | Resolved primary-first across colliding ids and "reported success and echoed a statement the caller had never written" ([#831](https://github.com/plur-ai/plur/issues/831)) |

Two properties make this class expensive rather than merely untidy.

**It is invisible by construction.** The failure produces a success message, so nothing in logs, tests, or CI distinguishes it from working code. All five shipped with green suites. [#854](https://github.com/plur-ai/plur/issues/854) is the cost: 131 near-duplicate engrams across 63 clusters accumulated for five months because a write that had never been semantically checked reported the same `ADD` as one that had.

**Absence of an exception is not evidence of an effect.** The dominant failure mode in the dependencies this codebase calls is a silent no-op, not a throw. GitHub's REST documentation for adding assignees states it outright: *"Only users with push access can add assignees to an issue. Assignees are silently ignored otherwise."* A `try`/`catch` cannot observe that, and two workflows are built on the assumption that it can.

The convention is already emergent in the codebase's better moments — it has simply never been written down, so each subsystem rediscovers or misses it independently.

## Decision

**A reported outcome must be derived from an observation of the effect. Where the observation did not happen, the report must say so rather than defaulting to the value that means "checked and fine".**

Three clauses:

**1. Confirm, do not infer.** When an operation can partially succeed or silently drop, verify the effect before claiming it. Prefer the response you already have over a second request — `addAssignees` returns the updated issue, so verification is free:

```js
const { data: updated } = await github.rest.issues.addAssignees({ … })
if (!(updated.assignees || []).some(a => a.login.toLowerCase() === login.toLowerCase())) {
  // silently-ignored assignee — handle alongside the existing catch
}
```

**2. "Not checked" is a distinct outcome, not the happy path.** When the check that would justify a claim did not run, the return value must carry that fact. Never fall back to the value that means the check ran and passed. The tri-state introduced by [#856](https://github.com/plur-ai/plur/pull/856) is the model:

```ts
dedup?: { mode: 'llm' | 'cosine' | 'hash-only' }
//                                  ^ an ADD here means "not identical",
//                                    NOT "not a duplicate"
```

**3. Unmeasured must be distinguishable from measured-zero, and consumers must not collapse them.** `undefined` means "we did not look"; `[]` means "we looked and found none". `?? []` at a call site destroys that distinction and is the anti-pattern. [#853](https://github.com/plur-ai/plur/pull/853)'s `missing_array_params` documents the rule precisely and is the reference implementation.

### Applies to

Any value a caller, log reader, or future audit could mistake for a verified fact: MCP tool responses, `core.info`/`core.warning` in workflows, forensic log records, CLI output, and the return types behind all of them.

### Reviewer checklist

- For every success or decision value in the diff: what observation produced it? If the answer is "we got here without throwing", that is this defect.
- Does the external call being trusted have a documented silent-drop or partial-success mode?
- If a check can be skipped (no LLM, no embedder, degraded store), does the return value distinguish skipped from passed?
- Is any discriminator that already exists actually plumbed through to a caller? An unexposed one is decoration — see Consequences.

## Why not the obvious alternatives

**Why not just add tests?** Tests pin the code path, not the truthfulness of the claim. All five instances shipped green, and in [#853](https://github.com/plur-ai/plur/pull/853) a test actively pinned the bias it was meant to catch — its deletion is what unblocked the fix. A test asserting `decision === 'ADD'` on a path that never checked anything reinforces the defect.

**Why not make everything throw?** Fail-open is deliberately correct in several places, and this ADR does not disturb it. Local similarity in `learn-async.ts` must never gate a write; `recordPayloadDrop` must never break the call it is diagnosing. The rule constrains what is *reported*, not how hard failure is escalated. Degrading and saying so is correct; degrading and claiming success is not.

**Why not treat this as a style rule in CONTRIBUTING.md?** It bears on cross-cutting invariants — what a caller may conclude from a response, and what an audit trail is worth — and it has already been violated in five subsystems by different authors. It needs rationale and rejected alternatives attached, which is what an ADR carries and a style bullet does not.

## Consequences

### Positive

- A caller can act on a response. Today `decision: 'ADD'` from `plur_learn` supports no inference at all.
- Silent degradation becomes visible at the moment it happens rather than five months later via a manual similarity scan.
- Forensic logs become admissible evidence. A log that records success for events that did not occur is worse than no log, because it is trusted.

### Negative

- Read-after-write costs a request in paths where the response does not already carry the effect.
- Return shapes grow discriminators, and every one is a compatibility surface. [#853](https://github.com/plur-ai/plur/pull/853)'s optional-field handling is the pattern for adding them without breaking existing records.
- **The real cost is plumbing, and skipping it wastes the work.** [#856](https://github.com/plur-ai/plur/pull/856) adds `dedup.mode` and `near_duplicates` to `LearnAsyncResult`, then drops both in the `plur_learn_batch` handler and never reaches `plur_learn` at all. A discriminator no caller can see satisfies the letter of this ADR and none of its purpose.

### Follow-up work this implies

- [#861](https://github.com/plur-ai/plur/issues/861) — `pr-issue-guard.yml` read-after-write. Clause 1, already filed.
- `plur_learn` should return the real decision from the write path instead of a literal, and surface `dedup.mode`. Clause 2, not yet filed.
- [#860](https://github.com/plur-ai/plur/issues/860) — the open decision on detecting silently-dropped optional array params is the same clause applied to the transport layer: a tool call currently reports success for a payload that arrived incomplete.

## Precedent in the codebase

Written down because these got it right, not as new invention:

- `dedup: { mode: 'llm' | 'cosine' | 'hash-only' }` — [#856](https://github.com/plur-ai/plur/pull/856), clause 2.
- `missing_array_params?: string[]` with its `undefined` ≠ `[]` doc comment — [#853](https://github.com/plur-ai/plur/pull/853), clause 3.
- `core_installed` in `scripts/release.sh` — [#842](https://github.com/plur-ai/plur/pull/842) tracks whether the install actually resolved rather than inferring from a reused exit code, which is clause 1 in a shell script. Keying on the installed version instead would have misfiled a version mismatch as propagation lag.
- `embeddingSearchWithScores` returning `[]` when the embedder is unavailable, with the caller reading that as "similarity did not run" rather than "nothing was similar" — clause 3 at an internal boundary.
