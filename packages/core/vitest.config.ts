import { defineConfig } from 'vitest/config'
// testTimeout raised from the 5s default: the BGE embedder (@huggingface/
// transformers) cold-loads lazily on first use, and that one-time model init
// can exceed 5s when several embedder-touching suites import in parallel under
// `vitest run` — a slow-but-correct load, not a hang. The tight default caused
// flaky CI timeouts (#311). hookTimeout matched so beforeAll/afterAll setup
// that also triggers a cold load doesn't trip either.
export default defineConfig({ test: { globals: true, testTimeout: 30000, hookTimeout: 30000 } })
