/**
 * Formal-verification gap closure, 2026-09-27 (round-2 drift review of
 * Persistence §4): `initSchema` repeated the pattern round 1 fixed in
 * `withExclusiveAccess` — unlock best-effort, then a bare `client.release()`.
 * If the unlock fails, the session goes back to the pool still holding the
 * init advisory lock, and every later `initSchema` waits on it forever.
 * The session must be destroyed instead. No database: a mock pool.
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
  return { idle, destroyed, async connect() { return idle.pop() ?? make() } }
}

function adapterWith(pool: ReturnType<typeof fakePool>): PostgresAdapter {
  const a = new PostgresAdapter({ connectionString: 'postgres://mock/none' })
  ;(a as any).pool = pool
  ;(a as any).initSchemaLocked = async () => {}
  return a
}

describe('initSchema advisory unlock failure', () => {
  it('a session whose init unlock failed is destroyed, never returned holding the lock', async () => {
    const pool = fakePool({ failUnlock: true })
    await (adapterWith(pool) as any).initSchema()
    expect(pool.idle.filter(c => c.locked > 0)).toEqual([])
    expect(pool.destroyed).toHaveLength(1)
  })

  it('control: a clean unlock returns the session to the pool', async () => {
    const pool = fakePool({ failUnlock: false })
    await (adapterWith(pool) as any).initSchema()
    expect(pool.idle).toHaveLength(1)
    expect(pool.idle[0].locked).toBe(0)
    expect(pool.destroyed).toEqual([])
  })
})
