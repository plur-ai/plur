/**
 * The auto-rate worker lock takes over a stale lock through core's guarded
 * takeover, so a live worker is never displaced (findings/hook-counters.md §4,
 * HookCounters `orig_live_holder_displaced`, `live_holder_never_displaced`).
 *
 * The race: worker B judges a dead lock stale; before B acts, worker A takes it
 * over and acquires; while B's takeover has the lock moved aside, worker C
 * acquires. A rename-and-restore takeover then fails to put A's lock back, and
 * A and C both run as the session's worker. The fs hooks below replay that
 * schedule in-process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as realFs from 'fs'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const hooks: {
  afterRead?: (path: string, data: string) => void
  afterRename?: (from: string) => void
} = {}

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const out = actual.readFileSync(...args)
      if (typeof args[0] === 'string') hooks.afterRead?.(args[0], String(out))
      return out
    }) as typeof actual.readFileSync,
    renameSync: ((from: realFs.PathLike, to: realFs.PathLike) => {
      actual.renameSync(from, to)
      hooks.afterRename?.(String(from))
    }) as typeof actual.renameSync,
  }
})

describe('auto-rate worker lock: a live worker is never displaced', () => {
  let root: string
  let savedTmp: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-worker-lock-'))
    savedTmp = process.env.TMPDIR
    process.env.TMPDIR = root
  })

  afterEach(() => {
    hooks.afterRead = undefined
    hooks.afterRename = undefined
    if (savedTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedTmp
    rmSync(root, { recursive: true, force: true })
  })

  it('two workers race for a stale lock while a third acquires: the live holder keeps the lock', async () => {
    vi.resetModules()
    const mod = await import('../src/lib/auto-rate.js')
    const dir = join(root, 'plur-auto-rate')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const lock = join(dir, 'claude-race.worker')
    const dead = '999999999:dead:qws'
    const tokenA = `${process.pid}:worker-a:qws`
    const tokenC = `${process.pid}:worker-c:qws`
    writeFileSync(lock, dead)

    // A takes over the dead lock and acquires right after B has read it.
    let aDone = false
    hooks.afterRead = (path, data) => {
      if (aDone || path !== lock || data.trim() !== dead.trim()) return
      aDone = true
      realFs.unlinkSync(lock)
      realFs.writeFileSync(lock, tokenA)
    }
    // C acquires whenever the lock path is moved aside.
    hooks.afterRename = (from) => {
      if (from !== lock) return
      try { realFs.writeFileSync(lock, tokenC, { flag: 'wx' }) } catch { /* taken */ }
    }

    expect(mod.acquireWorkerLock(lock)).toBe(false)
    expect(aDone).toBe(true)
    expect(readFileSync(lock, 'utf8')).toBe(tokenA)
  })
})
