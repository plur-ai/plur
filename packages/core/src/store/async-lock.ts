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
  writeFileSync, renameSync, readFileSync,
} from 'fs'
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

/** Would a waiter be entitled to take over a lock with this holder and mtime? */
function isAbandoned(holder: string, mtimeMs: number, staleThreshold: number): boolean {
  const alive = holderIsAlive(holder)
  if (alive === false) return true
  return alive === undefined && abandonedByAge(holder, Date.now() - mtimeMs, staleThreshold)
}

/** The guard that serializes takeovers of `lockPath` (#1354). */
function takeoverGuardPath(lockPath: string): string {
  return `${lockPath}.takeover`
}

/**
 * Take over an abandoned lock — serialized against every other takeover
 * (#1354). Returns false when another process holds the takeover guard.
 *
 * Why a guard. The rename claim in {@link stealLock} makes the steal itself
 * single-winner, but not the DECISION. Two waiters that judged the same
 * abandoned lock can both reach `rename`: the first claims it, removes it and
 * acquires a fresh lock; the second's rename then moves THAT fresh, live lock
 * aside. It sees the wrong file and puts it back — but while the path is free
 * a third process can create a lock there, and then two processes believe
 * they hold it. The concurrent-takeover test caught exactly this under load.
 *
 * Under the guard, only one process at a time inspects-and-removes. It
 * re-inspects `lockPath` after taking the guard, so a decision made on an old
 * inspection is never acted on. Between that re-inspection and its `rename`
 * the file at `lockPath` cannot be replaced by a new-code acquirer: the path
 * only frees when the abandoned file is removed, and only the guard holder
 * removes abandoned files. (The file's owner could remove it only if it were
 * alive after all, which for a dead pid is impossible and for the age rules
 * means a holder stalled past the whole threshold.) Acquirers do NOT take the
 * guard — the uncontended path stays one `link`.
 *
 * The guard is published like a lock (token included), held for a handful of
 * syscalls, and a guard whose holder died is removed by the same rules as a
 * lock. Clearing it returns false rather than proceeding, so the caller loops
 * and competes for the guard afresh.
 */
async function takeOver(lockPath: string, staleThreshold: number): Promise<boolean> {
  const guard = takeoverGuardPath(lockPath)
  const token = makeToken()
  try {
    await publishLockFile(guard, token)
  } catch (err: any) {
    if (err?.code !== 'EEXIST') return false
    const g = await inspectLock(guard)
    if (g && isAbandoned(g.holder, g.mtimeMs, staleThreshold)) await stealLock(guard, g.holder, g.ino)
    return false
  }
  try {
    const cur = await inspectLock(lockPath)
    if (cur && isAbandoned(cur.holder, cur.mtimeMs, staleThreshold)) {
      await stealLock(lockPath, cur.holder, cur.ino)
    }
    return true
  } finally {
    await releaseIfOurs(guard, token)
  }
}

/** Synchronous twin of {@link takeOver}, for `withLock` in `sync.ts`. */
export function takeOverSync(lockPath: string, staleThreshold: number): boolean {
  const guard = takeoverGuardPath(lockPath)
  const token = makeToken()
  try {
    publishLockFileSync(guard, token)
  } catch (err: any) {
    if (err?.code !== 'EEXIST') return false
    const g = inspectLockSync(guard)
    if (g && isAbandoned(g.holder, g.mtimeMs, staleThreshold)) stealLockSync(guard, g.holder, g.ino)
    return false
  }
  try {
    const cur = inspectLockSync(lockPath)
    if (cur && isAbandoned(cur.holder, cur.mtimeMs, staleThreshold)) {
      stealLockSync(lockPath, cur.holder, cur.ino)
    }
    return true
  } finally {
    try {
      if (readFileSync(guard, 'utf8').trim() === token) unlinkSync(guard)
    } catch { /* already gone */ }
  }
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
async function stealLock(lockPath: string, expected: string, expectedIno: number): Promise<void> {
  const claim = privateSibling(lockPath, 'steal', makeToken())
  try {
    await rename(lockPath, claim)
  } catch {
    return // another contender claimed it, or the holder released — re-evaluate
  }
  try {
    // Same FILE, not just the same contents (#1354). Contents cannot tell two
    // empty locks apart: if the old empty lock we judged was released and a
    // creator made a fresh one before our rename, '' === '' would delete a
    // lock whose owner is about to write its token.
    const [current, s] = await Promise.all([readFile(claim, 'utf8'), stat(claim)])
    if (current.trim() === expected && s.ino === expectedIno) {
      await unlink(claim) // confirmed the one we judged abandoned
      return
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
}

/**
 * Synchronous twin of {@link stealLock}, for `withLock` in `sync.ts`: the same
 * single-winner rename claim, the same file-identity check, the same restore.
 */
function stealLockSync(lockPath: string, expected: string, expectedIno: number): void {
  const claim = privateSibling(lockPath, 'steal', makeToken())
  try {
    renameSync(lockPath, claim)
  } catch {
    return // another contender claimed it, or the holder released — re-evaluate
  }
  try {
    const current = readFileSync(claim, 'utf8')
    if (current.trim() === expected && statSync(claim).ino === expectedIno) {
      unlinkSync(claim)
      return
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
