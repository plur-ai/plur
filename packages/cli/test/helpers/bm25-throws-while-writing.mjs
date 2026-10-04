/**
 * Test preload (`node --import <this> cli.js hook-inject ...`): the hook's BM25
 * fallback throws, but only once this process has a store lock operation in
 * flight (#1422, carry-over from #1349).
 *
 * Paired with a missed hybrid deadline, that is the case the hook dispatcher's
 * error exit must survive: the abandoned hybrid search records its injection
 * under `engrams.yaml.lock` while the injection that serves the turn throws.
 * The throw reaches the CLI dispatcher's catch with the write still in flight.
 * Combine with helpers/slow-store-lock.mjs to hold that write open long enough
 * for an early exit to be caught every time.
 *
 * The error message says whether a lock operation was in flight when it was
 * thrown, so a test can assert that the race it models actually happened (an
 * environment where hybrid never reaches its store write would otherwise pass
 * vacuously).
 *
 * PLUR_TEST_BM25_THROW_AFTER_MS (default 0) waits that much longer once the
 * write has started before throwing, so the throw can land while the lock
 * itself is on disk rather than while it is still being published.
 *
 * Active only with PLUR_TEST_BM25_THROWS_WHILE_WRITING=1. Nothing in production
 * reads it; without this preload it is inert.
 */
import { Plur, pendingStoreLockOps } from '@plur-ai/core'

if (process.env.PLUR_TEST_BM25_THROWS_WHILE_WRITING === '1') {
  Plur.prototype.inject = async function bm25ThrowsWhileWriting() {
    const until = Date.now() + 15_000
    while (pendingStoreLockOps() === 0 && Date.now() < until) {
      await new Promise(r => setTimeout(r, 10))
    }
    await new Promise(r => setTimeout(r, Number(process.env.PLUR_TEST_BM25_THROW_AFTER_MS) || 0))
    throw new Error(pendingStoreLockOps() > 0
      ? 'test fault: BM25 fallback failed while a store write was in flight'
      : 'test fault: BM25 fallback failed with no store write in flight')
  }
}
