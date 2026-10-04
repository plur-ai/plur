/**
 * Formal-verification replay, round 2 (spec/formal/PlurSpec/R2Persist.lean §1,
 * findings/r2-persist.md item 1): the steal guard itself must survive a crash.
 *
 * Round 1 serialized lock stealing with a guard file. Removing a guard abandoned
 * by a crashed stealer was an unguarded read-then-unlink, so this double fault
 * reopened the round-1 race:
 *
 *   S (dead) left the guard behind; H (dead) holds the lock.
 *   A and B both read the guard, both judge it abandoned.
 *   A unlinks it, re-creates it as its own, re-reads the lock (= H), goes to rename.
 *   B's unlink — judged on S's guard — removes A's LIVE guard; B creates its own.
 *   Both are inside the guard; A claims H and acquires; B renames A's live lock
 *   aside; C O_EXCL-acquires the empty path; B's put-back fails. A and C both hold.
 *
 * Several "processes" live in one process by locking the same file through
 * symlinked directories (the in-process queue is keyed by `path.resolve`, which
 * does not follow symlinks; the O_EXCL file is one inode). `unlink` and `rename`
 * are wrapped to force the interleaving.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, readdirSync, existsSync } from 'fs'
import { tmpdir, hostname } from 'os'
import { join } from 'path'

type Rename = (a: string, b: string) => Promise<void>
type Unlink = (p: string) => Promise<void>
const hooks = vi.hoisted(() => ({
  rename: null as null | ((orig: Rename, a: string, b: string) => Promise<void>),
  unlink: null as null | ((orig: Unlink, p: string) => Promise<void>),
}))

vi.mock('fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('fs/promises')>()
  const rename = (a: string, b: string) =>
    hooks.rename ? hooks.rename(orig.rename as any, a, b) : orig.rename(a, b)
  const unlink = (p: string) =>
    hooks.unlink ? hooks.unlink(orig.unlink as any, String(p)) : orig.unlink(p)
  return { ...orig, rename, unlink, default: { ...orig, rename, unlink } }
})

import * as lockMod from '../src/store/async-lock.js'
import { withLock } from '../src/sync.js'
const { withAsyncLock } = lockMod

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
const within = (p: Promise<void>, ms: number) => Promise.race([p, new Promise<void>(r => setTimeout(r, ms))])

// pids above the platform maximum: liveness probe says "dead" at once.
const DEAD_HOLDER = `${hostname()}:999999:1:0`
const DEAD_STEALER = `${hostname()}:999998:1:0`

/** Plant a guard abandoned by a crashed stealer, wherever the implementation looks for one. */
function plantAbandonedGuard(lockPath: string, expected: string): void {
  writeFileSync(lockPath + '.steal', DEAD_STEALER) // round-1 single guard
  const slotPath = (lockMod as any).stealGuardPath
  if (typeof slotPath === 'function') writeFileSync(slotPath(lockPath, expected, 0), DEAD_STEALER)
}

