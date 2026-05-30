// Sprint 0 PR 5 (#219): pin the test embedder to bge-small so MCP tests
// that touch recall don't trigger an EmbeddingGemma download. Production
// code uses the embedding-gemma default.
if (!process.env.PLUR_EMBEDDER) {
  process.env.PLUR_EMBEDDER = 'bge-small'
}
