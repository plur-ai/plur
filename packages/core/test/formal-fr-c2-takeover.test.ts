/**
 * Formal-verification replay, field report 2026-09-29, cluster 2 — OPEN CONFLICT G
 * (spec/formal/PlurSpec/R2Persist.lean §6 `TakeoverG`, findings/persistence.md G).
 *
 * Two schedules that put two live holders in the critical section of one of the
 * designs being combined here, and that the combined design must survive:
 *
 *   1. `pr1398_two_holders` — the double fault #1398's single `.takeover` guard does
 *      not survive: the lock holder AND a stealer holding the guard are dead. Two
 *      stealers judge the dead guard; the first claims it and takes a fresh one; the
 *      second's rename (judged on the dead guard) moves the first's LIVE guard aside;
 *      a third publishes a guard at the free path. Two stealers are then "under the
 *      guard" together; the second of them renames the first's freshly acquired lock
 *      aside and a fourth process acquires the free path.
 *
 *   2. `pr1228_two_holders` — two EMPTY lock instances look alike: a creator died
 *      between create and token write. Two stealers judge that empty lock; the first
 *      claims it and creates its own lock, which is empty until its write lands; the
 *      second re-checks, reads '' as judged, and claims the first's live file.
 *
 * Several "processes" live in one process by locking the same file through
 * symlinked directories (the in-process queue is keyed by `path.resolve`, which does
 * not follow symlinks; the lock file is one inode). `rename`, `link`, `open` and
 * `writeFile` are wrapped to force the interleavings; each wait is bounded, so a
 * design that refuses a step just runs on.
 *
 * `PLUR_FORMAL_LOCK_MODULE` points the test at another copy of async-lock.ts — how the
 * mutation check ran it against #1398's and #1228's own files (both fail).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, utimesSync, readdirSync } from 'fs'
import { tmpdir, hostname } from 'os'
import { join } from 'path'

type Fn = (...a: any[]) => Promise<any>
const hooks = vi.hoisted(() => ({
  rename: null as null | ((orig: Fn, a: string, b: string) => Promise<void>),
  link: null as null | ((orig: Fn, a: string, b: string) => Promise<void>),
  open: null as null | ((orig: Fn, p: string, flags: any, mode?: any) => Promise<any>),
  writeFile: null as null | ((orig: Fn, p: string, data: any, opts: any) => Promise<void>),
  realOpen: null as null | Fn,
}))

vi.mock('fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('fs/promises')>()
  hooks.realOpen = orig.open as Fn
  const rename = (a: any, b: any) => hooks.rename ? hooks.rename(orig.rename as Fn, String(a), String(b)) : orig.rename(a, b)
  const link = (a: any, b: any) => hooks.link ? hooks.link(orig.link as Fn, String(a), String(b)) : orig.link(a, b)
  const open = (p: any, f?: any, m?: any) => hooks.open ? hooks.open(orig.open as Fn, String(p), f, m) : orig.open(p, f, m)
  const writeFile = (p: any, d: any, o?: any) =>
    hooks.writeFile ? hooks.writeFile(orig.writeFile as Fn, String(p), d, o) : orig.writeFile(p, d, o)
  const patched = { rename, link, open, writeFile }
  return { ...orig, ...patched, default: { ...orig, ...patched } }
})

const LOCK_MODULE = process.env.PLUR_FORMAL_LOCK_MODULE ?? '../src/store/async-lock.js'
let lockMod: any

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
const within = (p: Promise<void>, ms: number) => Promise.race([p, new Promise<void>(r => setTimeout(r, ms))])

// pids above the platform maximum: the liveness probe says "dead" at once.
const DEAD_HOLDER = `${hostname()}:999999:1:0`
const DEAD_STEALER = `${hostname()}:999998:1:0`

let dir: string
let real: string
let lockPath: string
let views: string[]

beforeEach(async () => {
  lockMod ??= await import(LOCK_MODULE)
  dir = mkdtempSync(join(tmpdir(), 'plur-fr-c2-'))
  real = join(dir, 'real')
  mkdirSync(real)
  views = ['pA', 'pB', 'pC', 'pD'].map(n => { const p = join(dir, n); symlinkSync(real, p); return join(p, 'engrams.yaml') })
  lockPath = join(real, 'engrams.yaml.lock')
})
afterEach(() => {
  hooks.rename = null; hooks.link = null; hooks.open = null; hooks.writeFile = null
  rmSync(dir, { recursive: true, force: true })
})

/** Counts how many callers are inside the critical section at once. */
function csMeter() {
  const releaseAll = deferred()
  const m = {
    inCS: 0, maxInCS: 0, releaseAll,
    body: (onEnter: () => void = () => {}) => async () => {
      m.inCS++
      m.maxInCS = Math.max(m.maxInCS, m.inCS)
      onEnter()
      await releaseAll.promise
      m.inCS--
    },
  }
  return m
}

const isGuard = (p: string) => p.endsWith('.lock.takeover') || /\.lock\.guard-/.test(p)
const isLock = (p: string) => p.endsWith('engrams.yaml.lock')
const opts = { baseDelay: 1, acquireTimeout: 5_000 }

