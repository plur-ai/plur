/**
 * Formal-verification replay (spec/formal/findings/persistence.md, candidate 5):
 * a failed `pg_advisory_unlock` must not return the lock-holding session to the pool.
 *
 * Session advisory locks die with the SESSION, not the checkout. The finally's
 * comment said a failed unlock "discards" the connection, but `client.release()`
 * with no argument returns it to idle — still holding the lock — and every other
 * session's `pg_advisory_lock` (no timeout) then waits forever.
 * No database needed: the lock pool is a mock that models session lock state.
 */
import { describe, it, expect } from 'vitest'
import { PostgresAdapter } from '../src/storage-postgres.js'

interface FakeClient { id: number; locked: number; query: (sql: string) => Promise<unknown>; release: (err?: unknown) => void }

function fakePool(opts: { failUnlock: boolean }) {
  const idle: FakeClient[] = []
  const destroyed: number[] = []
  let next = 0
  const make = (): FakeClient => {
    const c: FakeClient = {
      id: next++,
      locked: 0,
      async query(sql: string) {
        if (sql.includes('pg_advisory_unlock')) {
          if (opts.failUnlock) throw new Error('canceling statement due to statement timeout')
          c.locked--
        } else if (sql.includes('pg_advisory_lock')) {
          c.locked++
        }
        return { rows: [] }
      },
      release(err?: unknown) {
        if (err) destroyed.push(c.id)
        else idle.push(c)
      },
    }
    return c
  }
  return {
    idle, destroyed,
    async connect() { return idle.pop() ?? make() },
  }
}

function adapterWith(pool: ReturnType<typeof fakePool>): PostgresAdapter {
  const a = new PostgresAdapter({ connectionString: 'postgres://mock/none' })
  ;(a as any).getLockPool = async () => pool
  return a
}

describe('formal-persistence: postgres advisory unlock failure', () => {
  it('a session whose unlock failed is destroyed, never returned to the pool holding the lock', async () => {
    const pool = fakePool({ failUnlock: true })
    const a = adapterWith(pool)
    await a.withExclusiveAccess(async () => 'ok')
    const stillLockedIdle = pool.idle.filter(c => c.locked > 0)
    expect(stillLockedIdle).toEqual([])
    expect(pool.destroyed).toHaveLength(1)
  })

  it('control: a clean unlock returns the session to the pool', async () => {
    const pool = fakePool({ failUnlock: false })
    const a = adapterWith(pool)
    await a.withExclusiveAccess(async () => 'ok')
    expect(pool.idle).toHaveLength(1)
    expect(pool.idle[0].locked).toBe(0)
    expect(pool.destroyed).toEqual([])
  })

  it('fn throwing and unlock succeeding still returns the session (lock released)', async () => {
    const pool = fakePool({ failUnlock: false })
    const a = adapterWith(pool)
    await expect(a.withExclusiveAccess(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(pool.idle).toHaveLength(1)
    expect(pool.idle[0].locked).toBe(0)
  })
})
