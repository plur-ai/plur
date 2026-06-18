// Sprint 0 PR 5 (#219): pin embedder for benchmark smoke tests so CI runs
// don't trigger an EmbeddingGemma download. Real bake-off runs invoke the
// CLI with PLUR_EMBEDDER set explicitly.
if (!process.env.PLUR_EMBEDDER) {
  process.env.PLUR_EMBEDDER = 'bge-small'
}
// Sprint 0 iter-2 audit M-3: production default backend flipped to 'pglite'.
// PGLite spin-up cost in benchmark smoke tests adds 20-60s per test; force
// 'sqlite' (overriding even if previously set) to keep the suite hermetic.
// Real benchmark runs set PLUR_BACKEND explicitly via the CLI; the in-process
// runBenchmark() invoked from tests should always use the fast legacy path.
process.env.PLUR_BACKEND = 'sqlite'
