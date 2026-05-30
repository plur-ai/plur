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
// Iter-3 audit F-CTO-NEW-001 / F-DATA-NEW-005: PGLite WASM is process-global
// and does not tolerate the threaded shared-state pool. With pool: 'forks'
// alone, mass-parallel forks can still race on PGLite WASM init (mkdir
// ENOENT, "PGlite failed to initialize properly"). Capping maxForks keeps
// the fork count below the threshold where this race manifests on dev
// laptops and CI runners. Defaults to 4; override via VITEST_MAX_FORKS.
//
// testTimeout 30s — PGLite WASM startup can briefly exceed the vitest 5s
// default when many tests instantiate fresh PGLite instances concurrently.
const maxForks = Number(process.env.VITEST_MAX_FORKS) || 4

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    setupFiles: ['./test/setup-env.ts'],
    pool: 'forks',
  },
  // Vitest 4 moved poolOptions from `test.poolOptions` to the top-level
  // `poolOptions` config field. Keep them here so the deprecation warning
  // stays silent and the cap actually applies.
  poolOptions: {
    forks: {
      maxForks,
    },
  },
})
