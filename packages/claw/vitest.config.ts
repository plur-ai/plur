import { defineConfig } from 'vitest/config'

// Sprint 0 PR 5 (#219): pin embedder for hermetic CI runs.
export default defineConfig({
  test: {
    globals: true,
    exclude: ['**/openclaw-integration.test.mjs', '**/node_modules/**'],
    setupFiles: ['./test/setup-env.ts'],
  },
})
