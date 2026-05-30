import { defineConfig } from 'vitest/config'

// Sprint 0 PR 5 (#219): pin embedder for hermetic CI runs.
// Iter-2 audit M-3: pool: 'forks' for env-var isolation between files.
export default defineConfig({
  test: {
    globals: true,
    exclude: ['**/openclaw-integration.test.mjs', '**/node_modules/**'],
    setupFiles: ['./test/setup-env.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
})
