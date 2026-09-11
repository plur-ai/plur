import { afterEach, describe, expect, it } from 'vitest'
import { PostgresAdapter } from '../src/storage-postgres.js'
import { EngramSchemaPassthrough } from '../src/schemas/engram.js'
import { Plur } from '../src/index.js'
import { ReadonlyStoreGuard } from '../src/store/readonly-store-guard.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.env.PLUR_TEST_POSTGRES_URL
const adapters: PostgresAdapter[] = []
const roots: string[] = []
let seq = 0
function pair() {
  const schema = `audit_lock_loss_${process.pid}_${seq++}`
  const make = () => new PostgresAdapter({ connectionString: url!, schema, vectorIndex: 'exact' })
  const a = make(), b = make(); adapters.push(a, b); return { a, b }
}
const row = (id: number) => EngramSchemaPassthrough.parse({ id: `ENG-AUDIT-${id}`, statement: `Preserve ${id}`, type: 'behavioral', scope: 'global', status: 'active' })
afterEach(async () => {
  for (const a of adapters.splice(0)) { await a.dropSchema(); await a.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!url)('Postgres ownership and transaction interruption', () => {
  it('does not recycle compacted IDs across clients with independent local state', async () => {
    const { a, b } = pair()
    const make = (store: PostgresAdapter) => {
      const path = mkdtempSync(join(tmpdir(), 'plur-pg-ids-')); roots.push(path)
      return new Plur({ path, store, autoDiscover: false })
    }
    const first = make(a), other = make(b)
    const removed = await first.learn('A PostgreSQL identity that must survive compaction', { scope: 'global' })
    await first.forget(removed.id, 'remove test row', { scope: 'primary', force: true })
    await first.compact()
    const next = await other.learn('A separate identity after removing the entire corpus', { scope: 'global' })
    expect(next.id).not.toBe(removed.id)
  }, 30000)

  it('reserves IDs atomically across sessions and refuses reservation through a readonly guard', async () => {
    const { a, b } = pair()
    const minimum = 'ENG-2026-09-08-001'
    const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).reserveEngramId(minimum)))
    expect(new Set(ids).size).toBe(20)
    await a.save([])
    expect(ids).not.toContain(await b.reserveEngramId(minimum))
    await expect(new ReadonlyStoreGuard(a).reserveEngramId!(minimum)).rejects.toThrow(/read.only/i)
  }, 30000)

  it('cannot overwrite another writer after losing the advisory-lock session', async () => {
    const { a, b } = pair(); await a.save([row(1)]); await b.load()
    let entered!: () => void, resume!: () => void
    const ready = new Promise<void>(r => { entered = r })
    const held = new Promise<void>(r => { resume = r })
    const first = a.withExclusiveAccess(async () => {
      const stale = await a.load(); entered(); await held
      await a.save(stale)
    }).then(() => null, error => error)
    await ready
    const ownedClient = [...(a as any).liveClients][0]
    const disconnected = new Promise<void>(r => ownedClient.once('error', () => r()))
    const admin = await (b as any).getPool()
    await admin.query('SELECT pg_terminate_backend($1)', [ownedClient.processID])
    await disconnected
    await b.withExclusiveAccess(async () => { await b.append(row(2)) })
    resume()
    const result = await first
    expect((await b.load()).map(e => e.id)).toEqual(['ENG-AUDIT-1', 'ENG-AUDIT-2'])
    expect(result).toBeInstanceOf(Error)
  }, 30000)

  it('rolls back earlier writes when a protected operation fails midway', async () => {
    const { a } = pair(); await a.save([row(1)])
    await expect(a.withExclusiveAccess(async () => {
      await a.append(row(2))
      throw new Error('injected failure after append')
    })).rejects.toThrow('injected failure after append')
    expect((await a.load()).map(e => e.id)).toEqual(['ENG-AUDIT-1'])
  }, 30000)

  it('does not acknowledge a transaction PostgreSQL rolled back after a caught query error', async () => {
    const { a } = pair(); await a.save([row(1)])
    await expect(a.withExclusiveAccess(async () => {
      await a.append(row(2))
      const connection = await (a as any).getPool()
      await connection.query('SELECT 1 / 0').catch(() => {})
    })).rejects.toThrow(/rolled back/)
    expect((await a.load()).map(e => e.id)).toEqual(['ENG-AUDIT-1'])
  }, 30000)

  it('launches background work only after successful commit', async () => {
    const { a, b } = pair(); await a.save([row(1)])
    let count = 0
    await expect(a.withExclusiveAccess(async () => {
      a.afterCommit(() => { count++ })
      await a.append(row(2))
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(count).toBe(0)
    let observed!: Promise<string[]>
    await a.withExclusiveAccess(async () => {
      await a.append(row(2))
      a.afterCommit(() => { observed = b.load().then(rows => rows.map(e => e.id)) })
    })
    expect(await observed).toEqual(['ENG-AUDIT-1', 'ENG-AUDIT-2'])
  }, 30000)

  it('refuses detached writes carrying an expired ownership context', async () => {
    const { a } = pair(); await a.save([row(1)])
    let resume!: () => void, detached!: Promise<unknown>
    const held = new Promise<void>(r => { resume = r })
    await a.withExclusiveAccess(async () => {
      detached = held.then(() => a.append(row(2))).then(() => null, error => error)
    })
    resume()
    expect(await detached).toBeInstanceOf(Error)
    expect((await a.load()).map(e => e.id)).toEqual(['ENG-AUDIT-1'])
  }, 30000)
})
