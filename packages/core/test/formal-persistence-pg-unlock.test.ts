/**
 * Formal-verification replay (spec/formal/findings/persistence.md, candidate 5):
 * a lock-holding session must never go back to the pool still holding the lock.
 *
 * The original finding was about a SESSION advisory lock: a failed
 * `pg_advisory_unlock` followed by a bare `client.release()` returned the
 * session to idle still holding the lock, and every other session's
 * `pg_advisory_lock` then waited forever.
 *
 * `withExclusiveAccess` now takes a TRANSACTION advisory lock
 * (`pg_advisory_xact_lock`, #1178 F16), which ends with COMMIT or ROLLBACK, so
 * there is no unlock call left to fail. The invariant is unchanged and is
 * replayed here against that mechanism: when neither COMMIT nor ROLLBACK
 * confirms the transaction ended, the session is destroyed (`release(err)`),
 * never returned to idle holding the lock.
 * No database needed: the lock pool is a mock that models transaction lock state.
 */
import { describe, it, expect } from 'vitest'
import { PostgresAdapter } from '../src/storage-postgres.js'

interface FakeClient {
  id: number; locked: number
  query: (sql: string) => Promise<unknown>
  release: (err?: unknown) => void
  on: (event: string, fn: unknown) => void
  removeListener: (event: string, fn: unknown) => void
}

function fakePool(opts: { failCommit?: boolean; failRollback?: boolean }) {
  const idle: FakeClient[] = []
  const destroyed: number[] = []
  let next = 0
  const make = (): FakeClient => {
    const c: FakeClient = {
      id: next++,
      locked: 0,
      async query(sql: string) {
        if (sql.startsWith('BEGIN')) return { command: 'BEGIN', rows: [] }
        if (sql.includes('pg_advisory_xact_lock')) { c.locked++; return { command: 'SELECT', rows: [] } }
        if (sql.startsWith('COMMIT')) {
          if (opts.failCommit) throw new Error('canceling statement due to statement timeout')
          c.locked = 0
          return { command: 'COMMIT', rows: [] }
        }
        if (sql.startsWith('ROLLBACK')) {
          if (opts.failRollback) throw new Error('connection lost')
          c.locked = 0
          return { command: 'ROLLBACK', rows: [] }
        }
        return { command: 'SELECT', rows: [] }
      },
      release(err?: unknown) {
        if (err) destroyed.push(c.id)
        else idle.push(c)
      },
      on() {},
      removeListener() {},
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

describe('formal-persistence: postgres exclusive-access lock cleanup', () => {
  it('a session whose transaction could not be ended is destroyed, never returned to the pool holding the lock', async () => {
    const pool = fakePool({ failCommit: true, failRollback: true })
    const a = adapterWith(pool)
    await expect(a.withExclusiveAccess(async () => 'ok')).rejects.toThrow()
    expect(pool.idle.filter(c => c.locked > 0)).toEqual([])
    expect(pool.destroyed).toHaveLength(1)
  })

  it('a failed COMMIT that ROLLBACK then ends returns a session that holds no lock', async () => {
    const pool = fakePool({ failCommit: true })
    const a = adapterWith(pool)
    await expect(a.withExclusiveAccess(async () => 'ok')).rejects.toThrow()
    expect(pool.idle.filter(c => c.locked > 0)).toEqual([])
  })

  it('control: a clean commit returns the session to the pool', async () => {
    const pool = fakePool({})
    const a = adapterWith(pool)
    await a.withExclusiveAccess(async () => 'ok')
    expect(pool.idle).toHaveLength(1)
    expect(pool.idle[0].locked).toBe(0)
    expect(pool.destroyed).toEqual([])
  })

  it('fn throwing and rollback succeeding still returns the session (lock released)', async () => {
    const pool = fakePool({})
    const a = adapterWith(pool)
    await expect(a.withExclusiveAccess(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(pool.idle).toHaveLength(1)
    expect(pool.idle[0].locked).toBe(0)
  })
})
