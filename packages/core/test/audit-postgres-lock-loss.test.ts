import { afterEach, describe, expect, it } from 'vitest'
import { PostgresAdapter } from '../src/storage-postgres.js'
import { EngramSchemaPassthrough } from '../src/schemas/engram.js'
import { Plur } from '../src/index.js'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

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

  it('starts a remote-scoped learn\'s background push only after the commit, so it can finish', async () => {
    const { a } = pair()
    const posts: unknown[] = []
    const server: Server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST') {
        posts.push(JSON.parse(Buffer.concat(chunks).toString()))
        return res.end(JSON.stringify({ id: 'ENG-2026-0928-901' }))
      }
      res.end(JSON.stringify({ rows: [], total_count: 0 }))
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const path = mkdtempSync(join(tmpdir(), 'plur-pg-outbox-')); roots.push(path)
      writeFileSync(join(path, 'config.yaml'), `stores:\n  - scope: "group:acme/eng"\n    url: "${url}"\n    token: "t"\n`)
      const plur = new Plur({ path, store: a, autoDiscover: false })
      const engram = await plur.learn('A team fact pushed once the local write has committed', { scope: 'group:acme/eng' })
      // The push succeeds, then removes the queued local copy under a fresh
      // protected operation. Started inside the learn's transaction, that
      // second operation inherited an ended session and failed, leaving the
      // row queued forever.
      let queued = true
      for (let i = 0; i < 60 && queued; i++) {
        await new Promise(r => setTimeout(r, 50))
        queued = (await a.load()).some(e => e.id === engram.id)
      }
      expect(posts).toHaveLength(1)
      expect(queued).toBe(false)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(r => server.close(() => r()))
    }
  }, 30000)

  it('drops post-commit work registered after the protected function failed', async () => {
    const { a } = pair(); await a.save([row(1)])
    let count = 0
    let resume!: () => void, registered!: Promise<void>
    const held = new Promise<void>(r => { resume = r })
    await expect(a.withExclusiveAccess(async () => {
      await a.append(row(2))
      // Detached: registers from inside the session, but only after the
      // operation has thrown and rolled back.
      registered = held.then(() => a.afterCommit(() => { count++ }))
      throw new Error('injected failure')
    })).rejects.toThrow('injected failure')
    resume(); await registered
    await new Promise(r => setTimeout(r, 50))
    expect(count).toBe(0)
    expect((await a.load()).map(e => e.id)).toEqual(['ENG-AUDIT-1'])
  }, 30000)

  it('still runs post-commit work registered after a confirmed commit', async () => {
    const { a } = pair()
    let count = 0
    let resume!: () => void, registered!: Promise<void>
    const held = new Promise<void>(r => { resume = r })
    await a.withExclusiveAccess(async () => {
      await a.append(row(1))
      registered = held.then(() => a.afterCommit(() => { count++ }))
    })
    resume(); await registered
    expect(count).toBe(1)
  }, 30000)

  it('writes a learn\'s provenance record only after the commit, outside the write session', async () => {
    const { a } = pair()
    const path = mkdtempSync(join(tmpdir(), 'plur-pg-provenance-')); roots.push(path)
    writeFileSync(join(path, 'config.yaml'), 'provenance:\n  generate: always\n', 'utf8')
    const plur = new Plur({ path, store: a, autoDiscover: false })
    let calls = 0
    let insideSession: boolean | undefined
    const original = plur.writeProvenance.bind(plur)
    ;(plur as any).writeProvenance = (...args: Parameters<typeof plur.writeProvenance>) => {
      calls++
      insideSession = (a as any).exclusiveSession.getStore() !== undefined
      return original(...args)
    }
    await plur.learn('Provenance is written after the transaction commits', { scope: 'global' })
    await new Promise(r => setTimeout(r, 100))
    expect(calls).toBe(1)
    expect(insideSession).toBe(false)
  }, 30000)

  // #1228 x #1252: a save() inside an exclusive operation joins the outer
  // transaction, so an id rename it makes is stored only if that commits.
  const rekeyedEvents = (root: string) => {
    const dir = join(root, 'history')
    if (!existsSync(dir)) return 0
    return readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
      .filter(line => line.includes('"engram_rekeyed"')).length
  }
  const clashingBatch = () => [row(1), { ...row(1), statement: 'A different engram that shares the id' }]

  it('reports no rename, and records no engram_rekeyed, when the operation that made it rolls back', async () => {
    const { a } = pair()
    const path = mkdtempSync(join(tmpdir(), 'plur-pg-rename-rollback-')); roots.push(path)
    new Plur({ path, store: a, autoDiscover: false })
    let heard = 0
    a.addRenameListener(() => { heard++ })
    await expect(a.withExclusiveAccess(async () => {
      await a.save(clashingBatch())
      throw new Error('injected failure after the renaming save')
    })).rejects.toThrow('injected failure')
    await new Promise(r => setTimeout(r, 50))
    expect(heard).toBe(0)
    expect(rekeyedEvents(path)).toBe(0)
    expect(await a.load()).toEqual([])
  }, 30000)

  it('control: the same rename is reported and recorded once the operation commits', async () => {
    const { a } = pair()
    const path = mkdtempSync(join(tmpdir(), 'plur-pg-rename-commit-')); roots.push(path)
    new Plur({ path, store: a, autoDiscover: false })
    let heard = 0
    a.addRenameListener(() => { heard++ })
    await a.withExclusiveAccess(async () => { await a.save(clashingBatch()) })
    await new Promise(r => setTimeout(r, 50))
    expect(heard).toBe(1)
    expect(rekeyedEvents(path)).toBe(1)
    expect(await a.load()).toHaveLength(2)
  }, 30000)
})
