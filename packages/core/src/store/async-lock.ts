/**
 * Async file lock: an in-process queue in front of an O_EXCL file lock.
 *   - in-process (KeyedAsyncMutex): callers in THIS process queue FIFO, with no
 *     polling or spurious `Failed to acquire lock` under normal concurrency.
 *   - cross-process (exclusive create + async retry): another process's lock is
 *     waited out with an async backoff. The file is published with its owner
 *     token already in it, never empty (see `publishLockFile`).
 * The backoff is an async sleep, never a busy-wait. NOT REENTRANT: `fn` must not
 * acquire the same path again (deadlock); nesting on another path is a hazard.
 */
import { writeFile, unlink, stat, readFile, rename, open, link } from 'fs/promises'
import {
  linkSync, openSync, writeSync, closeSync, fstatSync, statSync, unlinkSync,
  writeFileSync, renameSync, readFileSync, constants, utimesSync,
} from 'fs'
import { hostname } from 'os'
import { createHash } from 'crypto'
import * as path from 'path'
import { KeyedAsyncMutex } from '../async-mutex.js'
import { logger } from '../logger.js'

export interface AsyncLockOptions {
  /**
   * @deprecated Superseded by {@link AsyncLockOptions.acquireTimeout}, which
   * bounds the wait in TIME rather than in attempts. When set, it still caps
   * the number of retries.
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
   * still considers legitimate (see {@link DEFAULT_ACQUIRE_TIMEOUT}).
   */
  acquireTimeout?: number
}

/**
 * How long before an untouched lock is considered abandoned. Large on purpose:
 * stealing from a process still writing (big store, cloud-synced `~/.plur`,
 * suspended laptop) corrupts the corpus. Crash recovery stays fast because a
 * dead holder's lock is stolen at once by the liveness check.
 */
export const DEFAULT_STALE_THRESHOLD = 60_000

/**
 * How long a waiter keeps trying before giving up. Must be LARGER than
 * {@link DEFAULT_STALE_THRESHOLD}, so a waiter behind a stuck holder reaches the
 * stale check instead of throwing (and losing e.g. a `plur_learn`). Must also
 * exceed the longest legitimate hold: `Plur.sync()` holds the lock across git
 * fetch/pull/push (30s timeout each, ~90s plus local staging). Anything that raises git's per-command
 * timeout must raise this too.
 */
export const DEFAULT_ACQUIRE_TIMEOUT = 180_000

/**
 * How old an EMPTY lock file must be before it is treated as abandoned. An
 * empty lock has no pid to probe; it comes from a creator that died between
 * create and token write, or from older clients / filesystems without hard
 * links that create first and write second. The grace must clear that live
 * create→write gap (measured worst case under 1s, plus a blocked event loop
 * during a large synchronous YAML parse) by a wide margin, yet recover well
 * before the stale threshold.
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
 * Create `lockPath` holding `token`, or throw `EEXIST` if it exists. The token
 * is written to a private file and hard-linked into place (`link()` fails with
 * `EEXIST` like `O_EXCL`), so the lock never exists empty; a kill leaves at most
 * an inert private file. Without hard links: create-then-write, then verify the
 * path still names our file; if an empty-lock takeover moved it during a stall
 * longer than {@link EMPTY_LOCK_GRACE_MS}, report `EEXIST` and retry.
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
 * a confirmed-dead one is stolen at once. An EMPTY lock is abandoned
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
 * The nonce is what makes release safe: a holder removes the lock only if the
 * file still carries its own token, so after a steal the original holder's
 * `finally` cannot delete the new holder's lock and let a third process in.
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
 * Heartbeat. A contender that cannot probe the holder's liveness (other host,
 * legacy bare-pid token) steals by age after `staleThreshold`, which a
 * legitimate hold like `Plur.sync()` can outlast. So a holder re-touches its
 * own lock (token-checked `utimes`) every `staleThreshold / 3`: from a timer,
 * and from {@link heartbeatHeldLocks} at synchronous touch points (sync.ts calls
 * it before every blocking git command). Both lock implementations register
 * here; the heartbeat stops on release and on throw.
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
 * refused: short thresholds are legitimate for locks that never run git.
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
    // before a stale lock can be stolen.
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
    // another process keeps recreating stale would spin forever.
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
        // (2) We cannot probe this holder, so age is the only signal left.
        //     Age is deliberately NOT consulted when liveness came back TRUE:
        //     stealing from a slow live writer corrupts the corpus, while a
        //     wedged one yields a visible error after `acquireTimeout`.
        //     An EMPTY lock gets a much shorter window (see EMPTY_LOCK_GRACE_MS).
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

  // Heartbeat while held; stopped before release, on return or throw.
  const stopHeartbeat = acquired ? startHeartbeat(lockPath, token, staleThreshold) : () => {}
  try {
    return await fn()
  } finally {
    stopHeartbeat()
    // Only ours to remove. `acquired` stops a failed acquisition deleting the
    // holder's file; the token comparison stops US deleting a THIEF's file
    // after our lock was stolen, which would cascade one steal into several.
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
 * Take over an abandoned lock, serialized by a steal-guard LADDER (proofs:
 * spec/formal/PlurSpec/R2Persist.lean `ladder_mutex`, and `TakeoverG`
 * `combined_mutex`). Returns false when another contender is taking over the
 * same lock instance.
 * - The guard is needed because two waiters can both DECIDE to steal the same lock.
 *   A ladder, not one `.takeover` file: removing a crashed single guard is itself a
 *   read-then-unlink race.
 * - Slots are keyed by the judged token, so only a slot's writer unlinks it; a
 *   dead slot is stepped over, never deleted.
 * - Under the slot, claim only the same token AND inode (empty locks have equal
 *   contents), and only if STILL abandoned (the holder may have refreshed its mtime).
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
    // Still abandoned NOW, not only the same file. A holder we
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
    // Still abandoned NOW, not only the same file. A holder we
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
 * Remove a lock believed abandoned, by CLAIMING it first with `rename` (only one
 * process can rename a path; the loser gets ENOENT). Read-compare-unlink would
 * let two contenders both delete and both acquire. A contender only ever
 * deletes a file it has already moved away from `lockPath`. Losing the claim is
 * not a failure: the caller loops; mutual exclusion is still decided by the
 * exclusive create ({@link publishLockFile}).
 */
async function stealLock(lockPath: string, expected: string, expectedIno: number): Promise<boolean> {
  const claim = privateSibling(lockPath, 'steal', makeToken())
  try {
    await rename(lockPath, claim)
  } catch {
    return false // another contender claimed it, or the holder released — re-evaluate
  }
  try {
    // Same FILE, not just the same contents. Contents cannot tell two
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
 * How many {@link withAsyncLock} operations this process has in progress
 * (queued, acquiring, holding or releasing). For a process about to force-exit:
 * the lock file cannot answer this, since a create issued before exit can land
 * after it as an empty lock nobody releases. Zero here, checked in the same
 * synchronous step as the exit, means no such operation is in flight.
 */
export function pendingStoreLockOps(): number {
  return pendingOps
}
