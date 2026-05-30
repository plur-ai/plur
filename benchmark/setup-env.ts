// Sprint 0 PR 5 (#219): pin embedder for benchmark smoke tests so CI runs
// don't trigger an EmbeddingGemma download. Real bake-off runs invoke the
// CLI with PLUR_EMBEDDER set explicitly.
if (!process.env.PLUR_EMBEDDER) {
  process.env.PLUR_EMBEDDER = 'bge-small'
}
