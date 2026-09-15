import { defineConfig } from 'vitest/config'
// testTimeout raised from the 5s default — same reason as claw and dsh: the
// embedder (reached transitively via @plur-ai/core) cold-loads lazily and can
// exceed 5s under parallel suite import, causing flaky timeouts (#311).
export default defineConfig({ test: { globals: true, testTimeout: 60000, hookTimeout: 60000, exclude: ['**/node_modules/**'] } })
