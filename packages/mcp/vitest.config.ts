import { defineConfig } from 'vitest/config'

// Sprint 0 PR 5 (#219): pin the test embedder to bge-small. After iter-2
// audit B-2 the production default is also bge-small.
//
// Iter-2 audit M-3: production default backend flipped to 'pglite'. Use
// pool: 'forks' so each test file gets its own process and env-var changes
// don't leak to concurrent files.
export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./test/setup-env.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
})
