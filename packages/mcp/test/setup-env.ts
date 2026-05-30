// Sprint 0 PR 5 (#219): pin the test embedder to bge-small so MCP tests
// that touch recall don't trigger a large model download. Production
// code uses the bge-small default after iter-2 audit B-2.
if (!process.env.PLUR_EMBEDDER) {
  process.env.PLUR_EMBEDDER = 'bge-small'
}
// Sprint 0 iter-2 audit M-3: pin backend to sqlite for hermetic MCP tests.
// Production default is 'pglite' after the M-3 flip.
if (!process.env.PLUR_BACKEND) {
  process.env.PLUR_BACKEND = 'sqlite'
}
