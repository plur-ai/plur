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
 * `withLock()` in `sync.ts` uses an OS wait, which blocks the event loop
 * for the whole delay. In a deployment serving concurrent sessions that stalls
 * every other in-flight request, not just the contending one.
 *
 * NOT REENTRANT. `fn` must not acquire the same path again — the in-process
 * mutex would wait on a lock its own caller is holding. Nesting on a
 * *different* path works but is a lock-ordering hazard; don't.
 */
import { makeToken, tryFileLock, releaseFileLock } from './file-lock.js'
export { makeToken, holderIsAlive } from './file-lock.js'
import * as path from 'path'
import { KeyedAsyncMutex } from '../async-mutex.js'

export interface AsyncLockOptions {
  /**
   * @deprecated Superseded by {@link AsyncLockOptions.acquireTimeout}, which
   * bounds the wait in TIME rather than in attempts. Still honoured so existing
   * callers keep working: when set, it caps the number of retries as before.
   */
  maxRetries?: number
  baseDelay?: number
  /**
   * How long a lock file may go untouched before a waiter treats it as
   * abandoned and steals it. Default {@link DEFAULT_STALE_THRESHOLD}.
   */
  staleThreshold?: number
  /**
   * How long to keep waiting for a live holder before giving up. Default
   * {@link DEFAULT_ACQUIRE_TIMEOUT}.
   *
   * MUST exceed `staleThreshold`, or waiters abandon a holder the lock protocol
   * still considers legitimate — see the header note on F9.
   */
  acquireTimeout?: number
}

/**
 * How long before an untouched lock is considered abandoned (audit #794, F9).
 *
 * Raised from 10 s. The audit measured a 50,000-engram store holding the lock
 * ~4.9 s (2.4 s save + 2.4 s load), and the daily backup (#799) adds ~1.4 s once
 * per day, taking the realistic worst case to ~6.3 s. Against a 10 s threshold
 * that is barely a 1.6× margin — and it evaporates entirely on a cloud-synced
 * `~/.plur`, on a laptop that suspends mid-write, or when an index sync runs
 * inside the lock. Stealing a lock from a process that is still writing is a
 * corpus-corruption bug, so the margin needs to be large.
 *
 * The cost of a high threshold is slow recovery after a crash, and that is paid
 * for separately by the liveness check below: a dead holder's lock is stolen at
 * once, not after the threshold.
 */
export const DEFAULT_STALE_THRESHOLD = 60_000

/**
 * How long a waiter keeps trying before giving up.
 *
 * Deliberately LARGER than {@link DEFAULT_STALE_THRESHOLD}. The old defaults had
 * this backwards: five retries of exponential backoff gave a ~3.1 s budget
 * against a 10 s stale threshold, so a waiter threw `Failed to acquire lock`
 * while the holder was still inside its legitimate working window — and for MCP
 * `plur_learn` that meant the engram was silently never stored (audit #794, F9).
 *
 * With the deadline above the threshold, a waiter facing a genuinely stuck
 * holder always reaches the stale check and steals the lock rather than failing.
 *
 * Raised from 90s to clear the longest legitimate hold (audit 2026-08-03,
 * finding 10). `Plur.sync()` holds the store lock across `git fetch`,
 * `pull`/`rebase` and `push` — deliberately, because releasing it between the
 * pull and the local write reintroduces the lost-engram race that holding it
 * was added to close (#811 finding 2). Each git command has its own 30s
 * timeout, so a sync against an unresponsive remote can legitimately hold the
 * lock for ~90s plus local staging.
 *
 * Against a 90s budget that is not a delay, it is a FAILURE: a concurrent
 * `plur_learn` exhausts its wait and the engram is silently never stored, which
 * is precisely the F9 harm. The budget must therefore exceed the maximum honest
 * hold, not merely the typical one.
 *
 * The cost is bounded, and paid only by a waiter behind a LIVE holder — a dead
 * one is stolen from immediately by the liveness check, and a live or foreign-host owner is
 * never reclaimed merely because time passed. Anything that raises git's per-command
 * timeout must raise this too, or reopen the same hole.
 */
export const DEFAULT_ACQUIRE_TIMEOUT = 180_000

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
  const baseDelay = options?.baseDelay ?? 100
  const staleThreshold = options?.staleThreshold ?? DEFAULT_STALE_THRESHOLD
  const acquireTimeout = options?.acquireTimeout ?? Math.max(
    DEFAULT_ACQUIRE_TIMEOUT,
    // A caller that raises staleThreshold must not thereby make waiters give up
    // before it — the inversion F9 was about.
    Math.ceil(staleThreshold * 1.5),
  )
  const maxRetries = options?.maxRetries
  const token = makeToken()
  const start = Date.now()

  // Whether we actually took the lock.
  //
  // Without this the loop could simply RUN OUT: the `continue` branches below
  // skip the give-up throw, and if one hit on the last iteration `fn()` would
  // run with no lock at all while the `finally` deleted somebody else's file.
  let acquired = false
  /** Who we last saw holding it — named in the give-up error so it is actionable. */
  let lastHolder = ''

  for (let attempt = 0; ; attempt++) {
    // Bound EVERY iteration, not just the ones that sleep.
    //
    // The `continue` paths — a stale lock stolen, a lock that vanished mid-check
    // — reach the next attempt without passing the wait. Checking the budget
    // only before sleeping therefore leaves them unbounded, and a lock that
    // another process keeps recreating stale spins forever. (Caught by
    // async-lock-contention's `retry budget spent by a stale-lock cleanup`,
    // which is exactly the case the old attempt-bounded `for` covered for free.)
    if (attempt > 0) {
      const elapsed = Date.now() - start
      const outOfRetries = maxRetries !== undefined && attempt > maxRetries
      if (elapsed >= acquireTimeout || outOfRetries) {
        throw new Error(
          `Failed to acquire lock on ${filePath} after ${attempt} attempt(s) / ${Math.round(elapsed / 1000)}s` +
          `${lastHolder ? ` (held by ${lastHolder})` : ''}.\n` +
          `A live holder is waited for, never stolen from — stealing a lock from a process that is ` +
          `still writing corrupts the store. If the holder is genuinely stuck, stop it and remove ` +
          `${lockPath}.`,
        )
      }
    }
    const result = tryFileLock(lockPath, token, staleThreshold)
    if (result.acquired) { acquired = true; break }
    lastHolder = result.holder
    if (result.retryNow) continue
    await sleep(Math.min(baseDelay * Math.pow(2, attempt), 5000, Math.max(0, acquireTimeout - (Date.now() - start))))
  }

  try {
    return await fn()
  } finally {
    // Only ours to remove. `acquired` stops a failed acquisition deleting the
    // holder's file; the token comparison stops US deleting a THIEF's file
    // after our lock was stolen, which is what turned one stale-lock steal into
    // a cascade (F9).
    if (acquired) releaseFileLock(lockPath, token)
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
