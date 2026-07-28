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
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'fs'
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
    // "b ran" is NOT the property — b runs eventually even under total
    // serialization. The property is OVERLAP: b must run to completion while a
    // is still inside its critical section. Only an ordering trace can tell
    // those apart, so record one.
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    const events: string[] = []
    const first = withAsyncLock(a, async () => {
      events.push('a:enter')
      await new Promise(r => setTimeout(r, 60))
      events.push('a:exit')
    })
    const second = withAsyncLock(b, async () => {
      events.push('b:enter')
      await new Promise(r => setTimeout(r, 10))
      events.push('b:exit')
    })
    await Promise.all([first, second])

    const aEnter = events.indexOf('a:enter')
    const aExit = events.indexOf('a:exit')
    const bExit = events.indexOf('b:exit')
    expect(aEnter, 'a never entered its critical section').toBeGreaterThanOrEqual(0)
    expect(bExit, 'b never finished').toBeGreaterThanOrEqual(0)
    // aEnter < bExit < aExit — b finished strictly INSIDE a's critical section.
    // Serialized on a single key this reads a:enter,a:exit,b:enter,b:exit (or
    // the b-first mirror), and one of these two bounds breaks either way.
    expect(aEnter, `b finished before a started — ${events.join(',')}`).toBeLessThan(bExit)
    expect(bExit, `b was serialized behind a — ${events.join(',')}`).toBeLessThan(aExit)
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

  it('excludes the synchronous withLock while an async holder is inside its critical section', async () => {
    // Mixed sync/async callers must be mutually exclusive — the O_EXCL file
    // lock is the shared mechanism, and it is the ONLY one they share (the
    // in-process queue is async-side only). So the contention has to happen
    // for real: the sync caller attempts entry WHILE the async holder is
    // inside, not politely after it has finished.
    //
    // `withLock` cannot wait this out — its backoff is a `Date.now()` spin,
    // which would block the very loop the async holder needs to finish. So
    // exclusion here means it throws rather than entering, and 1 retry keeps
    // the spin to ~1ms.
    const p = join(dir, 'mixed.txt')
    await writeFile(p, '0')

    let syncEntered = false
    let syncExcluded = false
    const asyncSide = withAsyncLock(p, async () => {
      try {
        withLock(p, () => {
          syncEntered = true
          writeFileSync(p, 'trampled')
        }, { maxRetries: 1, baseDelay: 1 })
      } catch {
        syncExcluded = true
      }
      const cur = parseInt(await readFile(p, 'utf8'), 10)
      await new Promise(r => setImmediate(r))
      await writeFile(p, String(cur + 1))
    })
    await asyncSide

    expect(syncEntered, 'sync withLock walked into a held async critical section').toBe(false)
    expect(syncExcluded, 'sync withLock was never actually excluded').toBe(true)

    // ...and once the async holder released, the sync side gets its turn on
    // the same path — exclusion, not permanent lockout.
    withLock(p, () => {
      const cur = parseInt(readFileSync(p, 'utf8'), 10)
      writeFileSync(p, String(cur + 1))
    })

    expect(await readFile(p, 'utf8')).toBe('2')
  })
})

describe('a failed acquisition never runs the critical section', () => {
  // The loop used to be able to RUN OUT rather than throw: the stale-cleanup
  // and stat-failure branches skip the `attempt === maxRetries` check, so if
  // either fell on the last iteration the loop exited normally, `fn()` ran with
  // NO lock, and the `finally` unlinked the file belonging to whoever did hold
  // it. Two processes in the critical section at once, and the real holder
  // silently loses its lock.
  it('throws instead of running unlocked when the lock is held throughout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-lock-fail-'))
    const target = join(dir, 'engrams.yaml')
    try {
      // A held lock, freshly stamped so it never looks stale.
      writeFileSync(target + '.lock', '99999')
      let ran = false
      await expect(
        withAsyncLock(target, async () => { ran = true }, { maxRetries: 1, baseDelay: 1, staleThreshold: 60_000 }),
      ).rejects.toThrow(/Failed to acquire lock/)
      expect(ran, 'the critical section ran without the lock').toBe(false)
      // And the holder's file is still there.
      expect(existsSync(target + '.lock'), "the holder's lock file was deleted").toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when the retry budget is spent by a stale-lock cleanup', async () => {
    // THE case the guard exists for, and the one the test above does NOT reach.
    //
    // With a fresh lock the loop hits `attempt === maxRetries` and throws on its
    // own — so that test passes with or without the guard (verified by
    // mutation). The hole is the `continue` branches, which skip that check: a
    // stale-lock cleanup on the FINAL attempt ends the loop normally. Before the
    // guard, execution simply fell through and ran the critical section having
    // never acquired anything.
    //
    // `maxRetries: 0` makes the first attempt the final one, so the stale branch
    // lands exactly there.
    const dir = mkdtempSync(join(tmpdir(), 'plur-lock-stale-'))
    const target = join(dir, 'engrams.yaml')
    try {
      writeFileSync(target + '.lock', '99999')
      // Backdate it well past the threshold so the stale branch is taken.
      const old = new Date(Date.now() - 120_000)
      utimesSync(target + '.lock', old, old)

      let ran = false
      await expect(
        withAsyncLock(target, async () => { ran = true }, { maxRetries: 0, baseDelay: 1, staleThreshold: 1_000 }),
      ).rejects.toThrow(/Failed to acquire lock/)
      expect(ran, 'ran the critical section without ever acquiring the lock').toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still acquires normally when the lock is free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-lock-ok-'))
    const target = join(dir, 'engrams.yaml')
    try {
      let ran = false
      await withAsyncLock(target, async () => { ran = true })
      expect(ran).toBe(true)
      expect(existsSync(target + '.lock'), 'the lock file was left behind').toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