describe('formal-r2-persist: steal guard abandoned by a crashed stealer', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-r2guard-')) })
  afterEach(() => { hooks.rename = null; hooks.unlink = null; rmSync(dir, { recursive: true, force: true }) })

  it('two live stealers never share the guard, so at most one holder is in the critical section', async () => {
    const real = join(dir, 'real')
    mkdirSync(real)
    const views = ['pA', 'pB', 'pC'].map(n => { const p = join(dir, n); symlinkSync(real, p); return join(p, 'engrams.yaml') })
    const lockPath = join(real, 'engrams.yaml.lock')
    writeFileSync(lockPath, DEAD_HOLDER)
    plantAbandonedGuard(lockPath, DEAD_HOLDER)

    let inCS = 0
    let maxInCS = 0
    const firstEntered = deferred()
    const cEntered = deferred()
    const releaseAll = deferred()
    const body = (onEnter: () => void) => async () => {
      inCS++
      maxInCS = Math.max(maxInCS, inCS)
      onEnter()
      await releaseAll.promise
      inCS--
    }

    // Both cleaners judge the abandoned guard before either unlinks it; the second
    // unlink waits until the first cleaner is back inside a guard of its own.
    const secondUnlink = deferred()
    const firstRename = deferred()
    const secondRename = deferred()
    let guardUnlinks = 0
    hooks.unlink = async (orig, p) => {
      if (!p.endsWith('.lock.steal')) return orig(p)
      const n = ++guardUnlinks
      if (n === 1) { await within(secondUnlink.promise, 300); return orig(p) }
      if (n === 2) { secondUnlink.resolve(); await within(firstRename.promise, 1000); return orig(p) }
      return orig(p)
    }

    let steals = 0
    let cRun: Promise<void> | null = null
    hooks.rename = async (orig, a, b) => {
      if (!b.includes('.steal.')) return orig(a, b)
      const n = ++steals
      if (n === 1) {
        firstRename.resolve()
        await within(secondRename.promise, 800)
        return orig(a, b)
      }
      if (n === 2) {
        secondRename.resolve()
        await firstEntered.promise
        await orig(a, b)
        cRun = withAsyncLock(views[2], body(() => cEntered.resolve()), { baseDelay: 1 })
        await within(cEntered.promise, 300)
        return
      }
      return orig(a, b)
    }

    const aRun = withAsyncLock(views[0], body(() => firstEntered.resolve()), { baseDelay: 1 })
    const bRun = withAsyncLock(views[1], body(() => firstEntered.resolve()), { baseDelay: 1 })
    await firstEntered.promise
    await new Promise(r => setTimeout(r, 1200))
    releaseAll.resolve()
    await Promise.all([aRun, bRun, cRun ?? Promise.resolve()])

    expect(steals).toBeGreaterThanOrEqual(1)
    expect(maxInCS).toBe(1)
  }, 30_000)

  it('recovers from an abandoned guard and leaves no guard files behind (async)', async () => {
    const file = join(dir, 'engrams.yaml')
    const lockPath = file + '.lock'
    writeFileSync(lockPath, DEAD_HOLDER)
    plantAbandonedGuard(lockPath, DEAD_HOLDER)
    const got = await withAsyncLock(file, async () => 'in', { baseDelay: 1, acquireTimeout: 5_000 })
    expect(got).toBe('in')
    const left = readdirSync(dir).filter(f => f.startsWith('engrams.yaml.lock') && f !== 'engrams.yaml.lock.steal')
    expect(left).toEqual([])
    expect(existsSync(lockPath)).toBe(false)
  })

  it('recovers from an abandoned guard and leaves no guard files behind (sync twin)', () => {
    const file = join(dir, 'episodes.yaml')
    const lockPath = file + '.lock'
    writeFileSync(lockPath, DEAD_HOLDER)
    plantAbandonedGuard(lockPath, DEAD_HOLDER)
    const got = withLock(file, () => 'in', { baseDelay: 1, maxRetries: 20 })
    expect(got).toBe('in')
    const left = readdirSync(dir).filter(f => f.startsWith('episodes.yaml.lock') && f !== 'episodes.yaml.lock.steal')
    expect(left).toEqual([])
  })

  it('a guard slot held by a live stealer is never removed or bypassed (sync twin)', () => {
    const file = join(dir, 'tensions.yaml')
    const lockPath = file + '.lock'
    writeFileSync(lockPath, DEAD_HOLDER)
    const slotPath = (lockMod as any).stealGuardPath
    // A live stealer (this process) holds the only guard for H.
    const live = `${hostname()}:${process.pid}:1:0`
    const guard = typeof slotPath === 'function' ? slotPath(lockPath, DEAD_HOLDER, 0) : lockPath + '.steal'
    writeFileSync(guard, live)
    expect(() => withLock(file, () => 'in', { baseDelay: 1, maxRetries: 3 })).toThrow(/Failed to acquire lock/)
    expect(existsSync(guard)).toBe(true)
  })
})
