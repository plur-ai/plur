/**
 * Second re-audit of #1521 (owner, 2026-10-02).
 *
 *   R2-B1  the storage guard must keep the store lock: concurrent bound saves
 *          are all kept, and a bound write never deletes a personal row that
 *          another process saved in between
 *   R2-B2  a queued remote-only save can never be retired (tension resolve,
 *          a status update); the guard accepts a queue-marked row only while it
 *          is active and in a team scope it is queued for
 *   R2-S2  forget/feedback naming a personal url scope are refused in the folder
 *   R2-S4  an unscoped ingest goes to the folder's team scope
 *   R2-S5  a primaryStore handle taken before binding follows the binding
 *   R2-S1  (pending owner decision) daily backups and queued saves
 *
 * Real-HTTP stub; temp PLUR home and HOME only. The cross-process test runs
 * the built core (packages/core/dist) in a child process.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { pathToFileURL } from 'url'
import yaml from 'js-yaml'
import { Plur, RemoteOnlyWriteError } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'
import { backgroundPushesSettled } from './helpers/background-pushes.js'

const TOKEN = 'reaudit2-token'
const TEAM = 'group:acme/client'

let server: StubServer
let baseUrl: string
beforeAll(async () => { server = new StubServer(TOKEN); baseUrl = (await server.start()).url })
afterAll(async () => { await server.stop() })

let base: string, home: string, root: string, work: string, prevHome: string | undefined
function config(extraStores: unknown[] = []): void {
  writeFileSync(join(root, 'config.yaml'), yaml.dump({
    index: false, embeddings: { enabled: false },
    stores: [{ url: baseUrl, token: TOKEN, scope: TEAM, shared: true, readonly: false }, ...extraStores],
  }))
}
function map(): void {
  writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [{ path: work, plur: 'remote-only', scope: TEAM }] }))
}
function rows(): any[] {
  const f = join(root, 'engrams.yaml')
  if (!existsSync(f)) return []
  return ((yaml.load(readFileSync(f, 'utf8')) as { engrams?: any[] } | null)?.engrams) ?? []
}
const row = (id: string) => rows().find(r => r.id === id)
async function refused(fn: () => unknown): Promise<unknown> { try { await fn() } catch (e) { return e } return null }
function bound(): Plur { const p = new Plur({ path: root }); p.bindFolder(work); return p }

beforeEach(() => {
  server.reset()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-ro-r2-')))
  home = join(base, 'home'); root = join(home, '.plur'); work = join(home, 'client')
  mkdirSync(root, { recursive: true }); mkdirSync(work, { recursive: true })
  prevHome = process.env.HOME; process.env.HOME = home
  config(); map()
})
afterEach(async () => {
  await backgroundPushesSettled(root).catch(() => {})
  process.env.HOME = prevHome
  rmSync(base, { recursive: true, force: true })
})

describe('R2-B1: the guard keeps the store lock', () => {
  it('25 concurrent bound saves with the server down are all kept, with distinct ids', async () => {
    const plur = bound()
    server.appendErrorResponse = { status: 503, body: 'down' }
    const out = await Promise.all(Array.from({ length: 25 }, (_, i) => plur.learn(`concurrent client fact number ${i}`)))
    await backgroundPushesSettled(root)
    expect(new Set(out.map(e => e.id)).size).toBe(25)
    const queued = rows().filter(r => r.structured_data?._outbox?.remote_only)
    expect(queued.length).toBe(25)
  }, 120_000)

  it('a bound writer never deletes personal rows another process saves at the same time', async () => {
    const dist = resolve(__dirname, '../dist/index.js')
    expect(existsSync(dist), 'build core first').toBe(true)
    const script = `
      const { Plur } = await import(${JSON.stringify(pathToFileURL(dist).href)});
      const p = new Plur({ path: ${JSON.stringify(root)} });
      for (let i = 0; i < 15; i++) await p.learn('other process personal note ' + i, { scope: 'global' });
    `
    server.appendErrorResponse = { status: 503, body: 'down' }
    const child = new Promise<number>((res, rej) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: home } })
      let err = ''
      c.stderr.on('data', d => { err += String(d) })
      c.on('close', code => (code === 0 ? res(code) : rej(new Error(`child failed: ${err}`))))
    })
    const plur = bound()
    const mine = Promise.all(Array.from({ length: 15 }, async (_, i) => plur.learn(`bound client note ${i}`)))
    await Promise.all([child, mine])
    await backgroundPushesSettled(root)
    const all = rows()
    for (let i = 0; i < 15; i++) {
      expect(all.some(r => r.statement === `other process personal note ${i}`), `personal ${i}`).toBe(true)
      expect(all.some(r => r.statement === `bound client note ${i}`), `client ${i}`).toBe(true)
    }
  }, 180_000)
})

describe('R2-B2: a queued remote-only save is never retired', () => {
  async function queue(statement: string) {
    const plur = bound()
    server.appendErrorResponse = { status: 503, body: 'down' }
    const q = await plur.learnRouted(statement)
    await backgroundPushesSettled(root)
    server.appendErrorResponse = null
    return q
  }

  it('tension resolve against a personal winner is refused; the save is still delivered', async () => {
    const outside = new Plur({ path: root })
    const personal = await outside.learn('personal winner statement')
    const q = await queue('queued client loser statement')
    const rec = await outside.recordTensions([{ id_a: personal.id, id_b: q.id, statement_a: 'a', statement_b: 'b', confidence: 0.9, reason: 'x' }])
    expect(await refused(() => outside.resolveTension(rec.records[0].id, personal.id))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(row(q.id)?.status).toBe('active')
    const r = await new Plur({ path: root }).flushOutbox({ force: true })
    expect(r.flushed).toBe(1)
    expect(server.appendStatements).toContain('queued client loser statement')
    expect(rows().some(x => x.statement === 'queued client loser statement')).toBe(false)
  })

  it('an unbound status update to retired is refused; the save is still delivered', async () => {
    const q = await queue('queued client fact to retire')
    const unbound = new Plur({ path: root })
    expect(await refused(() => unbound.updateEngram({ ...row(q.id), status: 'retired' }))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(row(q.id)?.status).toBe('active')
    expect((await new Plur({ path: root }).flushOutbox({ force: true })).flushed).toBe(1)
  })

  it('the guard refuses a queue-marked row that is retired or in a personal scope', async () => {
    const q = await queue('queued client fact for the guard')
    const plur = bound()
    // The internal (guarded) store access. The public `primaryStore` handle is
    // the store as passed in and is not guarded (re-audit 3, R3-1, owner
    // decision 2026-10-02).
    const ps = (plur as any)._primaryStore
    const current = row(q.id)
    expect(await refused(() => ps.save([{ ...current, status: 'retired' }]))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(await refused(() => ps.save([current, { ...current, id: 'ENG-2026-10-02-900', scope: 'global' }]))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(row(q.id)?.status).toBe('active')
    expect(rows().some(r => r.id === 'ENG-2026-10-02-900')).toBe(false)
  })
})

describe('R2-S2: a personal url scope is refused from the folder', () => {
  it('forget and feedback naming user:me do not reach the personal remote', async () => {
    config([{ url: baseUrl, token: TOKEN, scope: 'user:me', readonly: false }])
    server.seedEngram({ id: 'ENG-2026-10-02-010', scope: 'user:me', status: 'active', data: { statement: 'my personal remote note' } })
    const plur = bound()
    expect(await refused(() => plur.feedback('ENG-2026-10-02-010', 'negative', 'user:me'))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(await refused(() => plur.forget('ENG-2026-10-02-010', 'x', { scope: 'user:me' }))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(server.getEngram('ENG-2026-10-02-010')?.status).toBe('active')
  })
})

describe('R2-S4: an unscoped ingest goes to the folder scope', () => {
  it('extracted candidates are saved to the team scope, not refused as global', async () => {
    const plur = bound()
    const out = await plur.ingest('Always run the team integration checks before merging.')
    expect(out.length).toBeGreaterThan(0)
    await backgroundPushesSettled(root)
    expect(server.appendStatements.some(s => /integration checks/i.test(s))).toBe(true)
  })
})

describe('R2-S5 (revised by re-audit 3, R3-1): the primaryStore handle', () => {
  // Owner decision 2026-10-02: `primaryStore` is the store as passed in, by
  // identity, and is not guarded; PLUR's own paths use the guarded internal
  // access. What remains to check: the internal access follows the binding
  // whenever it is taken, and the public handle keeps its identity.
  it('keeps identity across binding, while internal access is guarded from the moment of binding', async () => {
    const plur = new Plur({ path: root })
    await plur.learn('personal handle note PERSONALHANDLE', { scope: 'global' })
    const ps = plur.primaryStore
    plur.bindFolder(work)
    expect(plur.primaryStore).toBe(ps)
    expect(JSON.stringify(await (plur as any)._primaryStore.load())).not.toContain('PERSONALHANDLE')
    expect(rows().some(r => r.statement === 'personal handle note PERSONALHANDLE')).toBe(true)
  })
})

describe('R2-S1: daily backups (owner decision pending)', () => {
  // Pending the owner's decision between excluding queued remote-only rows
  // from the daily snapshot and disclosing that they are kept there. Enable
  // this test with the exclusion, if that is the decision.
  it.skip('a delivered remote-only save leaves no copy in backups/', async () => {
    const plur = bound()
    server.appendErrorResponse = { status: 503, body: 'down' }
    await plur.learnRouted('client save that must not be backed up')
    await backgroundPushesSettled(root)
    server.appendErrorResponse = null
    await new Plur({ path: root }).flushOutbox({ force: true })
    const dir = join(root, 'backups')
    const text = existsSync(dir) ? readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')).join('\n') : ''
    expect(text).not.toContain('client save that must not be backed up')
  })
})
