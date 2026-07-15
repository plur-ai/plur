# Contributing to PLUR

How to work with the monorepo, run tests, and ship a change.

For *what* the system is, see [README.md](README.md) and the [spec](spec/). For release mechanics, see [RELEASING.md](RELEASING.md).

## Setup

```bash
# Prerequisites: Node.js ≥ 22, pnpm
npm install -g pnpm

git clone git@github.com:plur-ai/plur.git
cd plur
pnpm install
```

## Building

```bash
pnpm build        # tsup builds all packages (core, mcp, claw)
pnpm typecheck    # tsc --noEmit across all packages
```

## Testing

```bash
pnpm test         # vitest run across all packages
pnpm test:watch   # vitest watch mode
```

Tests use in-memory state — no external deps required for the unit suite.

## Changesets

This monorepo uses [changesets](https://github.com/changesets/changesets) for versioning.

```bash
pnpm changeset    # describe what changed and which packages are affected
```

Every PR that changes user-facing behaviour in a published package needs a changeset file committed alongside it. See [RELEASING.md](RELEASING.md) for the full release flow.

## Making a change

### Workflow

1. **Issue first**: open or pick an issue in `plur-ai/plur`.
2. **Branch**: descriptive name, e.g. `fix-bm25-score` or `feat-pack-export`.
3. **Write tests first** for algorithmic or protocol-level changes.
4. **Commit early, push often**: one logical change per commit.
5. **PR with linked issue**: reference the issue in the PR description.
6. **Pre-merge**: `pnpm test` passes, `pnpm typecheck` passes, `pnpm build` succeeds.
7. **Merge to main**: after an approving review with checks green.

> **Never push to `main` directly.** Every change lands through a reviewed PR.

### Review gate

Once a pull request has a **`CHANGES_REQUESTED`** review, the following rules apply — even when there is no technical enforcement:

- **The reviewer clears the block.** Only the reviewer can resolve a `CHANGES_REQUESTED` — by re-reviewing and approving, or by explicitly dismissing their own review with a reason. The author does not merge by self-declaring "addressed."
- **After pushing fixes, re-request review and wait.** Do not merge before the approving review lands. The point of re-requesting review is that the *reviewer* verifies the fixes resolved their findings — the author's own assessment is what the re-review exists to check.
- **New commits after an approval restart the gate.** Get a fresh approving review before merging.

This applies even when the merge is not technically blocked (e.g. an admin account can bypass branch protection). Treat `CHANGES_REQUESTED` as a hard stop, not a suggestion. Inconsistent application erodes the process — if the gate is sometimes advisory, contributors stop trusting it.

## Code style

- **TypeScript strict mode** across all packages.
- **No new abstractions until the third copy.** Three similar lines is better than a premature abstraction.
- **Default to no comments.** Add one only when the WHY is non-obvious.
- **Zod for runtime validation** at package boundaries.
- **No circular deps** between packages (`core` has no dependency on `mcp` or `claw`).

## Package layout

| Package | Purpose |
|---|---|
| `packages/core` | Engram engine — storage, recall, scoring |
| `packages/mcp` | MCP server exposing core as tools |
| `packages/claw` | OpenClaw ContextEngine plugin |

Changes that affect the exchange protocol or engram schema must be reflected in `spec/` in the same PR.

## Getting help

- Architecture and design rationale: [spec/](spec/) and [ROADMAP.md](ROADMAP.md)
- Issues and discussion: `plur-ai/plur` GitHub issues
