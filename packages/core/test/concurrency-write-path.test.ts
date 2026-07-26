/**
 * Concurrent write path (convergence Phase 2).
 *
 * `Plur`'s async write methods — learnRouted, feedback, forget,
 * updateEngramAsync, setPinnedAsync, learnAsync — used the SYNCHRONOUS
 * `withLock()`. That is safe only for as long as the locked body never yields,
 * and it has two costs that show up the moment more than one call is in flight:
 *
 *   1. the backoff is a `Date.now()` spin, so a contending caller blocks the
 *      whole event loop rather than just itself;
 *   2. `O_EXCL` + 5 retries is the ONLY queueing mechanism, so past a handful
 *      of concurrent writers the losers throw `Failed to acquire lock`.
 *
 * These tests fan out past that retry budget and assert what a deployment
 * serving concurrent sessions needs: every write lands, none is lost, none
 * throws.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import { withAsyncLock } from '../src/store/async-lock.js'

describe('Plur — concurrent writes', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-write-path-'))
    plur = new Plur({ path: dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists every engram from a 30-way concurrent learnRouted fan-out', async () => {
    // 30 > the lock's default 5 retries. Under the sync lock the losers would
    // throw rather than queue.
    const N = 30
    const engrams = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        plur.learnRouted(`concurrent write number ${i} uses convention ${i}`, { scope: 'global' }),
      ),
    )

    expect(new Set(engrams.map(e => e.id)).size).toBe(N)
    const stored = plur.list()
    for (const e of engrams) {
      expect(stored.find(s => s.id === e.id), `engram ${e.id} was lost`).toBeDefined()
    }
  })

  it('does not lose a feedback increment when signals race on one engram', async () => {
    const target = plur.learn('feedback races on a single engram', { scope: 'global' })

    const N = 20
    await Promise.all(Array.from({ length: N }, () => plur.feedback(target.id, 'positive')))

    const after = plur.getById(target.id)
    expect(after?.feedback_signals?.positive).toBe(N)
  })

  it('does not lose pin updates across concurrent setPinnedAsync calls', async () => {
    const ids = Array.from({ length: 12 }, (_, i) =>
      plur.learn(`pinnable engram number ${i}`, { scope: 'global' }).id,
    )

    await Promise.all(ids.map(id => plur.setPinnedAsync(id, true)))

    const pinned = plur.listPinned().map(e => e.id).sort()
    expect(pinned).toEqual([...ids].sort())
  })

  it('does not lose statement updates across concurrent updateEngramAsync calls', async () => {
    const engrams = Array.from({ length: 12 }, (_, i) =>
      plur.learn(`updatable engram number ${i}`, { scope: 'global' }),
    )

    await Promise.all(
      engrams.map(e => plur.updateEngramAsync({ ...e, statement: `${e.statement} — revised` })),
    )

    for (const e of engrams) {
      expect(plur.getById(e.id)?.statement).toBe(`${e.statement} — revised`)
    }
  })

  it('retires every engram in a concurrent forget fan-out', async () => {
    const ids = Array.from({ length: 15 }, (_, i) =>
      plur.learn(`forgettable engram number ${i}`, { scope: 'global' }).id,
    )

    await Promise.all(ids.map(id => plur.forget(id)))

    for (const id of ids) {
      expect(plur.getById(id)?.status, `engram ${id} not retired`).toBe('retired')
    }
  })

  /**
   * These two pin the behaviour that changed, and only that.
   *
   * A lock held across an `await` is the whole point of the async write path —
   * it is what a network- or Postgres-backed store does on every write. Under
   * the synchronous `withLock` a second writer meeting one spun on `Date.now()`
   * for its entire backoff, which starves every timer in the process AND
   * prevents the holder from finishing, so it burned ~3.1s of blocked loop and
   * then threw `Failed to acquire lock`. The converted paths queue instead.
   *
   * Scope note, deliberately narrow: `learnRouted`'s LOCAL route still delegates
   * to the synchronous `learn()`, and `learn()` still takes the synchronous
   * lock — so it still spins and still throws in this scenario. Flipping it is
   * the remaining half of Phase 2 (see ADR-0004); this change does not claim it.
   */
  it('feedback waits out a lock held across an await instead of spinning', async () => {
    const target = plur.learn('an engram whose feedback has to wait', { scope: 'global' })

    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 5)
    const holder = withAsyncLock(plur.paths.engrams, async () => {
      await new Promise(r => setTimeout(r, 60))
    })
    // Let the holder actually take the lock before the writer starts.
    await new Promise(r => setImmediate(r))

    const writer = plur.feedback(target.id, 'positive')
    await Promise.all([holder, writer])
    clearInterval(timer)

    expect(plur.getById(target.id)?.feedback_signals?.positive).toBe(1)
    expect(ticks, 'event loop was starved while waiting for the lock').toBeGreaterThan(0)
  })

  it('setPinnedAsync waits out a lock held across an await instead of spinning', async () => {
    const target = plur.learn('an engram whose pin has to wait', { scope: 'global' })

    const holder = withAsyncLock(plur.paths.engrams, async () => {
      await new Promise(r => setTimeout(r, 60))
    })
    await new Promise(r => setImmediate(r))

    const [, pinned] = await Promise.all([holder, plur.setPinnedAsync(target.id, true)])
    expect(pinned?.pinned).toBe(true)
    expect(plur.listPinned().map(e => e.id)).toEqual([target.id])
  })
})
