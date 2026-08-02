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
import { writeFile, unlink, stat, readFile } from 'fs/promises'
import { constants } from 'fs'
import { hostname } from 'os'
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
 */
export const DEFAULT_ACQUIRE_TIMEOUT = 90_000

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

/** Monotonic counter making each token unique within a process. */
let tokenCounter = 0

/**
 * Contents written into the lock file: who holds it, and which acquisition.
 *
 * The nonce is what makes release safe. Before this, release was an
 * unconditional `unlink`, so once a waiter stole a lock the ORIGINAL holder's
 * `finally` deleted the *thief's* lock on its way out — and a third process
 * walked straight in while the thief was still writing (audit #794, F9;
 * measured by probe p05b). A holder now removes the lock only if the file still
 * carries its own token.
 *
 * The hostname is what makes the liveness check safe: a pid is only meaningful
 * on the machine that owns it, and `~/.plur` on a synced or networked volume can
 * hold a lock written by a different host.
 */
function makeToken(): string {
  return `${hostname()}:${process.pid}:${Date.now()}:${tokenCounter++}`
}

/**
 * Is the process that wrote this token still alive?
 *
 * `undefined` means "cannot tell" — a token from another host, or an
 * unparseable one — and callers must treat that as "assume alive". Guessing
 * "dead" would steal a lock from a live writer, which is the corpus-corruption
 * outcome the whole mechanism exists to prevent.
 */
function holderIsAlive(token: string): boolean | undefined {
  const parts = token.split(':')
  if (parts.length < 2) return undefined
  const [host, pidRaw] = parts
  if (host !== hostname()) return undefined
  const pid = Number(pidRaw)
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // a signal: it throws ESRCH when no such process exists.
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    // EPERM means it exists but belongs to another user — alive, not ours.
    if (err?.code === 'EPERM') return true
    return false
  }
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
    try {
      await writeFile(lockPath, token, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL })
      acquired = true
      break
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err

      // Is the incumbent abandoned? Two independent reasons to say yes.
      let abandoned = false
      let holder = ''
      try {
        const [s, contents] = await Promise.all([
          stat(lockPath),
          readFile(lockPath, 'utf8').catch(() => ''),
        ])
        holder = contents.trim()
        // (1) The holder's process is gone. Definitive, and immediate — this is
        //     what keeps crash recovery fast despite the long stale threshold.
        if (holderIsAlive(holder) === false) abandoned = true
        // (2) Nothing has touched it for longer than any legitimate hold. The
        //     fallback for holders we cannot probe: another host, or a pid we
        //     cannot reason about.
        else if (Date.now() - s.mtimeMs > staleThreshold) abandoned = true
      } catch {
        // Vanished between the EEXIST and the check — the holder released.
        // Retry immediately; there is nothing to steal.
        continue
      }

      if (abandoned) {
        // Remove only the file we just inspected. If the holder released and a
        // third party re-locked in between, this deletes the newcomer's lock —
        // so re-read and compare before unlinking.
        await stealLock(lockPath, holder)
        continue
      }

      // The incumbent is alive and recently active, so waiting is the only
      // correct move — stealing from a live writer corrupts the store. The
      // deadline check at the top of the next iteration decides when to stop.
      lastHolder = holder
      await sleep(Math.min(baseDelay * Math.pow(2, attempt), 5000))
    }
  }

  try {
    return await fn()
  } finally {
    // Only ours to remove. `acquired` stops a failed acquisition deleting the
    // holder's file; the token comparison stops US deleting a THIEF's file
    // after our lock was stolen, which is what turned one stale-lock steal into
    // a cascade (F9).
    if (acquired) await releaseIfOurs(lockPath, token)
  }
}

/** Remove a lock believed abandoned, but only if it is still the same one. */
async function stealLock(lockPath: string, expected: string): Promise<void> {
  try {
    const current = (await readFile(lockPath, 'utf8')).trim()
    if (current !== expected) return
    await unlink(lockPath)
  } catch {
    /* already gone, or replaced — either way not ours to remove */
  }
}

/** Release the lock iff the file still carries our token. */
async function releaseIfOurs(lockPath: string, token: string): Promise<void> {
  try {
    const current = (await readFile(lockPath, 'utf8')).trim()
    if (current !== token) return
    await unlink(lockPath)
  } catch {
    /* already gone */
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
