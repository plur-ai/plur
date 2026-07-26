/**
 * Concurrency contract of `withAsyncLock` (convergence Phase 2).
 *
 * The existing `async-lock.test.ts` covers the single-caller surface plus one
 * 5-way contention case with hand-tuned `{ maxRetries: 30, baseDelay: 5 }`.
 * That tuning is the tell: with only the O_EXCL file lock, in-process
 * contention is resolved by retry-with-backoff, so the DEFAULT options fail
 * under any real fan-out. These tests pin the behaviour the async write path
 * needs — with defaults, and against the failure modes the sync `withLock()`
 * has.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { withAsyncLock, activeLockCount } from '../src/store/async-lock.js'
import { withLock } from '../src/sync.js'

describe('withAsyncLock — in-process contention', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-lock-contention-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('serializes 25 concurrent callers with DEFAULT options and loses no update', async () => {
    // 25 > the default maxRetries of 5. A pure O_EXCL + backoff lock cannot
    // clear this: the 6th+ contender exhausts its retries and throws.
    const counterPath = join(dir, 'counter.txt')
    await writeFile(counterPath, '0')

    const N = 25
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        withAsyncLock(counterPath, async () => {
          const current = parseInt(await readFile(counterPath, 'utf8'), 10)
          // Yield inside the critical section. If the lock did not hold across
          // the await, two callers would read the same `current` and one
          // increment would be lost.
          await new Promise(r => setImmediate(r))
          const next = current + 1
          await writeFile(counterPath, String(next))
          return next
        }),
      ),
    )

    expect(await readFile(counterPath, 'utf8')).toBe(String(N))
    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1))
  })

  it('grants the lock in FIFO order', async () => {
    const p = join(dir, 'fifo.txt')
    const order: number[] = []
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withAsyncLock(p, async () => {
          order.push(i)
          await new Promise(r => setImmediate(r))
        }),
      ),
    )
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('does not block the event loop while waiting for the lock', async () => {
    // The sync withLock() busy-waits on Date.now(), so a contending caller
    // starves every timer in the process. The async lock must not.
    const p = join(dir, 'loop.txt')
    let timerFired = false
    const timer = setTimeout(() => { timerFired = true }, 5)

    const first = withAsyncLock(p, async () => {
      await new Promise(r => setTimeout(r, 60))
    })
    const second = withAsyncLock(p, async () => {
      // By the time the second caller runs, the 5ms timer must have fired —
      // proving the wait yielded to the event loop.
      expect(timerFired).toBe(true)
    })

    await Promise.all([first, second])
    clearTimeout(timer)
  })

  it('releases the in-process queue when a holder throws', async () => {
    const p = join(dir, 'throw.txt')
    await expect(
      withAsyncLock(p, async () => { throw new Error('boom') }),
    ).rejects.toThrow('boom')
    // A later caller must not inherit the failed holder's turn.
    await expect(withAsyncLock(p, async () => 'ok')).resolves.toBe('ok')
    expect(existsSync(p + '.lock')).toBe(false)
  })

  it('evicts idle queue entries so the map does not grow per path', async () => {
    const before = activeLockCount()
    for (let i = 0; i < 20; i++) {
      await withAsyncLock(join(dir, `f${i}.txt`), async () => i)
    }
    expect(activeLockCount()).toBe(before)
  })

  it('keys distinct paths independently — no false serialization', async () => {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    let bRanWhileAHeld = false
    const first = withAsyncLock(a, async () => {
      await new Promise(r => setTimeout(r, 40))
      // b must have completed during a's critical section
    })
    const second = withAsyncLock(b, async () => { bRanWhileAHeld = true })
    await Promise.all([first, second])
    expect(bRanWhileAHeld).toBe(true)
  })

  it('still excludes a foreign lock holder (cross-process guard intact)', async () => {
    const p = join(dir, 'foreign.txt')
    // Simulate another process holding the lock file.
    await writeFile(p + '.lock', '99999')
    await expect(
      withAsyncLock(p, async () => 'should not run', { maxRetries: 1, baseDelay: 5 }),
    ).rejects.toThrow(/lock/)
    rmSync(p + '.lock')
  })

  it('interoperates with the synchronous withLock on the same path', async () => {
    // Mixed sync/async callers must still be mutually exclusive — the file
    // lock is the shared mechanism.
    const p = join(dir, 'mixed.txt')
    await writeFile(p, '0')

    const asyncSide = withAsyncLock(p, async () => {
      const cur = parseInt(await readFile(p, 'utf8'), 10)
      await new Promise(r => setImmediate(r))
      await writeFile(p, String(cur + 1))
    })
    await asyncSide

    withLock(p, () => {
      const cur = parseInt(readFileSync(p, 'utf8'), 10)
      writeFileSync(p, String(cur + 1))
    })

    expect(await readFile(p, 'utf8')).toBe('2')
  })
})