describe('conflict G: lock takeover survives the schedules that break #1398 and #1228 alone', () => {
  it('lock holder and guard holder both dead: two stealers never share the guard, so never two holders', async () => {
    writeFileSync(lockPath, DEAD_HOLDER)
    // A stealer that died inside the guard, wherever the implementation keeps one.
    writeFileSync(lockPath + '.takeover', DEAD_STEALER)
    if (typeof lockMod.stealGuardPath === 'function') writeFileSync(lockMod.stealGuardPath(lockPath, DEAD_HOLDER, 0), DEAD_STEALER)

    const m = csMeter()
    const secondArrived = deferred(), firstLockRename = deferred(), thirdLockRename = deferred()
    const firstEntered = deferred(), fourthEntered = deferred(), thirdGuard = deferred()
    let guardRenames = 0, lockRenames = 0, secondRenamed = false
    const runs: Promise<unknown>[] = []

    hooks.rename = async (orig, a, b) => {
      if (isGuard(a) && b.includes('.steal.')) {
        const n = ++guardRenames
        if (n === 1) await within(secondArrived.promise, 1_000)
        if (n === 2) { secondArrived.resolve(); await within(firstLockRename.promise, 1_500); secondRenamed = true }
        return orig(a, b)
      }
      if (isLock(a) && b.includes('.steal.')) {
        const n = ++lockRenames
        if (n === 1) { firstLockRename.resolve(); await within(thirdLockRename.promise, 2_000) }
        if (n === 2) {
          thirdLockRename.resolve()
          await within(firstEntered.promise, 2_000)
          await orig(a, b)
          runs.push(lockMod.withAsyncLock(views[2], m.body(() => fourthEntered.resolve()), opts))
          await within(fourthEntered.promise, 1_500)
          return
        }
      }
      return orig(a, b)
    }
    hooks.link = async (orig, a, b) => {
      if (isGuard(b) && a.includes('.steal.')) {
        // The second stealer puts back the guard it moved; first let a third publish one.
        runs.push(lockMod.withAsyncLock(views[3], m.body(), opts))
        await within(thirdGuard.promise, 1_500)
        return orig(a, b)
      }
      const r = await orig(a, b)
      if (isGuard(b) && a.includes('.publish.') && secondRenamed) thirdGuard.resolve()
      return r
    }

    runs.push(lockMod.withAsyncLock(views[0], m.body(() => firstEntered.resolve()), opts))
    runs.push(lockMod.withAsyncLock(views[1], m.body(() => firstEntered.resolve()), opts))
    await firstEntered.promise
    await new Promise(r => setTimeout(r, 2_500))
    m.releaseAll.resolve()
    await Promise.allSettled(runs)
    await Promise.allSettled(runs) // runs started by hooks while settling

    expect(lockRenames).toBeGreaterThanOrEqual(1) // the dead holder's lock was taken over
    expect(m.maxInCS).toBe(1)
  }, 30_000)

  for (const fallback of [false, true]) {
    it(`two empty lock files are never mistaken for each other${fallback ? ' (no-hard-link fallback)' : ''}`, async () => {
      // A creator killed between its create and its token write, long ago.
      writeFileSync(lockPath, '')
      const old = new Date(Date.now() - 30_000)
      utimesSync(lockPath, old, old)

      const m = csMeter()
      const firstInGap = deferred(), secondDone = deferred()
      let slotCreates = 0, claimed = false, gapUsed = false
      hooks.rename = async (orig, a, b) => {
        await orig(a, b)
        if (isLock(a) && b.includes('.steal.')) claimed = true
      }
      // The second stealer reaches the steal guard only once the first one's fresh
      // lock exists and is still empty.
      hooks.writeFile = async (orig, p, data, o) => {
        if (/\.lock\.guard-/.test(p) && ++slotCreates === 2) await within(firstInGap.promise, 3_000)
        if (isLock(p) && claimed && !gapUsed) {
          // An O_EXCL writeFile (the create-then-write lock): split at its create/write boundary.
          gapUsed = true
          const fh = await hooks.realOpen!(p, 'wx')
          firstInGap.resolve()
          await within(secondDone.promise, 3_000)
          await fh.writeFile(data)
          await fh.close()
          return
        }
        return orig(p, data, o)
      }
      hooks.open = async (orig, p, flags, mode) => {
        const fh = await orig(p, flags, mode)
        if (fallback && isLock(p) && flags === 'wx' && claimed && !gapUsed) {
          gapUsed = true
          const w = fh.writeFile.bind(fh)
          fh.writeFile = async (d: any) => { firstInGap.resolve(); await within(secondDone.promise, 3_000); return w(d) }
        }
        return fh
      }
      if (fallback) {
        hooks.link = async (orig, a, b) => {
          if (isLock(b) && a.includes('.publish.')) throw Object.assign(new Error('EPERM: no hard links'), { code: 'EPERM' })
          return orig(a, b)
        }
      }

      const o = { ...opts, staleThreshold: 20_000 } // empty 30 s old: abandoned under every design here
      const runs = [
        lockMod.withAsyncLock(views[0], m.body(), o),
        lockMod.withAsyncLock(views[1], m.body(), o),
      ]
      const watch = setInterval(() => { if (m.inCS > 0 && gapUsed) secondDone.resolve() }, 5)
      setTimeout(() => secondDone.resolve(), 2_500)
      await new Promise(r => setTimeout(r, 4_000))
      clearInterval(watch)
      m.releaseAll.resolve()
      const res = await Promise.allSettled(runs)

      expect(claimed).toBe(true) // the dead creator's empty lock was taken over
      expect(res.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(m.maxInCS).toBe(1)
      expect(readdirSync(real).filter(f => f.includes('.steal.'))).toEqual([])
    }, 30_000)
  }
})
