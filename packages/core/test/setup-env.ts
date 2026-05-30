/**
 * Vitest setup — runs in each worker before any test file.
 *
 * Sprint 0 PR 5 (#219): the production default embedder is EmbeddingGemma
 * (~325 MB on first download). Tests pin to bge-small (~130 MB, already
 * cached on dev machines and CI) so the suite stays fast and hermetic.
 * Tests that need the actual default override this themselves
 * (see embedder-default.test.ts).
 */
if (!process.env.PLUR_EMBEDDER) {
  process.env.PLUR_EMBEDDER = 'bge-small'
}
