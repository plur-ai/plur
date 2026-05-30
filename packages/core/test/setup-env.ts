/**
 * Vitest setup — runs in each worker before any test file.
 *
 * Sprint 0 PR 5 (#219) -> iter-2 B-2: the production default embedder is
 * BGE-small (~130 MB on first download). Tests pin it explicitly so the
 * suite stays fast and hermetic even if a future PR changes the production
 * default again. Tests that need the actual default override this themselves
 * (see embedder-default.test.ts).
 *
 * Sprint 0 iter-2 audit M-3: the production default backend flipped from
 * 'sqlite' to 'pglite' per ADR-0001. PGLite operations are slower than
 * IndexedStorage in tight loops because of WASM startup + per-test schema
 * init. The full suite pins PLUR_BACKEND=sqlite so most tests stay on the
 * fast path; tests that need PGLite set the env var themselves
 * (pglite-adapter.test.ts, pglite-recall-wiring.test.ts, reembed-migration
 * .test.ts, etc).
 */
if (!process.env.PLUR_EMBEDDER) {
  process.env.PLUR_EMBEDDER = 'bge-small'
}
if (!process.env.PLUR_BACKEND) {
  process.env.PLUR_BACKEND = 'sqlite'
}
