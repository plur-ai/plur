import { readFileSync, statSync, unlinkSync } from 'fs'
import {
    DEFAULT_STALE_THRESHOLD,
    abandonedByAge,
    holderIsAlive, makeToken,
    publishLockFileSync,
    startHeartbeat,
    takeOverSync
} from './store/async-lock.js'


export interface LockOptions {
  maxRetries?: number
  baseDelay?: number
  staleThreshold?: number
}


/**
 * File-based exclusive lock using O_EXCL, retrying with exponential backoff.
 * The stale threshold is raised like the async lock's (stealing from a live
 * writer corrupts the store), but the retry budget deliberately is NOT: this
 * busy-waits and blocks the event loop. Callers that must wait out a slow holder
 * belong on `withAsyncLock`; this serves short synchronous holds (tensions, config, episodes).
 */
export function withLock<T>(
  filePath: string,
  fn: () => T,
  options?: LockOptions,
): T {
  const lockPath = filePath + '.lock'
  const maxRetries = options?.maxRetries ?? 5
  const baseDelay = options?.baseDelay ?? 100
  const staleThreshold = options?.staleThreshold ?? DEFAULT_STALE_THRESHOLD

  const token = makeToken()

  // Whether we actually took the lock.
  //
  // Without this the loop can simply RUN OUT: both `continue` branches below —
  // a stale lock stolen, and a stat that fails because the holder released
  // between the EEXIST and the check — skip the give-up throw. If either lands
  // on the FINAL attempt the loop ends normally, `fn()` would run holding
  // nothing, and the `finally` would delete a lock belonging to whoever does
  // hold it. The async implementation carries the same guard. Reachable
  // through public options — `maxRetries: 0` makes the first attempt the
  // final one.
  let acquired = false

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Published complete, never as an empty file — see
      // `publishLockFile` in store/async-lock.ts.
      publishLockFileSync(lockPath, token)
      acquired = true
      break
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err
      try {
        const stat = statSync(lockPath)
        // Liveness is what pays for the raised stale threshold, and it has to
        // be here as well as on the async lock: without it crash recovery on
        // THESE paths (episodes, tensions, config) would wait the full 60s
        // threshold instead of 10s.
        const holder = readFileSync(lockPath, 'utf8').trim()
        // Our own unique token, put back by a takeover on the no-hard-link
        // fallback: the lock is ours (see withFileLock in store/async-lock.ts).
        if (holder === token) { acquired = true; break }
        const alive = holderIsAlive(holder)
        // Age is consulted ONLY when liveness is unknown — another host, or the
        // bare pid an older client wrote. A confirmed-live holder is never
        // stolen from for being slow: that corrupts the artifact it is midway
        // through writing, whereas waiting on a wedged holder surfaces as a
        // loud failure the operator can act on. An EMPTY lock is judged on a
        // short grace period instead of the full threshold.
        const steal = alive === false
          || (alive === undefined && abandonedByAge(holder, Date.now() - stat.mtimeMs, staleThreshold))
        // A hint only: the takeover re-inspects under a guard shared with the
        // async lock, and claims by single-winner rename (see `takeOver` in
        // store/async-lock.ts). When another process holds the guard, fall
        // through to the normal backoff.
        if (steal && takeOverSync(lockPath, staleThreshold)) continue
      } catch {
        continue
      }
      if (attempt === maxRetries) {
        throw new Error(`Failed to acquire lock on ${filePath} after ${maxRetries} retries`)
      }
      const delay = baseDelay * Math.pow(2, attempt)
      const end = Date.now() + delay
      while (Date.now() < end) { /* busy wait — sync context */ }
    }
  }

  if (!acquired) {
    throw new Error(
      `Failed to acquire lock on ${filePath} after ${maxRetries} retries (contended throughout)`,
    )
  }

  // Heartbeat while held. `fn` is synchronous, so the timer only
  // fires if it yields; the synchronous touch points (heartbeatHeldLocks, called
  // before every git command) cover long blocking work. Stopped on return or throw.
  const stopHeartbeat = startHeartbeat(lockPath, token, staleThreshold)
  try {
    return fn()
  } finally {
    stopHeartbeat()
    // Only ours to remove. Without the token comparison, a holder whose lock
    // was stolen would delete the THIEF's lock on its way out and let a third
    // writer walk in mid-write.
    try {
      if (readFileSync(lockPath, 'utf8').trim() === token) unlinkSync(lockPath)
    } catch { /* already gone */ }
  }
}
