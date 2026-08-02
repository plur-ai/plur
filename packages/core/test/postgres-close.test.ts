/**
 * `close()` must always terminate, and must leave nothing open.
 *
 * Two independent races, both of which hung or leaked before:
 *
 * 1. `createPool` assigns `this.pool` only AFTER awaiting the driver import, so
 *    a `close()` in that window saw `null`, skipped teardown, and the pool that
 *    arrived a moment later was never ended — a live connection with nothing
 *    holding a reference to it.
 *
 * 2. `pool.end()` DRAINS: it waits for checked-out clients. `initSchema` holds
 *    one for its DDL and `withExclusiveAccess` holds one across arbitrary
 *    caller work, so draining could wait forever.
 *
 * The failed attempts are recorded in `close()`'s JSDoc because each failed in
 * a way worth remembering: drain-based teardowns deadlocked on held clients
 * (whichever promise they awaited first — an in-flight `createPool` transitively
 * awaits `initSchema` anyway), and destroying tracked clients STILL hung —
 * because a checkout that resolves after close() began was never in the
 * tracking set. That last one is why `acquire()` refuses once closed.
 *
 * These tests fail by TIMING OUT rather than asserting, which is the honest
 * shape: the bug is a hang.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { PostgresAdapter } from '../src/storage-postgres.js'

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL
const TIMEOUT = 30_000
let counter = 0
const freshSchema = () => `plur_close_${process.pid}_${counter++}`

/** The tracking set is private; reading it is the point of these assertions. */
const liveCount = (a: PostgresAdapter) =>
  ((a as unknown as { liveClients: Set<unknown> }).liveClients ?? new Set()).size
const poolOf = (a: PostgresAdapter) => (a as unknown as { pool: unknown }).pool

describe.skipIf(!PG_URL)('PostgresAdapter.close()', () => {
  let adapters: PostgresAdapter[] = []
  const track = (a: PostgresAdapter) => { adapters.push(a); return a }

  afterEach(async () => {
    await Promise.all(adapters.map(a => a.close().catch(() => { /* already closed */ })))
    adapters = []
  }, TIMEOUT)

  it('tears down a pool whose construction was still in flight', async () => {
    // The original leak: close() lands before `this.pool` is assigned.
    const a = track(new PostgresAdapter({ connectionString: PG_URL!, schema: freshSchema(), vectorIndex: 'exact' }))
    const inFlight = a.load().catch(() => { /* expected: closed underneath */ })
    await a.close()
    await inFlight

    expect(poolOf(a), 'a pool built after close() was left open').toBeNull()
    expect(liveCount(a), 'clients were still checked out after close()').toBe(0)
  }, TIMEOUT)

  it('returns instead of hanging when a client is held across caller work', async () => {
    // `withExclusiveAccess` holds a lockPool client for as long as `fn` runs.
    // A drain-based teardown waits for it; this must not.
    const a = track(new PostgresAdapter({ connectionString: PG_URL!, schema: freshSchema(), vectorIndex: 'exact' }))
    await a.load()

    let releaseHold: () => void = () => {}
    const held = new Promise<void>(r => { releaseHold = r })
    const exclusive = a.withExclusiveAccess!(async () => { await held })
      .catch(() => { /* the connection dies under it — expected */ })

    // Give the lock a moment to actually be taken.
    await new Promise(r => setTimeout(r, 250))
    await a.close()          // must resolve, not hang

    releaseHold()
    await exclusive
    expect(liveCount(a)).toBe(0)
  }, TIMEOUT)

  it('is idempotent', async () => {
    const a = track(new PostgresAdapter({ connectionString: PG_URL!, schema: freshSchema(), vectorIndex: 'exact' }))
    await a.load()
    await a.close()
    await a.close()
    expect(poolOf(a)).toBeNull()
  }, TIMEOUT)

  it('an ordinary open/close cycle still works — teardown must not be vacuous', async () => {
    // Guards against "close() does nothing" satisfying everything above: the
    // adapter has to be usable first.
    const schema = freshSchema()
    const a = track(new PostgresAdapter({ connectionString: PG_URL!, schema, vectorIndex: 'exact' }))
    await a.save([])
    const rows = await a.load()
    expect(Array.isArray(rows)).toBe(true)
    await a.close()
    expect(poolOf(a)).toBeNull()

    // And it really is closed: further use is refused rather than silently
    // reconnecting.
    await expect(a.load()).rejects.toThrow(/closed/i)
  }, TIMEOUT)
})
