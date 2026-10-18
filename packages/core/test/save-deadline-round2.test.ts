/**
 * Review round of #1532 (audit 2026-10-02, findings F1, F2, F3, F5, F6).
 *
 *   F1  A 401/403 from the collision probe only says THIS caller cannot see
 *       the remote row — not that there is none. When this machine has ever
 *       received or delivered that id from/to a server (local history, the
 *       outbox id map, cached remote rows), forget refuses and names
 *       `--scope primary`. With no such evidence it retires with a warning.
 *   F2  The remote walk for an id that is NOT local uses the same bounded
 *       per-store budget as the probe: two hanging stores cost seconds, not
 *       a minute.
 *   F3  learnRouted with no explicit deadline is still bounded well below the
 *       driver's 30 s, and falls through to the outbox.
 *   F5  updateEngram does not refuse a scope move into a team scope when no
 *       remote engram has that id.
 *   F6  pinnedQuota costs the engram the scope names, not the local row.
 *
 * Real HTTP on 127.0.0.1 only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Server } from 'http'
import type { Socket } from 'net'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TEAM = 'group:test'
const TEAM2 = 'group:test/two'
const TOKEN = 'round2-token'

interface Counting { url: string; requests: string[]; close: () => Promise<void> }
async function counting(mode: '401' | 'hang'): Promise<Counting> {
  const requests: string[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (mode === '401') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"error":"Invalid or expired token"}')
    }
  })
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address()
  if (!a || typeof a === 'string') throw new Error('no address')
  return {
    url: `http://127.0.0.1:${a.port}`, requests,
    close: () => new Promise<void>(r => { for (const s of sockets) s.destroy(); server.close(() => r()) }),
  }
}

describe('#1532 review round (core)', () => {
  let hang: Counting
  let unauth: Counting
  let stub: StubServer
  let stubUrl: string
  let dir: string

  beforeAll(async () => {
    hang = await counting('hang')
    unauth = await counting('401')
    stub = new StubServer(TOKEN)
    stubUrl = (await stub.start()).url
  })
  afterAll(async () => { await hang.close(); await unauth.close(); await stub.stop() })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-round2-'))
    stub.reset()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function config(stores: Array<{ url: string; scope: string }>, extra = ''): void {
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n' + extra
      + (stores.length ? 'stores:\n' + stores.map(s => `  - url: "${s.url}"\n    token: "${TOKEN}"\n    scope: "${s.scope}"\n`).join('') : ''))
  }
  async function open(): Promise<Plur> {
    const p = new Plur({ path: dir })
    await p.ready()
    return p
  }
  const yaml = (): string => readFileSync(join(dir, 'engrams.yaml'), 'utf8')

  /** A local engram, then a team save the server answered with the SAME bare id. */
  async function localAndReceivedTwin(): Promise<string> {
    config([])
    const id = (await (await open()).learn('local engram with a twin on the server', { scope: 'global' })).id
    config([{ url: stubUrl, scope: TEAM }])
    stub.badAppendId = id // the server mints its own ENG-<date>-NNN, colliding with ours
    const team = await (await open()).learnRouted('team engram the server numbered the same', { scope: TEAM })
    expect(team.id).toBe(id)
    stub.badAppendId = null
    return id
  }

  // --- F1 --------------------------------------------------------------------

  it('F1: forget refuses on a 401 when this machine received that id from a server', async () => {
    const id = await localAndReceivedTwin()
    config([{ url: unauth.url, scope: TEAM }])
    const p = await open()
    await expect(p.forget(id, 'test', { force: true })).rejects.toThrow(/--scope primary/)
    expect(yaml()).not.toMatch(/status: retired/)
    // The escape hatch still works.
    await p.forget(id, 'test', { force: true, scope: 'primary' })
    expect(yaml()).toMatch(/status: retired/)
  }, 60_000)

  it('F1: feedback refuses on a 401 when this machine received that id from a server', async () => {
    const id = await localAndReceivedTwin()
    config([{ url: unauth.url, scope: TEAM }])
    const p = await open()
    await expect(p.feedback(id, 'positive')).rejects.toThrow(/--scope primary/)
  }, 60_000)

  it('F1: forget refuses on a 401 when the outbox delivered a row under that server id', async () => {
    config([])
    const id = (await (await open()).learn('local engram whose id the outbox map names', { scope: 'global' })).id
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(join(dir, 'cache', 'outbox-id-map.json'),
      JSON.stringify({ 'ENG-2026-0101-999': { server_id: id, url: unauth.url, at: Date.now() } }))
    config([{ url: unauth.url, scope: TEAM }])
    const p = await open()
    await expect(p.forget(id, 'test', { force: true })).rejects.toThrow(/--scope primary/)
    expect(yaml()).not.toMatch(/status: retired/)
  }, 60_000)

  it('F1: with no sign the id was ever remote, a 401 still retires the local engram with a warning', async () => {
    config([])
    const id = (await (await open()).learn('purely local engram', { scope: 'global' })).id
    config([{ url: unauth.url, scope: TEAM }])
    const res = await (await open()).forget(id, 'test', { force: true })
    expect(res.warnings.join(' ')).toMatch(/token/i)
    expect(yaml()).toMatch(/status: retired/)
  }, 60_000)

  // --- F2 --------------------------------------------------------------------

  it('F2: forget of a non-local id against two hanging stores is bounded', async () => {
    config([{ url: hang.url, scope: TEAM }, { url: hang.url, scope: TEAM2 }])
    const p = await open()
    const t0 = Date.now()
    const err = await p.forget('ENG-2026-10-02-077', 'test', { force: true }).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(Date.now() - t0).toBeLessThan(16_000)
  }, 120_000)

  it('F2: feedback of a non-local id against two hanging stores is bounded', async () => {
    config([{ url: hang.url, scope: TEAM }, { url: hang.url, scope: TEAM2 }])
    const p = await open()
    const t0 = Date.now()
    await p.feedback('ENG-2026-10-02-077', 'positive').then(() => null, (e: Error) => e)
    expect(Date.now() - t0).toBeLessThan(16_000)
  }, 120_000)

  // --- F3 --------------------------------------------------------------------

  it('F3: learnRouted with no explicit deadline is bounded and falls through to the outbox', async () => {
    config([{ url: hang.url, scope: TEAM }])
    const p = await open()
    const t0 = Date.now()
    const e = await p.learnRouted('team note, caller passed no deadline', { scope: TEAM })
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(p.deliveryOf(e, TEAM).delivery).toBe('outbox')
  }, 60_000)

  // --- F5 --------------------------------------------------------------------

  it('F5: updateEngram moves a local engram into a team scope when no remote engram has its id', async () => {
    config([])
    const id = (await (await open()).learn('local engram moved by update', { scope: 'global' })).id
    config([{ url: stubUrl, scope: TEAM }])
    const p = await open()
    const row = (await p.getById(id))!
    await expect(p.updateEngram({ ...row, scope: TEAM })).resolves.toBe(true)
    expect(yaml()).toContain(`scope: ${TEAM}`)
  }, 60_000)

  it('F5: updateEngram still refuses when the server holds an engram with that id', async () => {
    config([])
    const id = (await (await open()).learn('local engram with a live twin', { scope: 'global' })).id
    stub.seedEngram({ id, scope: TEAM, status: 'active', data: { statement: 'live twin', type: 'behavioral' } })
    config([{ url: stubUrl, scope: TEAM }])
    const p = await open()
    const row = (await p.getById(id))!
    await expect(p.updateEngram({ ...row, scope: TEAM, statement: 'overwritten?' })).rejects.toThrow(/Ambiguous/)
    expect(yaml()).not.toContain('overwritten?')
  }, 60_000)

  // --- F6 --------------------------------------------------------------------

  it('F6: pinnedQuota with a scope costs the engram that scope holds', async () => {
    config([])
    const id = (await (await open()).learn('short local', { scope: 'global' })).id
    const long = 'a long remote statement '.repeat(40)
    stub.seedEngram({ id, scope: TEAM, status: 'active', data: { statement: long, type: 'behavioral' } })
    config([{ url: stubUrl, scope: TEAM }])
    const p = await open()
    const local = await p.pinnedQuota(id, { scope: 'primary' })
    const remote = await p.pinnedQuota(id, { scope: TEAM })
    expect(local.candidate).toBeDefined()
    expect(remote.candidate).toBeDefined()
    expect(remote.candidate!.cost).toBeGreaterThan(local.candidate!.cost * 5)
  }, 60_000)
})
