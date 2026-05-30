import { defineConfig } from 'vitest/config'

// Root vitest config — pinned to bge-small for the whole workspace test run.
//
// Sprint 0 PR 5 (#219): the production default embedder is EmbeddingGemma
// (768d, ~325 MB on first download). The test suite pins to bge-small
// (~130 MB, already cached on dev machines and CI image) so tests don't
// trigger a cold model download. Per-package vitest configs add their own
// setupFiles as a belt-and-suspenders defense in case the root config is
// bypassed by direct vitest invocation.
process.env.PLUR_EMBEDDER ??= 'bge-small'

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
  },
})
