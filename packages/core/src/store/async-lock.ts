/**
 * Async file lock: an in-process queue in front of an O_EXCL file lock.
 *
 * Two levels, because they solve different problems:
 *
 *   in-process (KeyedAsyncMutex) — concurrent callers in THIS process queue
 *     FIFO. No polling, no backoff, no spurious failure.
 *   cross-process (exclusive create + async retry) — another process holding
 *     the lock file is waited out with an async backoff. The file is published
 *     with its owner token already in it (hard link), never as an empty file
 *     (#1354; see `publishLockFile`).
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
import { writeFile, unlink, stat, readFile, rename, open, link } from 'fs/promises'
import {
  linkSync, openSync, writeSync, closeSync, fstatSync, statSync, unlinkSync,
  writeFileSync, renameSync, readFileSync, utimesSync, constants,
} from 'fs'
import { hostname } from 'os'
import { createHash } from 'crypto'
import * as path from 'path'
import { KeyedAsyncMutex } from '../async-mutex.js'
import { logger } from '../logger.js'

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
 * one is stolen from immediately by the liveness check, and a wedged one is
 * stolen after `DEFAULT_STALE_THRESHOLD`. Anything that raises git's per-command
 * timeout must raise this too, or reopen the same hole.
 */
export const DEFAULT_ACQUIRE_TIMEOUT = 180_000

/**
 * How old an EMPTY lock file must be before it is treated as abandoned (#1354).
 *
 * An empty lock is what a creator leaves when it dies between creating the file
 * and writing its owner token. With no token there is no pid to probe, so before
 * this every waiter sat out the full {@link DEFAULT_STALE_THRESHOLD} (60s): a
 * hook SIGKILLed at its harness budget cost every later writer a minute.
 *
 * Core itself no longer produces empty locks: it publishes the lock complete
 * (see {@link publishLockFile}). They still come from older clients sharing the
 * store, from filesystems without hard links (the fallback there), and from
 * anything else that creates first and writes second. For such a creator the
 * create→write gap is the only time an empty lock is legitimately live, so the
 * grace must clear that gap by a wide margin.
 *
 * Measured on a developer laptop, 20,000 O_EXCL create + token write cycles:
 * idle event loop p50 0.3ms, p99 10–20ms, max 0.73s; with the loop busy in
 * 20ms synchronous bursts, p99 117ms, max 0.68s. The tail is scheduling, not
 * I/O (the write continuation waits for the event loop), so the grace must also
 * cover a creator whose loop is blocked by a large synchronous YAML parse
 * (~2.4s at 50,000 engrams, audit #794). 10s is >13x the worst measured gap and
 * >4x that parse, and still recovers six times sooner than the stale threshold.
 */
export const EMPTY_LOCK_GRACE_MS = 10_000

/** Errors from `link()` that mean "this filesystem has no hard links". */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL'])

/** A private, uniquely named sibling of the lock file. */
function privateSibling(lockPath: string, kind: 'publish' | 'steal', token: string): string {
  return `${lockPath}.${kind}.${token.replace(/[^\w.-]/g, '_')}`
}

function lostDuringAcquire(lockPath: string): Error {
  return Object.assign(new Error(`EEXIST: lock taken over during acquire, '${lockPath}'`), { code: 'EEXIST' })
}

/**
 * Create `lockPath` holding `token`, or throw `EEXIST` if it exists (#1354).
 *
 * The lock used to be `writeFile(lockPath, token, { flag: O_EXCL })`: an
 * exclusive create followed by a separate write. Between the two the lock
 * exists but is EMPTY, and a process killed there leaves a lock nobody can
 * attribute. So the token is written to a private file first and hard-linked
 * into place. `link()` fails with `EEXIST` exactly like `O_EXCL`, and the lock
 * appears with its token already in it, or not at all.
 *
 * A kill at any point leaves at most the uniquely named private file behind,
 * never an empty lock; that file is outside the lock protocol and inert.
 *
 * Filesystems without hard links fall back to create-then-write, plus a check
 * that the path still names the file we wrote: if an empty-lock takeover moved
 * it away during a stall longer than {@link EMPTY_LOCK_GRACE_MS}, report
 * `EEXIST` and retry rather than proceed as a second holder.
 */
