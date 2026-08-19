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
   `packages/core/test/helpers/stub-server.ts`. See [docs/test-pyramid.md](docs/test-pyramid.md)
   for the unit / integration / smoke breakdown and when each layer applies.

5. **Keep core offline and free.** Core must work with no external API calls —
   search runs locally at zero cost. Don't introduce a runtime network
   dependency into `@plur-ai/core`.

6. **Open a PR with the linked issue.** Keep commits to one logical change each.

   Link the issue with a closing keyword **repeated for every issue**:

   ```
   Closes #545, closes #547, closes #553
   ```

   GitHub binds the keyword to the **first** reference only, so
   `Closes #545, #547, #553` links `#545` and silently ignores the rest. A PR
   that closed nine issues this way linked one; seven were closed by hand
   afterwards and one was missed entirely, staying open for days after it had
   shipped.

7. **Green before merge.** `pnpm test` and `pnpm build` must pass.

8. **Record the outcome on the issue.** Closing keywords cover the ordinary
   case. When they don't — a partial fix, a change of approach, or work with
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
