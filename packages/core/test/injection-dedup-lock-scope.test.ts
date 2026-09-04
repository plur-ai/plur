import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { hostname } from 'os'

/**
 * Review of #1017, O1: an `inject()` whose source never dedups never waits on
 * the dedup lock (invariant 2), and the hook path's wait is bounded.
 *
 * The lock was taken unconditionally while `dedupApplies` gated only the
 * check, so an MCP `inject` or `session_start` — sources that never dedup —
 * still contended for it and could spin the full retry budget (~8.2 s of
 * busy-wait at 12 retries) on an orphaned lock whose pid a live process had
 * since reused. The lock is a real file and the wait is a real busy-loop, so
 * this is pinned two ways: a spy on `withLock` proves the non-hook path never
 * calls it, and a wall-clock bound with a live foreign lock in place proves
 * the hook path gives up quickly and still records the injection.
 */

vi.mock('../src/sync.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/sync.js')>()
  return { ...mod, withLock: vi.fn(mod.withLock) }
})

import { withLock } from '../src/sync.js'
import { Plur } from '../src/index.js'

const month = () => new Date().toISOString().slice(0, 7)

function coInjectionCount(root: string): number {
  const file = path.join(root, 'history', `${month()}.jsonl`)
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.includes('"co_injection"')).length
}

function holdLockAsLiveProcess(root: string): string {
  const hd = path.join(root, 'history')
  fs.mkdirSync(hd, { recursive: true })
  const lock = path.join(hd, 'co-injection-dedup.lock')
  // Our own pid: holderIsAlive says "alive", so withLock never steals it.
  fs.writeFileSync(lock, `${hostname()}:${process.pid}:${Date.now()}:0`)
  return lock
}

describe('only hook-sourced injections touch the dedup lock (#1017 O1)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-lock-scope-'))
    vi.mocked(withLock).mockClear()
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  async function seeded(): Promise<Plur> {
    const plur = new Plur({ path: dir })
    await plur.learn('Prefer pnpm over npm for installs', { scope: 'global', domain: 'build.tools' })
    vi.mocked(withLock).mockClear() // learn() may take other locks; not under test
    return plur
  }

  const dedupLockCalls = () =>
    vi.mocked(withLock).mock.calls.filter(([p]) => String(p).endsWith(path.join('history', 'co-injection-dedup')))

  for (const source of ['inject', 'session_start', undefined] as const) {
    it(`source ${source ?? '(absent)'}: never calls withLock for the dedup section`, async () => {
      const plur = await seeded()
      holdLockAsLiveProcess(dir)
      const t0 = Date.now()
      const r = await plur.inject('prefer pnpm over npm', { source, session_id: 's1' })
      const ms = Date.now() - t0
      expect(r.count).toBeGreaterThan(0)
      expect(dedupLockCalls()).toEqual([])
      expect(coInjectionCount(dir), 'still recorded').toBe(1)
      // Belt and braces for the spy: the contended wait was ~8.2 s before the
      // fix and is 126 ms on the hook path after it; a non-hook call pays
      // neither.
      expect(ms).toBeLessThan(3_000)
    }, 30_000)
  }

  it('source hook: takes the dedup lock with a bounded budget', async () => {
    const plur = await seeded()
    await plur.inject('prefer pnpm over npm', { source: 'hook', session_id: 's1' })
    const calls = dedupLockCalls()
    expect(calls).toHaveLength(1)
    const opts = calls[0][2] as { maxRetries?: number; baseDelay?: number } | undefined
    const maxRetries = opts?.maxRetries ?? 5
    const baseDelay = opts?.baseDelay ?? 100
    // Σ baseDelay·2^i for the retries that sleep. 6 × 2 ms is 126 ms; the
    // budget under review summed to ~8.2 s. Pin the bound, not the numbers.
    let worstCaseWait = 0
    for (let i = 0; i < maxRetries; i++) worstCaseWait += baseDelay * 2 ** i
    expect(worstCaseWait).toBeLessThanOrEqual(200)
  })

  it('source hook with a live foreign lock: gives up within the budget and still records', async () => {
    const plur = await seeded()
    const lock = holdLockAsLiveProcess(dir)
    const t0 = Date.now()
    const r = await plur.inject('prefer pnpm over npm', { source: 'hook', session_id: 's1' })
    const ms = Date.now() - t0
    expect(r.count).toBeGreaterThan(0)
    expect(coInjectionCount(dir), 'written undeduped rather than dropped').toBe(1)
    expect(ms).toBeLessThan(3_000)
    // Never stolen from a live holder, never deleted on the way out.
    expect(fs.existsSync(lock)).toBe(true)
  }, 30_000)
})
