// Sprint 0 PR 5 (#219): pin embedder so CLI integration tests stay fast.
if (!process.env.PLUR_EMBEDDER) {
  process.env.PLUR_EMBEDDER = 'bge-small'
}
