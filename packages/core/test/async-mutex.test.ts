/**
 * AsyncMutex ordering contract — closes #271 (iter-1 audit gap M-10,
 * Dijkstra F-DIJK-002).
 *
 * The mutex serializes writes inside the PGLite adapter. Its original body
 *
 *   const prev = this.queue
 *   this.queue = wait
 *   await prev
 *
 * was correct only via a non-obvious invariant (JS single-threadedness means
 * nothing interleaves between reading and writing `this.queue`), and read
 * backwards: `this.queue` pointed at `wait` before `prev` had resolved. #271
 * rewrites it to the idiomatic `this.queue = prev.then(() => wait)`, which
 * makes "the next caller queues after both prev AND this run" explicit.
 *
 * These tests lock in the behavioral contract the rewrite must preserve:
 * mutual exclusion, FIFO ordering, release-on-throw, and value/error
 * propagation.
 */
import { describe, it, expect } from 'vitest'
import { AsyncMutex } from '../src/storage-pglite.js'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('AsyncMutex (#271)', () => {
  it('serializes overlapping runs — no interleaving', async () => {
    const mutex = new AsyncMutex()
    const events: string[] = []
    const job = (name: string, ticks: number) =>
      mutex.run(async () => {
        events.push(`${name}:start`)
        for (let i = 0; i < ticks; i++) await tick()
        events.push(`${name}:end`)
      })
    // Start both before either can finish; b must not start until a ends.
    await Promise.all([job('a', 3), job('b', 1)])
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('runs callers in FIFO order, including one arriving mid-run', async () => {
    const mutex = new AsyncMutex()
    const order: number[] = []
    const first = mutex.run(async () => {
      order.push(1)
      // Third caller arrives while the first still holds the lock — it must
      // queue after BOTH the in-flight run and the already-queued second.
      void mutex.run(async () => { order.push(3) })
      await tick()
    })
    const second = mutex.run(async () => { order.push(2) })
    await Promise.all([first, second])
    await mutex.run(async () => { order.push(4) })
    expect(order).toEqual([1, 2, 3, 4])
  })

  it('releases the lock when fn throws — next caller still runs', async () => {
    const mutex = new AsyncMutex()
    await expect(mutex.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // A rejected run must not poison the queue.
    await expect(mutex.run(async () => 'after')).resolves.toBe('after')
  })

  it('propagates the return value of fn', async () => {
    const mutex = new AsyncMutex()
    await expect(mutex.run(async () => 42)).resolves.toBe(42)
  })

  it('rejection of one run does not reject queued runs', async () => {
    const mutex = new AsyncMutex()
    const results: string[] = []
    const failing = mutex.run(async () => { throw new Error('first fails') })
    const queued = mutex.run(async () => { results.push('second ran'); return 'ok' })
    await expect(failing).rejects.toThrow('first fails')
    await expect(queued).resolves.toBe('ok')
    expect(results).toEqual(['second ran'])
  })
})
