// Sprint 0 PR 5 (#219): pin the test embedder to bge-small for hermetic CI.
if (!process.env.PLUR_EMBEDDER) {
  process.env.PLUR_EMBEDDER = 'bge-small'
}
// Sprint 0 iter-2 audit M-3: pin backend to sqlite for hermetic claw tests.
if (!process.env.PLUR_BACKEND) {
  process.env.PLUR_BACKEND = 'sqlite'
}
