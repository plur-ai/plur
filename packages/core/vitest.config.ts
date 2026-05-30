import { defineConfig } from 'vitest/config'
// testTimeout/hookTimeout 30s: PGLite WASM startup AND the BGE embedder's lazy
// cold-load (@huggingface/transformers) can each exceed the vitest 5s default
// under parallel suite import (#311). hookTimeout matched so a cold load in
// beforeAll/afterAll doesn't trip either.
//
// pool: 'forks' + maxForks: PGLite WASM is process-global and races on init
// under the threaded pool / mass-parallel forks (mkdir ENOENT, "PGlite failed
// to initialize properly"). Each test file gets its own process; the fork cap
// keeps the count below the race threshold. Defaults to 4; override via
// VITEST_MAX_FORKS.
const maxForks = Number(process.env.VITEST_MAX_FORKS) || 4

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
  poolOptions: {
    forks: {
      maxForks,
    },
  },
})
