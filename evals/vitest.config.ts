import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Promise evals (evals/promises.yaml). Not part of `pnpm test`: the root config
// lists packages only. Run them with `pnpm evals` (the scoreboard) or
// `pnpm exec vitest run --config evals/vitest.config.ts <file>`.
//
// Evals import package SOURCE (../../packages/<pkg>/src/...), never dist, so a
// planted bug in evals/mutants/ takes effect without a rebuild.
export default defineConfig({
  resolve: {
    // Evals have no package.json of their own; borrow core's YAML parser rather
    // than add a root dependency.
    alias: { 'js-yaml': fileURLToPath(new URL('../packages/core/node_modules/js-yaml/index.js', import.meta.url)) },
  },
  test: {
    root: '.',
    include: ['evals/**/test_promise_*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**'],
    globals: true,
    // The real embedding model cold-loads on first use (quality evals).
    testTimeout: 120000,
    hookTimeout: 120000,
    // Evals share process-wide state (the embedder cache, env): one file at a time.
    fileParallelism: false,
    setupFiles: ['evals/helpers/setup.ts'],
  },
})
