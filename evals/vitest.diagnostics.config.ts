import { defineConfig } from 'vitest/config'
import base from './vitest.config'

// Tests that live beside the promise evals but are NOT promise evals: unit
// tests of eval helpers (graders proven on synthetic transcripts) and
// diagnostic measurements that no promise is attached to. They are never
// collected by `pnpm evals` (the scoreboard and its id pattern only see
// test_promise_*), so they cannot turn a promise green or red. Run them with
//   pnpm exec vitest run --config evals/vitest.diagnostics.config.ts [file]
// (Not mergeConfig: it would concatenate `include` with the promise pattern.)
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['evals/helpers/**/*.unit.test.ts', 'evals/diagnostics/**/*.test.ts'] },
})
