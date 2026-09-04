import { defineConfig } from 'vitest/config'
// testTimeout raised from the 5s default — same reason as core: the embedder
// (reached transitively via @plur-ai/core) cold-loads lazily and can exceed 5s
// under parallel suite import, causing flaky timeouts (#311).
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    // e2e-remote drives MCP → core → RemoteStore in-process, so the #1069
    // host breaker's process-global state leaks across tests here exactly as
    // it did in core (evaluator audit finding 6). Same per-test reset.
    setupFiles: ['test/helpers/reset-remote-breaker-setup.ts'],
  },
})
