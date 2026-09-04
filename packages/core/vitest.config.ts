import { defineConfig } from 'vitest/config'

// The PGLite suites are EXCLUDED here and run as a separate serial project
// (see the root vitest.config.ts). They are not excluded from the test run —
// only from the fully-parallel pool.
//
// Why: each PGLite suite boots a WASM Postgres *and* cold-loads the BGE
// embedder. Vitest runs files in parallel across every core, so in a full-suite
// run several start at once and starve each other, blow the 30s timeout, and
// report as failures. That is contention, not a defect — the same four files
// pass in isolation (40 passed, 1 skipped).
//
// It also made the release gate unreliable: release.sh hard-aborts on test
// failures, so a legitimate release randomly could not ship, and the tempting
// workaround (bypass the gate) is exactly how unreviewed code has shipped
// before. Fixing the contention is what makes the gate trustworthy.
//
// Raising the timeout was already tried for this class of problem — the 5s
// default went to 30s in #311 — and it regressed anyway. A third increase just
// moves the goalpost.
export const PGLITE_SUITES = [
  'test/pglite-*.test.ts',
  // Not named pglite, but PGLite-backed (it uses the same PGLITE_TIMEOUT) and
  // fails in the same way under load.
  'test/sync-index-error.test.ts',
  // Same again: boots PGLite AND cold-loads the embedder per case. Blew its
  // timeouts on three different cases across two 2026-08-18 release runs while
  // passing 14/14 alone — the exact pattern this pool exists for.
  'test/embedding-staleness-812.test.ts',
  // Pack install with a local HTTP stub server plus embedding of the pack's
  // engrams; starved under the same load, failed the same way, passes alone.
  'test/packs-url.test.ts',
  // Server-Postgres suite (ADR-0005). Same reason, one step further: it talks
  // to a real database and boots PGLite alongside it for the cross-adapter
  // parity check. Skips entirely unless PLUR_TEST_POSTGRES_URL is set.
  'test/postgres-*.test.ts',
]

// testTimeout raised from the 5s default: the BGE embedder (@huggingface/
// transformers) cold-loads lazily on first use, and that one-time model init
// can exceed 5s when several embedder-touching suites import in parallel under
// `vitest run` — a slow-but-correct load, not a hang. The tight default caused
// flaky CI timeouts (#311). hookTimeout matched so beforeAll/afterAll setup
// that also triggers a cold load doesn't trip either.
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    exclude: ['**/node_modules/**', '**/dist/**', ...PGLITE_SUITES],
    // The #1069 host breaker is process-global by design; without a per-test
    // reset it leaks "host down" verdicts across test files (see the helper).
    setupFiles: ['test/helpers/reset-remote-breaker-setup.ts'],
  },
})
