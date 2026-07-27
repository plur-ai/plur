import { defineConfig } from 'vitest/config'
// testTimeout raised from the 5s default — same reason as core: the embedder
// (reached transitively via @plur-ai/core) cold-loads lazily and can exceed 5s
// under parallel suite import, causing flaky timeouts (#311).
//
// Raised again 30s -> 60s (2026-07-27). 30s was still not enough on the slowest
// CI runner: the two tests that reach `injectHybrid` — and only those two —
// timed out on Node 20 while Node 22/24 passed and every other test in the file
// went green. That is the signature of a slow model load, not broken logic.
//
// This is a mitigation, not a fix. The real answer is to stop paying a lazy
// model load inside a test at all (warm it once in a setup file, or stub the
// embedder for suites that do not assert on embedding quality) — a timeout can
// only ever be raised until the next slower runner. Tracked as follow-up.
export default defineConfig({ test: { globals: true, testTimeout: 60000, hookTimeout: 60000, exclude: ['**/openclaw-integration.test.mjs', '**/node_modules/**'] } })
