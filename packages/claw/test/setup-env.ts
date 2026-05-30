// Sprint 0 PR 5 (#219): pin the test embedder to bge-small for hermetic CI.
if (!process.env.PLUR_EMBEDDER) {
  process.env.PLUR_EMBEDDER = 'bge-small'
}
