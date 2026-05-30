import { defineConfig } from 'vitest/config'
// 30s default test timeout — PGLite WASM startup can briefly exceed the
// vitest 5s default when many tests instantiate fresh PGLite instances
// concurrently. Most tests finish in milliseconds; the timeout only
// matters as a safety valve.
export default defineConfig({ test: { globals: true, testTimeout: 30_000 } })