export async function publishLockFile(lockPath: string, token: string): Promise<void> {
  const priv = privateSibling(lockPath, 'publish', token)
  await writeFile(priv, token, { flag: 'wx' })
  let fallback = false
  try {
    await link(priv, lockPath)
  } catch (err: any) {
    if (!LINK_UNSUPPORTED.has(err?.code)) throw err
    fallback = true
  } finally {
    await unlink(priv).catch(() => {})
  }
  if (!fallback) return
  const fd = await open(lockPath, 'wx')
  let ino: number
  try {
    await fd.writeFile(token)
    ino = (await fd.stat()).ino
  } finally {
    await fd.close()
  }
  const now = await stat(lockPath).catch(() => null)
  if (now?.ino !== ino) throw lostDuringAcquire(lockPath)
}

/** Synchronous twin of {@link publishLockFile}, for `withLock` in `sync.ts`. */
export function publishLockFileSync(lockPath: string, token: string): void {
  const priv = privateSibling(lockPath, 'publish', token)
  writeFileSync(priv, token, { flag: 'wx' })
  let fallback = false
  try {
    linkSync(priv, lockPath)
  } catch (err: any) {
    if (!LINK_UNSUPPORTED.has(err?.code)) throw err
    fallback = true
  } finally {
    try { unlinkSync(priv) } catch { /* already gone */ }
  }
  if (!fallback) return
  const fd = openSync(lockPath, 'wx')
  let ino: number
  try {
    writeSync(fd, token)
    ino = fstatSync(fd).ino
  } finally {
    closeSync(fd)
  }
  let now: number | undefined
  try { now = statSync(lockPath).ino } catch { /* gone */ }
  if (now !== ino) throw lostDuringAcquire(lockPath)
}

/**
 * Has a lock whose holder we CANNOT probe been untouched long enough to steal?
 *
 * Only for liveness `undefined`: a holder confirmed alive is never stolen from,
 * a confirmed-dead one is stolen at once. An EMPTY lock (#1354) is abandoned
 * after {@link EMPTY_LOCK_GRACE_MS}; anything carrying a token keeps the full
 * stale threshold.
 */
