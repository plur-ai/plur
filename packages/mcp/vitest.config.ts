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
    //
    // isolate-home (shared with packages/cli): a temp HOME and no inherited
    // PLUR_PATH for every file. Suites that import the bin entry
    // (src/index.ts) start a stdio server in the worker, which opened the
    // default store and wrote server.pid into the real ~/.plur; the CLI
    // suite's real-home guard caught it in CI.
    setupFiles: [
      '../cli/test/setup/isolate-home.ts',
      'test/helpers/reset-remote-breaker-setup.ts',
      'test/helpers/folder-on-cwd-setup.ts',
    ],
  },
})
