import { defineConfig } from 'vitest/config'

// Sprint 0 PR 5 (#219): pin the test embedder to bge-small via setupFiles so
// the override runs in each worker before any test file evaluates. The
// production default is EmbeddingGemma (~325 MB); the test suite pins to
// bge-small (~130 MB, already cached) to stay hermetic and fast.
//
// testTimeout 30s — PGLite WASM startup can briefly exceed the vitest 5s
// default when many tests instantiate fresh PGLite instances concurrently.
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    setupFiles: ['./test/setup-env.ts'],
  },
})