export function abandonedByAge(holder: string, ageMs: number, staleThreshold: number): boolean {
  if (holder === '') return ageMs > Math.min(EMPTY_LOCK_GRACE_MS, staleThreshold)
  return ageMs > staleThreshold
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
export function makeToken(): string {
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
export function holderIsAlive(token: string): boolean | undefined {
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

/**
 * Heartbeat (owner decision P1, formal run 2026-09-26).
 *
 * A contender that cannot probe the holder's liveness — the holder is on
 * another host sharing `~/.plur`, or wrote a legacy bare-pid token — has only
 * the lock file's age to go on, and steals once it is older than
 * `staleThreshold`. Nothing refreshed that age during a hold, so a legitimate
 * `Plur.sync()` (git fetch/pull/push, each up to 30 s — ~90 s in all) was
 * stolen from at 60 s and a second writer entered (replayed:
 * findings/persistence.md §4).
 *
 * So a holder re-touches its own lock (token-checked `utimes`) every
 * `staleThreshold / 3` while it holds it — from a timer during async work, and
 * from {@link heartbeatHeldLocks} at synchronous touch points (sync.ts calls it
 * before every git command, since a blocking `execFileSync` starves timers).
 * Stealing by age then only happens to a holder that stopped heartbeating.
 * Both lock implementations (this one and `withLock` in sync.ts) register here;
 * the heartbeat stops on release and on throw. No lock-file format change.
 */
const heldLocks = new Map<string, { lockPath: string; lastTouch: number; interval: number }>()

/** Locks this process is heartbeating right now. Test/diagnostic seam. */
export function activeHeartbeats(): number {
  return heldLocks.size
}

/** Touch `lockPath` iff it still carries `token`. Never throws. */
function touchIfOurs(lockPath: string, token: string): boolean {
  try {
    if (readFileSync(lockPath, 'utf8').trim() !== token) return false
    const now = new Date()
    utimesSync(lockPath, now, now)
    return true
  } catch {
    return false // released, stolen or unreadable — nothing of ours to refresh
  }
}

/**
 * Re-touch every lock this process holds whose last touch is at least a
 * heartbeat interval old. Synchronous and cheap; call it from long synchronous
 * work done under a lock (sync.ts does, before each git command).
 */
export function heartbeatHeldLocks(): void {
  const now = Date.now()
  for (const [token, h] of heldLocks) {
    if (now - h.lastTouch < h.interval) continue
    if (touchIfOurs(h.lockPath, token)) h.lastTouch = now
  }
}

/**
 * Start heartbeating a lock just acquired with `token`. Returns the stop
 * function, which the holder MUST call (in a `finally`) before releasing.
 */
export function startHeartbeat(lockPath: string, token: string, staleThreshold: number): () => void {
  const interval = Math.max(1, Math.floor(staleThreshold / 3))
  warnIfThresholdTooShort(staleThreshold, interval)
  heldLocks.set(token, { lockPath, lastTouch: Date.now(), interval })
  const timer = setInterval(() => {
    const h = heldLocks.get(token)
    if (h && touchIfOurs(lockPath, token)) h.lastTouch = Date.now()
  }, interval)
  // Never keep a process alive for a heartbeat.
  timer.unref?.()
  return () => {
    clearInterval(timer)
    heldLocks.delete(token)
  }
}

/**
 * Longest single blocking step a holder may take between two heartbeat touch
 * points: one git command under `Plur.sync` (sync.ts `git()` uses this as its
 * `execFileSync` timeout — the single source for both).
 */
export const GIT_COMMAND_TIMEOUT_MS = 30_000

const warnedThresholds = new Set<number>()

/**
 * The heartbeat keeps a lock's age below `interval + longest blocking step`
 * (spec/formal/PlurSpec/Persistence.lean `sync_age_bound`). With a custom
 * `staleThreshold` at or below that bound — `T/3 + 30 s ≥ T`, i.e. T ≤ ~45 s —
 * a holder blocked in one git command can be judged abandoned (when its liveness
 * cannot be probed) and stolen from mid-hold. Said once per threshold value, not
 * refused: short thresholds are legitimate for locks that never run git (formal
 * round 2, findings/r2-persist.md item 7).
 */
function warnIfThresholdTooShort(staleThreshold: number, interval: number): void {
  if (staleThreshold === DEFAULT_STALE_THRESHOLD || warnedThresholds.has(staleThreshold)) return
  if (interval + GIT_COMMAND_TIMEOUT_MS < staleThreshold) return
  warnedThresholds.add(staleThreshold)
  logger.warning(
    `[plur] lock staleThreshold ${staleThreshold} ms is too short for the heartbeat guarantee: a holder ` +
    `blocked in one git command (up to ${GIT_COMMAND_TIMEOUT_MS} ms) goes ${interval + GIT_COMMAND_TIMEOUT_MS} ms ` +
    `between touches, so a holder whose liveness cannot be probed (another host) may be stolen from mid-sync. ` +
    `Use more than ${Math.ceil((GIT_COMMAND_TIMEOUT_MS * 3) / 2)} ms for any lock held across git.`,
  )
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
      await publishLockFile(lockPath, token)
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
        // Our OWN token: only possible on the no-hard-link fallback, when a
        // takeover claimed our file mid-acquire, then found our token and put
        // it back. The token is unique to this acquisition, so the lock is
        // ours. Waiting on it would wait on ourselves until the deadline.
        if (holder === token) { acquired = true; break }
        const alive = holderIsAlive(holder)
        // (1) The holder's process is gone. Definitive, and immediate — this is
        //     what keeps crash recovery fast despite the long stale threshold.
        if (alive === false) abandoned = true
        // (2) We cannot probe this holder — another host, or a pid we cannot
        //     reason about — so age is the only signal left.
        //
        //     Age is deliberately NOT consulted when liveness came back TRUE.
        //     An `else if` here would steal from a writer we have just
        //     confirmed is running, purely for being slow, and a 50k-engram
        //     save legitimately holds the lock for seconds. Stealing from a
        //     live writer corrupts the corpus; waiting on a wedged one is a
        //     visible error after `acquireTimeout` that names the lock file.
        //     A loud stall beats silent corruption.
        //
        //     An EMPTY lock gets a much shorter window (#1354). With no token
        //     it can only be a creator between its create and its write
        //     (milliseconds when alive), or one that died there.
        else if (alive === undefined && abandonedByAge(holder, Date.now() - s.mtimeMs, staleThreshold)) abandoned = true
      } catch {
        // Vanished between the EEXIST and the check — the holder released.
        // Retry immediately; there is nothing to steal.
        continue
      }

      if (abandoned) {
        // What we saw is only a hint: the takeover re-inspects under its own
        // guard before touching anything (see `takeOver`).
        if (await takeOver(lockPath, staleThreshold)) continue
        // Another process is mid-takeover. It holds its guard for a few
        // syscalls; give it a moment rather than spin.
        await sleep(Math.min(baseDelay, 50))
        continue
      }

      // The incumbent is alive and recently active, so waiting is the only
      // correct move — stealing from a live writer corrupts the store. The
      // deadline check at the top of the next iteration decides when to stop.
      lastHolder = holder
      await sleep(Math.min(baseDelay * Math.pow(2, attempt), 5000))
    }
  }

  // Heartbeat while held (decision P1); stopped before release, on return or throw.
  const stopHeartbeat = acquired ? startHeartbeat(lockPath, token, staleThreshold) : () => {}
  try {
    return await fn()
  } finally {
    stopHeartbeat()
    // Only ours to remove. `acquired` stops a failed acquisition deleting the
    // holder's file; the token comparison stops US deleting a THIEF's file
    // after our lock was stolen, which is what turned one stale-lock steal into
    // a cascade (F9).
    if (acquired) await releaseIfOurs(lockPath, token)
  }
}

