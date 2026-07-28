/**
 * Async file lock: an in-process queue in front of an O_EXCL file lock.
 *
 * Two levels, because they solve different problems:
 *
 *   in-process (KeyedAsyncMutex) — concurrent callers in THIS process queue
 *     FIFO. No polling, no backoff, no spurious failure.
 *   cross-process (O_EXCL + async retry) — another process holding the lock
 *     file is waited out with an async backoff.
 *
 * Why the in-process level is not optional (convergence Phase 2): `O_EXCL`
 * hands a losing caller `EEXIST` and nothing else, so the only recovery is
 * retry-with-backoff. That is the right shape for cross-process contention,
 * which is rare — and the wrong shape for in-process contention, which is the
 * NORMAL case once the write path is async and one instance serves several
 * concurrent sessions. Without the queue, N concurrent writers put N-1 of them
 * to sleep through an exponential backoff and, past `maxRetries`, make them
 * throw `Failed to acquire lock` — even though every one of them is in the same
 * process and could simply have taken turns.
 *
 * The backoff is an async sleep, never a busy-wait: the synchronous
 * `withLock()` in `sync.ts` spins on `Date.now()`, which blocks the event loop
 * for the whole delay. In a deployment serving concurrent sessions that stalls
 * every other in-flight request, not just the contending one.
 *
 * NOT REENTRANT. `fn` must not acquire the same path again — the in-process
 * mutex would wait on a lock its own caller is holding. Nesting on a
 * *different* path works but is a lock-ordering hazard; don't.
 */
import { writeFile, unlink, stat } from 'fs/promises'
import { constants } from 'fs'
import * as path from 'path'
import { KeyedAsyncMutex } from '../async-mutex.js'

export interface AsyncLockOptions {
  maxRetries?: number
  baseDelay?: number
  staleThreshold?: number
}

/**
 * In-process lock queue, keyed by resolved path.
 *
 * Module-level on purpose: it has to be shared by every caller in the process
 * that locks the same file, whichever class or instance they belong to. Entries
 * are evicted once idle, so this does not grow with the number of paths ever
 * locked — only with paths under contention right now.
 */
const processLocks = new KeyedAsyncMutex()

/** Paths with in-process lock contention right now. Test/diagnostic seam. */
export function activeLockCount(): number {
  return processLocks.size
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

/** Take the cross-process lock file, run `fn`, release. */
async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options?: AsyncLockOptions,
): Promise<T> {
  const lockPath = filePath + '.lock'
  const maxRetries = options?.maxRetries ?? 5
  const baseDelay = options?.baseDelay ?? 100
  const staleThreshold = options?.staleThreshold ?? 10_000

  // Whether we actually took the lock.
  //
  // Without this the loop could simply RUN OUT: the two `continue` branches
  // below (stale-lock cleanup, and a `stat` that fails because another process
  // released between the EEXIST and the check) skip the
  // `attempt === maxRetries` throw. If either happened on the LAST iteration
  // the loop ended normally, `fn()` ran with no lock at all, and the `finally`
  // unlinked a lock file belonging to whoever did hold it — handing them a
  // silent loss of mutual exclusion on top of ours.
  let acquired = false

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await writeFile(lockPath, `${process.pid}`, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL })
      acquired = true
      break
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err
      // Check for stale lock
      try {
        const s = await stat(lockPath)
        if (Date.now() - s.mtimeMs > staleThreshold) {
          await unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        continue
      }
      if (attempt === maxRetries) {
        throw new Error(`Failed to acquire lock on ${filePath} after ${maxRetries} retries`)
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt), 5000)
      await sleep(delay)
    }
  }

  if (!acquired) {
    throw new Error(
      `Failed to acquire lock on ${filePath} after ${maxRetries} retries (contended throughout)`,
    )
  }

  try {
    return await fn()
  } finally {
    // Only ours to remove. Guarded by `acquired` so a failed acquisition can
    // never delete the holder's file.
    await unlink(lockPath).catch(() => {})
  }
}

/**
 * Async exclusive lock on `filePath`.
 *
 * Queues in-process first (FIFO, no polling), then takes the O_EXCL file lock
 * so other processes are excluded too. Not reentrant — see the module header.
 */
export async function withAsyncLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options?: AsyncLockOptions,
): Promise<T> {
  // Resolve so `./a/engrams.yaml` and `/abs/a/engrams.yaml` share one queue.
  // The file lock gets that for free — the kernel resolves the path for
  // O_EXCL — but the in-process key is a plain string and has to do it itself.
  return processLocks.run(path.resolve(filePath), () => withFileLock(filePath, fn, options))
}
