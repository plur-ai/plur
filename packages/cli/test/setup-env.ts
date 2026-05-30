// Sprint 0 PR 5 (#219): pin embedder so CLI integration tests stay fast.
if (!process.env.PLUR_EMBEDDER) {
  process.env.PLUR_EMBEDDER = 'bge-small'
}
// Sprint 0 iter-2 audit M-3: pin backend to sqlite — production default
// flipped to 'pglite' but the CLI suite is hermetic against the legacy path.
if (!process.env.PLUR_BACKEND) {
  process.env.PLUR_BACKEND = 'sqlite'
}