/** Would a waiter be entitled to take over a lock with this holder and mtime? */
function isAbandoned(holder: string, mtimeMs: number, staleThreshold: number): boolean {
  const alive = holderIsAlive(holder)
  if (alive === false) return true
  return alive === undefined && abandonedByAge(holder, Date.now() - mtimeMs, staleThreshold)
}

/**
 * Take over an abandoned lock (#1354), serialized by #1228's steal-guard LADDER
 * (owner decision C1; proofs on formal/field-report-2026-09-29:
 * spec/formal/PlurSpec/R2Persist.lean `ladder_mutex`, and §6 `TakeoverG`
 * `combined_mutex` for this lock + ladder combination; findings
 * spec/formal/findings/persistence.md §G). Returns false when another
 * contender is taking over the same lock instance.
 *
 * This replaces a single `.takeover` guard file. That guard, abandoned by a
 * crashed stealer, had to be removed by the same rename claim, unguarded: two
 * stealers could then both be "under" it after a double crash (replayed in
 * test/formal-fr-c2-takeover.test.ts).
 *
 * Why a guard at all: the rename claim in {@link stealLock} makes the steal
 * single-winner, but not the DECISION — two waiters that judged the same
 * abandoned lock can both reach `rename`, and the second moves the first's
 * fresh, live lock aside while a third creates one at the free path.
 *
 * Why a ladder keyed by the judged token, not one `.takeover` file: a guard
 * abandoned by a crashed stealer must itself be removed, and removing it is a
 * read-then-unlink of someone else's file — the same race one level up
 * (replayed in r2-persist item 1). Slots are keyed by the judged lock's token,
 * so nobody but a slot's own writer ever unlinks it while that token is still
 * at `lockPath`; a dead slot is stepped over, never deleted.
 *
 * Under the slot the lock is re-inspected; only a file with the same token AND
 * the same inode as the one judged (#1354: empty locks have equal contents) is
 * claimed, and only if it is STILL abandoned (decision C2: a holder we cannot
 * probe may have refreshed its mtime since we judged it).
 */
async function takeOver(lockPath: string, staleThreshold: number): Promise<boolean> {
  const seen = await inspectLock(lockPath)
  if (!seen || !isAbandoned(seen.holder, seen.mtimeMs, staleThreshold)) return true // re-evaluate
  const guardToken = makeToken()
  const slot = await acquireStealSlot(lockPath, seen.holder, guardToken)
  if (!slot) return false // another contender is taking it over
  try {
    const cur = await inspectLock(lockPath)
    if (!cur || cur.holder !== seen.holder || cur.ino !== seen.ino) return true
    // Decision C2: still abandoned NOW, not only the same file. A holder we
    // cannot probe proves it is alive only by refreshing its mtime, and it may
    // have done so since we judged it.
    if (!isAbandoned(cur.holder, cur.mtimeMs, staleThreshold)) return true
    if (await stealLock(lockPath, cur.holder, cur.ino)) await clearStealSlots(lockPath, seen.holder, slot)
    return true
  } finally {
    await releaseIfOurs(slot, guardToken)
  }
}

