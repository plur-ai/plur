import { defineConfig } from 'vitest/config'

// Sprint 0 PR 5 (#219): pin embedder for hermetic CI runs.
export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.test.ts'],
    // Benchmarks spin up the embedder and run the harness; give them room.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    setupFiles: ['./setup-env.ts'],
  },
})
