import { defineConfig } from 'vitest/config'

// The spawn-heavy suites are EXCLUDED here and run as a separate serial project
// (see the root vitest.config.ts). They are not excluded from the test run —
// only from the fully-parallel pool. Same shape, and the same reasoning, as
// core's PGLITE_SUITES.
//
// Why: each of these files spawns real CLI processes and waits on their exit,
// against fixed 5s/30s timeouts. Vitest runs files in parallel across every
// core, so under a full-workspace run — or alongside a concurrent vitest — the
// spawns contend for CPU and blow their budget while doing nothing wrong.
// Measured: hook-learn-check completes in ~2.6s in isolation against a 5s
// timeout, and fails under load. Four separate work sessions hit it on the same
// day (#786, #788, #790, #791, #792 all disclosed it).
//
// Raising the timeouts was rejected deliberately. It is the same goalpost-move
// that #311 already made once for the embedder (5s → 30s) and that regressed
// anyway, and it has a specific cost: a genuinely hung spawn takes longer to
// report, so the suite gets slower at exactly the moment it should be fastest.
// Serialising removes the contention instead of budgeting for it.
//
// The cost is bounded — these four files run one at a time while the rest of
// the CLI suite stays fully parallel — and the benefit is that a red suite
// means something again. A known-flaky baseline is worse than a slow one:
// today a real 55-test breakage was nearly attributed to the change under test
// because the suite's noise floor was not zero.
export const SPAWN_SUITES = [
  'test/hook-learn-check.test.ts',
  'test/hook-session-guard.test.ts',
  'test/list.test.ts',
  'test/tensions-lifecycle.test.ts',
]

export default defineConfig({
  test: {
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**', ...SPAWN_SUITES],
  },
})
