/**
 * Apply phase of the formal-verification run (owner decision P1 heartbeat).
 * Model: spec/formal/PlurSpec/Persistence.lean (Lock heartbeat section).
 *
 * A lock holder re-touches its lock file every staleThreshold/3 while it holds
 * it, so a live holder on another host (whose liveness a contender cannot
 * probe, so only the file's age is left) is never judged stale. The heartbeat
 * stops on release and on throw.
 *
 * Replayed pre-fix (persistence.md §4): a holder on another host, mid-hold past
 * the stale threshold, had its lock stolen and a second process entered.
 *
 * "Another host" is simulated with a mocked `os.hostname`: the holder takes the
 * lock as host-A, then the process reports host-B, so the contender reads the
 * holder's token as foreign (liveness unknown → age decides). The two
 * "processes" lock the same file through two symlinked directories: the
 * in-process queue is keyed by `path.resolve`, which does not follow symlinks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, statSync, utimesSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const host = vi.hoisted(() => ({ name: 'host-A' }))
vi.mock('os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('os')>()
  const hostname = () => host.name
  return { ...orig, hostname, default: { ...orig, hostname } }
})

import * as asyncLock from '../src/store/async-lock.js'
import { withAsyncLock } from '../src/store/async-lock.js'
import { withLock } from '../src/sync.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const spin = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* block */ } }
// Absent before the fix; a no-op stand-in keeps the behavioural assertions meaningful.
const heartbeatHeldLocks: () => void = (asyncLock as any).heartbeatHeldLocks ?? (() => {})
const activeHeartbeats: () => number = (asyncLock as any).activeHeartbeats ?? (() => 0)

describe('P1 — a lock holder heartbeats its lock', () => {
  let dir: string
  let real: string
  let link: string
  beforeEach(() => {
    host.name = 'host-A'
    dir = mkdtempSync(join(tmpdir(), 'plur-apply-lock-'))
    real = join(dir, 'real')
    mkdirSync(real)
    link = join(dir, 'link')
    symlinkSync(real, link)
    writeFileSync(join(real, 'engrams.yaml'), 'engrams: []\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a live holder on another host is not stolen from past the stale threshold', async () => {
    const opts = { staleThreshold: 300, baseDelay: 20 }
    let inA = false
    let overlap = false
    const aEntered = new Promise<void>(entered => {
      void withAsyncLock(join(real, 'engrams.yaml'), async () => {
        inA = true
        host.name = 'host-B' // from here on, A's token reads as another host's
        entered()
        await sleep(900)
        inA = false
      }, opts)
    })
    await aEntered
    await withAsyncLock(join(link, 'engrams.yaml'), async () => {
      if (inA) overlap = true
    }, opts)
    expect(overlap).toBe(false)
  })

  it('async holder: the lock file stays fresh through a long hold', async () => {
    const file = join(real, 'engrams.yaml')
    await withAsyncLock(file, async () => {
      await sleep(450)
      expect(Date.now() - statSync(`${file}.lock`).mtimeMs).toBeLessThan(300)
    }, { staleThreshold: 300 })
  })

  it('async holder blocked synchronously (as git sync is): the touch points keep it fresh', async () => {
    const file = join(real, 'engrams.yaml')
    await withAsyncLock(file, async () => {
      spin(200); heartbeatHeldLocks(); spin(200)
      expect(Date.now() - statSync(`${file}.lock`).mtimeMs).toBeLessThan(300)
    }, { staleThreshold: 300 })
  })

  it('synchronous twin (sync.ts withLock): the touch points keep it fresh', () => {
    const file = join(real, 'engrams.yaml')
    withLock(file, () => {
      spin(200); heartbeatHeldLocks(); spin(200)
      expect(Date.now() - statSync(`${file}.lock`).mtimeMs).toBeLessThan(300)
    }, { staleThreshold: 300 })
  })

  it('the heartbeat stops on release and on throw', async () => {
    const file = join(real, 'engrams.yaml')
    const lock = `${file}.lock`
    await withAsyncLock(file, async () => { await sleep(10) }, { staleThreshold: 60 })
    await expect(withAsyncLock(file, async () => { throw new Error('boom') }, { staleThreshold: 60 }))
      .rejects.toThrow('boom')
    expect(() => withLock(file, () => { throw new Error('boom') }, { staleThreshold: 60 })).toThrow('boom')
    expect(activeHeartbeats()).toBe(0)
    expect(existsSync(lock)).toBe(false)
    // Nothing touches a lock file any more: a foreign file placed there keeps its old mtime.
    writeFileSync(lock, 'other-host:1:1:0')
    const old = new Date(Date.now() - 10_000)
    utimesSync(lock, old, old)
    await sleep(100)
    heartbeatHeldLocks()
    expect(Math.abs(statSync(lock).mtimeMs - old.getTime())).toBeLessThan(5)
  })

  it('never touches a lock it does not hold (token checked)', async () => {
    const file = join(real, 'engrams.yaml')
    const lock = `${file}.lock`
    await withAsyncLock(file, async () => {
      // Our lock was stolen and replaced by someone else's.
      writeFileSync(lock, 'other-host:1:1:0')
      const old = new Date(Date.now() - 10_000)
      utimesSync(lock, old, old)
      heartbeatHeldLocks()
      await sleep(60)
      expect(Math.abs(statSync(lock).mtimeMs - old.getTime())).toBeLessThan(5)
    }, { staleThreshold: 60 })
  })
})