/** Synchronous twin of {@link takeOver}, for `withLock` in `sync.ts`. */
export function takeOverSync(lockPath: string, staleThreshold: number): boolean {
  const seen = inspectLockSync(lockPath)
  if (!seen || !isAbandoned(seen.holder, seen.mtimeMs, staleThreshold)) return true
  const guardToken = makeToken()
  const slot = acquireStealSlotSync(lockPath, seen.holder, guardToken)
  if (!slot) return false
  try {
    const cur = inspectLockSync(lockPath)
    if (!cur || cur.holder !== seen.holder || cur.ino !== seen.ino) return true
    // Decision C2: still abandoned NOW, not only the same file. A holder we
    // cannot probe proves it is alive only by refreshing its mtime, and it may
    // have done so since we judged it.
    if (!isAbandoned(cur.holder, cur.mtimeMs, staleThreshold)) return true
    if (stealLockSync(lockPath, cur.holder, cur.ino)) {
      for (let k = 0; k < STEAL_GUARD_SLOTS; k++) {
        const other = stealGuardPath(lockPath, seen.holder, k)
        if (other !== slot) { try { unlinkSync(other) } catch { /* absent */ } }
      }
    }
    return true
  } finally {
    try { if (readFileSync(slot, 'utf8').trim() === guardToken) unlinkSync(slot) } catch { /* gone */ }
  }
}

/**
 * How many guard slots a steal of one lock instance may walk before giving up.
 * Each slot past the first costs one stealer crash inside the guard (a window of
 * one read and one rename); running out leaves the lock to the acquire deadline,
 * whose error names the lock file.
 */
export const STEAL_GUARD_SLOTS = 8

/** A steal guard untouched this long, whose writer cannot be probed, is abandoned. */
const GUARD_STALE_MS = 10_000

/**
 * Path of guard slot `k` for stealing the lock instance whose token is `expected`.
 *
 * Keyed by the judged token, so a slot abandoned by a crashed stealer never has
 * to be removed while that token is still at `lockPath`: nobody but a slot's own
 * writer ever unlinks it then, which is what makes the ladder safe (a
 * read-then-unlink of someone else's file is the race being closed). Tokens are
 * unique per acquisition, so once the judged lock is gone its ladder is dead
 * weight and is cleared by whoever confirmed the claim.
 */
export function stealGuardPath(lockPath: string, expected: string, k: number): string {
  const key = createHash('sha256').update(expected).digest('hex').slice(0, 16)
  return `${lockPath}.guard-${key}-${k}`
}

/**
 * State of a guard slot: `dead` iff its writer's process is gone (or, when
 * liveness cannot be probed, it has been untouched for {@link GUARD_STALE_MS}).
 * A slot just created but not yet written reads as '' — unknown liveness, fresh
 * — and so counts as live.
 */
export function judgeStealSlot(contents: string, mtimeMs: number, now = Date.now()): 'dead' | 'live' {
  const alive = holderIsAlive(contents.trim())
  return alive === false || (alive === undefined && now - mtimeMs > GUARD_STALE_MS) ? 'dead' : 'live'
}

async function stealSlotState(slot: string): Promise<'dead' | 'live' | 'gone'> {
  try {
    const [s, contents] = await Promise.all([stat(slot), readFile(slot, 'utf8')])
    return judgeStealSlot(contents, s.mtimeMs)
  } catch {
    return 'gone'
  }
}

/**
 * Take the steal guard for `expected`: the lowest free slot above a run of
 * abandoned ones, O_EXCL-created, then VERIFIED — every lower slot must still
 * exist and still be abandoned. A live slot (or one that vanished: its writer
 * finished) means another contender is stealing, and the caller re-evaluates.
 * Returns the slot path, or null. Proof of mutual exclusion, crashes included:
 * spec/formal/PlurSpec/R2Persist.lean `ladder_mutex`.
 */
