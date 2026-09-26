/**
 * Formal-verification replay (spec/formal/PlurSpec/Persistence.lean §3, candidate 3):
 * mutual exclusion of `withAsyncLock` under a stale-lock steal race.
 *
 * Three "processes" are simulated in one process by locking the same file through
 * three different symlinked directories: the in-process queue is keyed by
 * `path.resolve` (which does not follow symlinks), the O_EXCL lock file is the
 * same inode. `rename` is wrapped to fix one interleaving deterministically:
 *
 *   H (dead pid) holds the lock. A and B both judge it abandoned.
 *   A renames H aside, confirms it, O_EXCL-creates its own lock, enters.
 *   B renames the lock aside — now A's LIVE lock — and, before B puts it back,
 *   C O_EXCL-creates at the empty path and enters. B's put-back fails (EEXIST).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'fs'
import { tmpdir, hostname } from 'os'
import { join } from 'path'

const hooks = vi.hoisted(() => ({
  rename: null as null | ((orig: (a: string, b: string) => Promise<void>, a: string, b: string) => Promise<void>),
}))

vi.mock('fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('fs/promises')>()
  const rename = (a: string, b: string) =>
    hooks.rename ? hooks.rename(orig.rename as any, a, b) : orig.rename(a, b)
  return { ...orig, rename, default: { ...orig, rename } }
})

import { withAsyncLock } from '../src/store/async-lock.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

describe('formal-persistence: async lock mutual exclusion under a steal race', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-flock-')) })
  afterEach(() => { hooks.rename = null; rmSync(dir, { recursive: true, force: true }) })

  it('at most one holder in the critical section', async () => {
    const real = join(dir, 'real')
    mkdirSync(real)
    const views = ['pA', 'pB', 'pC'].map(n => { const p = join(dir, n); symlinkSync(real, p); return join(p, 'engrams.yaml') })
    // A dead holder on this host: liveness says false ⇒ stolen at once.
    writeFileSync(join(real, 'engrams.yaml.lock'), `${hostname()}:999999:1:0`)

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

    let steals = 0
    let cRun: Promise<void> | null = null
    hooks.rename = async (orig, a, b) => {
      if (!b.includes('.steal.')) return orig(a, b)
      const n = ++steals
      if (n === 1) return orig(a, b)
      if (n === 2) {
        // Second stealer: wait until the first one holds the lock, then move it aside.
        await firstEntered.promise
        await orig(a, b)
        cRun = withAsyncLock(views[2], body(() => cEntered.resolve()), { baseDelay: 1 })
        await Promise.race([cEntered.promise, new Promise(r => setTimeout(r, 300))])
        return
      }
      return orig(a, b)
    }

    const aRun = withAsyncLock(views[0], body(() => firstEntered.resolve()), { baseDelay: 1 })
    const bRun = withAsyncLock(views[1], body(() => firstEntered.resolve()), { baseDelay: 1 })
    // Let the interleaving play out, then release everyone.
    await firstEntered.promise
    await new Promise(r => setTimeout(r, 500))
    releaseAll.resolve()
    await Promise.all([aRun, bRun, cRun ?? Promise.resolve()])

    expect(steals).toBeGreaterThanOrEqual(1)
    expect(maxInCS).toBe(1)
  })
})
