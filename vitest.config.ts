import { defineConfig } from 'vitest/config'

// Replaces vitest.workspace.ts (audit fix, 2026-07-09): that file was being
// silently ignored by this vitest version (4.1.1) — confirmed empirically by
// injecting a top-level `throw` into it and observing zero effect on a full
// `pnpm test` run. Without any config at all, vitest fell back to auto-
// discovering every package.json in the tree, which also matched full copies
// of the repo living under git worktree checkouts (e.g.
// .worktrees/cursor-integration/packages/*) — running every test file TWICE,
// including stateful ones that share global tmpdir state
// (plur-cursor-sessions), which caused real cross-run interference (races on
// shared conversation IDs), not just slower/duplicate output.
//
// `test.projects` is the current (non-deprecated) multi-project mechanism.
// `test.exclude` also explicitly excludes .worktrees as a second, independent
// safety net in case a future refactor reintroduces a broader project glob.
export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/mcp', 'packages/cli', 'packages/claw'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**'],
  },
})