async function acquireStealSlot(lockPath: string, expected: string, token: string): Promise<string | null> {
  for (let k = 0; k < STEAL_GUARD_SLOTS; k++) {
    const slot = stealGuardPath(lockPath, expected, k)
    try {
      await writeFile(slot, token, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL })
    } catch (err: any) {
      if (err?.code !== 'EEXIST') return null
      if ((await stealSlotState(slot)) === 'dead') continue
      return null
    }
    for (let i = 0; i < k; i++) {
      if ((await stealSlotState(stealGuardPath(lockPath, expected, i))) !== 'dead') {
        await releaseIfOurs(slot, token)
        return null
      }
    }
    return slot
  }
  return null
}

/**
 * After a CONFIRMED claim the judged token is gone from `lockPath` for good
 * (tokens are unique per acquisition, and a dead holder cannot re-acquire), so
 * every other slot of its ladder is dead weight: a stealer still in it re-reads
 * the lock, finds another token and backs off. Best-effort.
 */
async function clearStealSlots(lockPath: string, expected: string, own: string): Promise<void> {
  for (let k = 0; k < STEAL_GUARD_SLOTS; k++) {
    const slot = stealGuardPath(lockPath, expected, k)
    if (slot !== own) await unlink(slot).catch(() => {})
  }
}

function stealSlotStateSync(slot: string): 'dead' | 'live' | 'gone' {
  try {
    const contents = readFileSync(slot, 'utf8')
    return judgeStealSlot(contents, statSync(slot).mtimeMs)
  } catch {
    return 'gone'
  }
}

/** Synchronous twin of {@link acquireStealSlot}. */
function acquireStealSlotSync(lockPath: string, expected: string, token: string): string | null {
  for (let k = 0; k < STEAL_GUARD_SLOTS; k++) {
    const slot = stealGuardPath(lockPath, expected, k)
    try {
      writeFileSync(slot, token, { flag: 'wx' })
    } catch (err: any) {
      if (err?.code !== 'EEXIST') return null
      if (stealSlotStateSync(slot) === 'dead') continue
      return null
    }
    for (let i = 0; i < k; i++) {
      if (stealSlotStateSync(stealGuardPath(lockPath, expected, i)) !== 'dead') {
        try { if (readFileSync(slot, 'utf8').trim() === token) unlinkSync(slot) } catch { /* gone */ }
        return null
      }
    }
    return slot
  }
  return null
}

interface LockInspection { holder: string; mtimeMs: number; ino: number }

async function inspectLock(p: string): Promise<LockInspection | null> {
  try {
    const s = await stat(p)
    const holder = (await readFile(p, 'utf8')).trim()
    // Re-stat: if the file was replaced between the two calls, the contents
    // and the identity would describe different files. Treat as "look again".
    const again = await stat(p)
    if (again.ino !== s.ino) return null
    return { holder, mtimeMs: again.mtimeMs, ino: s.ino }
  } catch {
    return null // gone — nothing to take over
  }
}

function inspectLockSync(p: string): LockInspection | null {
  try {
    const s = statSync(p)
    const holder = readFileSync(p, 'utf8').trim()
    const again = statSync(p)
    if (again.ino !== s.ino) return null
    return { holder, mtimeMs: again.mtimeMs, ino: s.ino }
  } catch {
    return null
  }
}

/**
 * Remove a lock believed abandoned — by CLAIMING it first (audit 2026-08-03,
 * finding 1).
 *
 * The previous shape was read-compare-unlink, which closed the case where the
 * holder released and a third party acquired between the inspection and the
 * steal (F9), but left a narrower window open: between the compare and the
 * `unlink` itself. Two contenders that both judge the same lock stale can both
 * pass the compare; the first unlinks and acquires, the second then unlinks the
 * pathname — now the FIRST one's live lock — and acquires too. Both run the
 * critical section, and on a whole-corpus writer that is a lost update.
 *
 * `rename` is the atomic primitive that fixes it. Only one process can
 * successfully rename a given path; the loser gets ENOENT. So a contender can
 * only ever delete a file it has already moved out of the way, and can never
 * delete a lock another process created at `lockPath` — because the file it
 * deletes is not at `lockPath` any more.
 *
 * Losing the claim is not a failure: the caller loops, finds either a fresh
 * lock or none, and takes the normal exclusive-create path
 * ({@link publishLockFile}). Mutual exclusion is still decided by that create,
 * not by this function.
 */
