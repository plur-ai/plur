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

/**
 * The key `Plur` locks on for a write. It is the primary store's `location` —
 * the interface documents that field as serving exactly this purpose while
 * locking is path-based — so the test can name the same lock the engine takes
 * without reaching into `Plur`'s private `paths`.
 */
function lockKey(p: Plur): string {
  const loc = p.primaryStore.location
  if (loc === null) throw new Error('this test needs a store with a filesystem location')
  return loc
}

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
    const stored = await plur.list()
    for (const e of engrams) {
      expect(stored.find(s => s.id === e.id), `engram ${e.id} was lost`).toBeDefined()
    }
  })

  it('does not lose a feedback increment when signals race on one engram', async () => {
    const target = await plur.learn('feedback races on a single engram', { scope: 'global' })

    const N = 20
    await Promise.all(Array.from({ length: N }, () => plur.feedback(target.id, 'positive')))

    const after = await plur.getById(target.id)
    expect(after?.feedback_signals?.positive).toBe(N)
  })

  it('does not lose pin updates across concurrent setPinnedAsync calls', async () => {
    // learn() is async now — the array must settle before its ids exist.
    const ids = (await Promise.all(Array.from({ length: 12 }, (_, i) =>
      plur.learn(`pinnable engram number ${i}`, { scope: 'global' }),
    ))).map(e => e.id)

    await Promise.all(ids.map(id => plur.setPinnedAsync(id, true)))

    const pinned = (await plur.listPinned()).map(e => e.id).sort()
    expect(pinned).toEqual([...ids].sort())
  })

  it('does not lose statement updates across concurrent updateEngramAsync calls', async () => {
    const engrams = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      plur.learn(`updatable engram number ${i}`, { scope: 'global' }),
    ))

    await Promise.all(
      engrams.map(e => plur.updateEngramAsync({ ...e, statement: `${e.statement} — revised` })),
    )

    for (const e of engrams) {
      expect((await plur.getById(e.id))?.statement).toBe(`${e.statement} — revised`)
    }
  })

  it('retires every engram in a concurrent forget fan-out', async () => {
    const ids = (await Promise.all(Array.from({ length: 15 }, (_, i) =>
      plur.learn(`forgettable engram number ${i}`, { scope: 'global' }),
    ))).map(e => e.id)

    await Promise.all(ids.map(id => plur.forget(id)))

    for (const id of ids) {
      expect((await plur.getById(id))?.status, `engram ${id} not retired`).toBe('retired')
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
    const target = await plur.learn('an engram whose feedback has to wait', { scope: 'global' })

    const HOLD_MS = 200
    const TICK_MS = 10
    // A starved event loop CANNOT reach this. Node coalesces a blocked
    // `setInterval` into a SINGLE callback fired the moment the loop is
    // released, so a spin-waiting writer scores exactly 1 tick no matter how
    // long it blocked — which is why `toBeGreaterThan(0)` proved nothing here.
    // A loop that keeps turning fires ~HOLD_MS / TICK_MS times; half of that
    // is the bar.
    const MIN_TICKS = HOLD_MS / TICK_MS / 2

    const events: string[] = []
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, TICK_MS)

    let ticksDuringHold = -1
    let holderEntered!: () => void
    const holding = new Promise<void>(r => { holderEntered = r })
    const holder = withAsyncLock(lockKey(plur), async () => {
      events.push('holder:enter')
      const at = ticks
      holderEntered()
      await new Promise(r => setTimeout(r, HOLD_MS))
      ticksDuringHold = ticks - at
      events.push('holder:release')
    })

    // The writer starts only once the lock is genuinely HELD, and is not
    // awaited here — so it has to contend for real. (Awaiting it to completion
    // before assembling a `Promise.all`, as this used to, cannot tell "queued
    // behind the holder" from "never touched the lock at all".)
    await holding
    const writer = plur.feedback(target.id, 'positive').then(() => { events.push('feedback:done') })

    const settled = await Promise.allSettled([holder, writer])
    clearInterval(timer)

    // Checked first, because a spinning writer ALSO exhausts its retries and
    // throws — and that rejection would otherwise mask the actual diagnosis.
    expect(
      ticksDuringHold,
      `event loop was starved while the writer waited: ${ticksDuringHold} ticks of ~${HOLD_MS / TICK_MS} in ${HOLD_MS}ms`,
    ).toBeGreaterThanOrEqual(MIN_TICKS)
    for (const r of settled) {
      expect(r.status, r.status === 'rejected' ? String(r.reason) : 'settled').toBe('fulfilled')
    }
    // Queued, not skipped: the write landed only after the holder let go.
    expect(events).toEqual(['holder:enter', 'holder:release', 'feedback:done'])
    expect((await plur.getById(target.id))?.feedback_signals?.positive).toBe(1)
  })

  it('setPinnedAsync waits out a lock held across an await instead of spinning', async () => {
    const target = await plur.learn('an engram whose pin has to wait', { scope: 'global' })

    const events: string[] = []
    let holderEntered!: () => void
    const holding = new Promise<void>(r => { holderEntered = r })
    const holder = withAsyncLock(lockKey(plur), async () => {
      events.push('holder:enter')
      holderEntered()
      await new Promise(r => setTimeout(r, 60))
      events.push('holder:release')
    })
    // Same shape as above: contend against a lock that is already held, and
    // let the ordering — not mere completion — be the evidence.
    await holding

    const writer = plur.setPinnedAsync(target.id, true).then(r => { events.push('pin:done'); return r })
    const [, pinned] = await Promise.all([holder, writer])

    expect(events).toEqual(['holder:enter', 'holder:release', 'pin:done'])
    expect(pinned?.pinned).toBe(true)
    expect((await plur.listPinned()).map(e => e.id)).toEqual([target.id])
  })
})
