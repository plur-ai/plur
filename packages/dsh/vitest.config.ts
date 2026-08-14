import { defineConfig } from 'vitest/config'

// testTimeout raised from the 5s default for the same reason as packages/claw:
// @plur-ai/core cold-loads the embedder lazily and can exceed 5s under parallel
// suite import. The e2e suite boots a real dsh runtime and runs from its own
// config (vitest.e2e.config.ts), so it is excluded here.
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60000,
    hookTimeout: 60000,
    exclude: ['**/node_modules/**', '**/test/e2e/**'],
  },
})