async function stealLock(lockPath: string, expected: string, expectedIno: number): Promise<boolean> {
  const claim = privateSibling(lockPath, 'steal', makeToken())
  try {
    await rename(lockPath, claim)
  } catch {
    return false // another contender claimed it, or the holder released — re-evaluate
  }
  try {
    // Same FILE, not just the same contents (#1354). Contents cannot tell two
    // empty locks apart: if the old empty lock we judged was released and a
    // creator made a fresh one before our rename, '' === '' would delete a
    // lock whose owner is about to write its token.
    const [current, s] = await Promise.all([readFile(claim, 'utf8'), stat(claim)])
    if (current.trim() === expected && s.ino === expectedIno) {
      await unlink(claim) // confirmed the one we judged abandoned
      return true
    }
    // Not the lock we judged abandoned — a live holder's. Put it back.
    try {
      // `link` restores the SAME file, token and all, in one step, and never
      // overwrites: if someone took the free path meanwhile, EEXIST — theirs wins.
      await link(claim, lockPath)
    } catch (err: any) {
      if (LINK_UNSUPPORTED.has(err?.code)) {
        try {
          const fd = await open(lockPath, 'wx')
          try { await fd.writeFile(current.trim()) } finally { await fd.close() }
        } catch { /* someone acquired meanwhile — theirs wins, drop ours */ }
      }
    }
    await unlink(claim).catch(() => {})
  } catch {
    // Never leave the claim file behind: it is uniquely named, so nothing else
    // would ever clean it up.
    await unlink(claim).catch(() => {})
  }
  return false
}

/**
 * Synchronous twin of {@link stealLock}, for `withLock` in `sync.ts`: the same
 * single-winner rename claim, the same file-identity check, the same restore.
 */
function stealLockSync(lockPath: string, expected: string, expectedIno: number): boolean {
  const claim = privateSibling(lockPath, 'steal', makeToken())
  try {
    renameSync(lockPath, claim)
  } catch {
    return false // another contender claimed it, or the holder released — re-evaluate
  }
  try {
    const current = readFileSync(claim, 'utf8')
    if (current.trim() === expected && statSync(claim).ino === expectedIno) {
      unlinkSync(claim)
      return true
    }
    try {
      linkSync(claim, lockPath)
    } catch (err: any) {
      if (LINK_UNSUPPORTED.has(err?.code)) {
        try {
          const fd = openSync(lockPath, 'wx')
          try { writeSync(fd, current.trim()) } finally { closeSync(fd) }
        } catch { /* someone acquired meanwhile — theirs wins */ }
      }
    }
    try { unlinkSync(claim) } catch { /* already gone */ }
  } catch {
    // The claim file is uniquely named; nothing else would ever clean it up.
    try { unlinkSync(claim) } catch { /* already gone */ }
  }
  return false
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
  // Counted from the first synchronous line, before any await: the count must
  // already be non-zero by the time an O_EXCL create could be in flight.
  pendingOps++
  try {
    // Resolve so `./a/engrams.yaml` and `/abs/a/engrams.yaml` share one queue.
    // The file lock gets that for free — the kernel resolves the path for
    // O_EXCL — but the in-process key is a plain string and has to do it itself.
    return await processLocks.run(path.resolve(filePath), () => withFileLock(filePath, fn, options))
  } finally {
    pendingOps--
  }
}

/** Lock operations in this process: queued, acquiring, held or releasing. */
let pendingOps = 0

/**
 * How many {@link withAsyncLock} operations this process has in progress —
 * queued behind another in-process caller, acquiring the file lock, holding
 * it, or releasing it (#1343).
 *
 * For a process about to force-exit (CLI hooks call `process.exit()`, which
 * does not wait for in-flight work). The lock FILE cannot answer "is this
 * process inside a store write?": between one caller's release and the next
 * caller's O_EXCL create there is no file on disk, yet the create is already
 * issued — and one that lands after the exit is an empty lock nobody will
 * release, which every other writer waits out for the 60s stale threshold.
 * Zero here, checked in the same synchronous step as the exit, means no such
 * operation can be in flight.
 */
export function pendingStoreLockOps(): number {
  return pendingOps
}
