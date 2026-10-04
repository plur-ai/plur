/**
 * Formal-verification replay (spec/formal/findings/persistence.md, candidate 5):
 * a failed `pg_advisory_unlock` must not return the lock-holding session to the pool.
 *
 * Session advisory locks die with the SESSION, not the checkout. The finally's
 * comment said a failed unlock "discards" the connection, but `client.release()`
 * with no argument returns it to idle — still holding the lock — and every other
 * session's `pg_advisory_lock` (no timeout) then waits forever.
 *
 * PROTOCOL CHANGE (PR #1252, owner decision 2026-10-01): `withExclusiveAccess`
 * no longer takes a session lock and unlocks it. It runs the protected work in
 * ONE transaction holding `pg_advisory_xact_lock`, listens for connection
 * errors, and checks the COMMIT result. A transaction-scoped lock is released by
 * Postgres when the transaction ends (COMMIT, ROLLBACK, or the session dying),
 * so there is no unlock that can fail: the finding's guarantee now holds by
 * design. What this test still pins is the guarantee itself — after ANY failure
 * (lock acquisition error, COMMIT failure, a connection error mid-transaction)
 * no lock is left held and no session goes back to the pool in a bad state
 * (inside a transaction, or on a connection that reported an error).
 *
 * No database needed: the lock pool is a mock that models transaction and
 * transaction-scoped lock state.
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { PostgresAdapter } from '../src/storage-postgres.js'

interface FakeOpts {
  failLock?: boolean
  failCommit?: 'throw' | 'aborted'
  failRollback?: boolean
}

interface FakeClient extends EventEmitter {
  id: number
  inTx: boolean
  locked: number
  query: (sql: string) => Promise<{ rows: unknown[]; command?: string }>
  release: (err?: unknown) => void
}

function fakePool(opts: FakeOpts = {}) {
  const idle: FakeClient[] = []
  const destroyed: FakeClient[] = []
  let next = 0
  const make = (): FakeClient => {
    const c = new EventEmitter() as FakeClient
    c.id = next++
    c.inTx = false
    c.locked = 0
    c.query = async (sql: string) => {
      const s = sql.trim()
      if (s === 'BEGIN') { c.inTx = true; return { rows: [], command: 'BEGIN' } }
      if (s.includes('pg_advisory_xact_lock')) {
        if (opts.failLock) throw new Error('canceling statement due to lock timeout')
        c.locked++
        return { rows: [], command: 'SELECT' }
      }
      if (s === 'COMMIT') {
        if (opts.failCommit === 'throw') throw new Error('Connection terminated unexpectedly')
        // The transaction ends either way; an aborted one reports ROLLBACK.
        c.inTx = false
        c.locked = 0
        return { rows: [], command: opts.failCommit === 'aborted' ? 'ROLLBACK' : 'COMMIT' }
      }
      if (s === 'ROLLBACK') {
        if (opts.failRollback) throw new Error('Connection terminated unexpectedly')
        c.inTx = false
        c.locked = 0
        return { rows: [], command: 'ROLLBACK' }
      }
      return { rows: [] }
    }
    c.release = (err?: unknown) => {
      if (err) {
        // Destroying the session ends its transaction; Postgres drops its locks.
        c.inTx = false
        c.locked = 0
        destroyed.push(c)
      } else idle.push(c)
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

/** Nothing idle holds a lock or an open transaction; nothing anywhere holds a lock. */
function expectNoLockAndNoBadIdle(pool: ReturnType<typeof fakePool>) {
  expect(pool.idle.filter(c => c.locked > 0 || c.inTx)).toEqual([])
  expect([...pool.idle, ...pool.destroyed].filter(c => c.locked > 0)).toEqual([])
}

describe('formal-persistence: postgres advisory unlock failure', () => {
  it('a session whose lock could not be released is destroyed, never returned to the pool holding the lock', async () => {
    // Under the transaction-scoped protocol the lock is released by ending the
    // transaction. If even ROLLBACK fails, the session is in an unknown state:
    // it must be destroyed (which ends the transaction and drops the lock).
    const pool = fakePool({ failCommit: 'throw', failRollback: true })
    const a = adapterWith(pool)
    await expect(a.withExclusiveAccess(async () => 'ok')).rejects.toThrow(/terminated/)
    expectNoLockAndNoBadIdle(pool)
    expect(pool.idle).toEqual([])
    expect(pool.destroyed).toHaveLength(1)
  })

  it('a lock-acquisition error leaves no lock held and no open transaction in the pool', async () => {
    const pool = fakePool({ failLock: true })
    const a = adapterWith(pool)
    let ran = false
    await expect(a.withExclusiveAccess(async () => { ran = true })).rejects.toThrow(/lock timeout/)
    expect(ran).toBe(false)
    expectNoLockAndNoBadIdle(pool)
  })

  it('a COMMIT that reports an aborted transaction fails the operation and leaves no lock', async () => {
    const pool = fakePool({ failCommit: 'aborted' })
    const a = adapterWith(pool)
    await expect(a.withExclusiveAccess(async () => 'ok')).rejects.toThrow(/rolled back/)
    expectNoLockAndNoBadIdle(pool)
  })

  it('a connection error mid-transaction fails the operation and destroys the session', async () => {
    const pool = fakePool()
    const a = adapterWith(pool)
    await expect(a.withExclusiveAccess(async () => {
      const client = (a as any).exclusiveSession.getStore().client as FakeClient
      client.emit('error', new Error('socket hang up'))
      return 'ok'
    })).rejects.toThrow(/socket hang up/)
    expectNoLockAndNoBadIdle(pool)
    expect(pool.idle).toEqual([])
    expect(pool.destroyed).toHaveLength(1)
  })

  it('control: a clean run returns the session to the pool with the lock released', async () => {
    const pool = fakePool()
    const a = adapterWith(pool)
    await expect(a.withExclusiveAccess(async () => 'ok')).resolves.toBe('ok')
    expect(pool.idle).toHaveLength(1)
    expect(pool.idle[0].locked).toBe(0)
    expect(pool.idle[0].inTx).toBe(false)
    expect(pool.destroyed).toEqual([])
  })

  it('fn throwing still returns the session (lock released by ROLLBACK)', async () => {
    const pool = fakePool()
    const a = adapterWith(pool)
    await expect(a.withExclusiveAccess(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(pool.idle).toHaveLength(1)
    expect(pool.idle[0].locked).toBe(0)
    expect(pool.idle[0].inTx).toBe(false)
  })
})
