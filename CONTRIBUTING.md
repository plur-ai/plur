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

3. **Branch.** Use a descriptive name, e.g. `fix-sync-conflict` or
   `feat-remote-store-retry`.

4. **Write tests.** Every change to behavior needs a test. Add unit tests in
   the affected package's `test/` directory (named `*.test.ts`). For changes to
   `RemoteStore`'s wire surface, extend the stub server in
   `packages/core/test/helpers/stub-server.ts`.

5. **Keep core offline and free.** Core must work with no external API calls —
   search runs locally at zero cost. Don't introduce a runtime network
   dependency into `@plur-ai/core`.

6. **Open a PR with the linked issue.** Keep commits to one logical change each.

7. **Green before merge.** `pnpm test` and `pnpm build` must pass.

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

## Conventions

- TypeScript, Vitest, tsup, Zod for validation.
- YAML for persistent storage (not JSON, not SQLite for primary data).
- Apache-2.0 licensed — by contributing you agree your contribution is
  licensed under the same terms.

## Reporting bugs and requesting features

Open an issue with a clear description and, for bugs, the smallest reproduction
you can manage. Check open issues first to avoid duplicates.
