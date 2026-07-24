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
// The `core-pglite` project exists to remove resource contention, not to
// quarantine failures. Each PGLite suite boots a WASM Postgres and cold-loads
// the BGE embedder; run in the fully-parallel pool alongside the other 107 core
// files, several start at once, starve each other, and blow their 30s timeout —
// reporting as failures despite passing in isolation. That made `release.sh`
// (which hard-aborts on test failures) randomly unable to ship a legitimate
// release. These four files now run serially, in their own pool, with headroom.
// The other 107 core files stay fully parallel, so the suite stays fast.
export default defineConfig({
  test: {
    projects: [
      'packages/core', // excludes the PGLite suites — see packages/core/vitest.config.ts
      'packages/mcp',
      'packages/cli',
      'packages/claw',
      {
        test: {
          name: 'core-pglite',
          root: 'packages/core',
          globals: true,
          include: ['test/pglite-*.test.ts', 'test/sync-index-error.test.ts', 'test/pr5-hardening.test.ts'],
          // The whole point: one file at a time, so no two WASM Postgres
          // instances are booting concurrently.
          fileParallelism: false,
          // Generous, because serial execution means a slow run costs wall-clock
          // rather than correctness. A timeout here should mean a real hang.
          testTimeout: 120000,
          hookTimeout: 120000,
        },
      },
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**'],
  },
})
