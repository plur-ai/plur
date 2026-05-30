import { defineConfig } from 'vitest/config'

// Sprint 0 PR 5 (#219) / iter-2 audit B-2: pin the test embedder to
// bge-small via setupFiles so the override runs in each worker before any
// test file evaluates. The production default is bge-small after iter-2 B-2.
//
// Iter-2 audit M-3: production default backend flipped to 'pglite'. Test
// suite pins PLUR_BACKEND=sqlite for hermeticity. We use pool: 'forks' so
// each test file gets its own process and env-var changes (e.g. tests that
// flip PLUR_BACKEND to 'pglite' temporarily) don't leak to concurrent files.
//
// testTimeout 30s — PGLite WASM startup can briefly exceed the vitest 5s
// default when many tests instantiate fresh PGLite instances concurrently.
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    setupFiles: ['./test/setup-env.ts'],
    pool: 'forks',
  },
})
