import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.test.ts'],
    // Benchmarks spin up the embedder and run the harness; give them room.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
