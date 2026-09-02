/**
 * Child-process worker for the two-process hash-chain concurrency test (#1051).
 *
 * Spawned by store-concurrent-chain.test.ts with two environment variables:
 *
 *   STORE_PATH  — the shared plur root directory
 *   N           — number of engrams to learn (default 10)
 *
 * The worker calls Plur.learn() N times sequentially (not concurrently within
 * itself). Concurrency comes from TWO instances of this script running
 * simultaneously against the same store path. Each Plur.learn() call holds the
 * store write lock (_withStoreLock → withAsyncLock) and, while holding it,
 * calls appendHistory. If the cross-process O_EXCL lock works, no two events
 * can read the same predecessor hash and set the same prev, so no fork occurs.
 *
 * Exit codes:
 *   0 — all writes succeeded
 *   1 — one or more writes failed (stderr contains the error)
 */
import { Plur } from '../../src/index.js'

const storePath = process.env.STORE_PATH
const n = parseInt(process.env.N ?? '10', 10)

if (!storePath) {
  process.stderr.write('STORE_PATH env var is required\n')
  process.exit(1)
}

const plur = new Plur({ path: storePath })

let failed = 0
for (let i = 0; i < n; i++) {
  try {
    await plur.learn(`concurrent chain write pid=${process.pid} seq=${i}`, { scope: 'global' })
  } catch (err) {
    process.stderr.write(`write ${i} failed: ${(err as Error).message}\n`)
    failed++
  }
}

if (failed > 0) {
  process.stderr.write(`${failed} of ${n} writes failed\n`)
  process.exit(1)
}
process.exit(0)
