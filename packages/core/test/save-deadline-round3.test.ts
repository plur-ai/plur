/**
 * Re-audit of #1532 at c1b34a5c (findings R1, R2, R3, R6).
 *
 *   R1  updateEngram moves a local engram into a team scope ONLY when the twin
 *       probe positively answers "absent". A hang or a 401/403 is "cannot
 *       tell", and refuses.
 *   R2  Ids this machine has seen on a server are remembered in a bounded
 *       local set under the plur dir (not under cache/): team rows returned
 *       by recall, and ids the outbox delivered. After a 401, forget refuses
 *       for such an id even when the outbox id map is gone.
 *   R3  A `rescope --keep-local` history event is keyed by the LOCAL id and
 *       is not evidence that the local id names a server engram.
 *   R6  The scoped pin quota costs the row in the store the pin writes to
 *       (the first WRITABLE store for that scope).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Server } from 'http'
import type { Socket } from 'net'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TEAM = 'group:test'
const TOKEN = 'round3-token'

interface Counting { url: string; close: () => Promise<void> }
async function counting(mode: '401' | 'hang'): Promise<Counting> {
  const sockets = new Set<Socket>()
  const server: Server = createServer((_req, res) => {
    if (mode === '401') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"expired"}') }
  })
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address()
  if (!a || typeof a === 'string') throw new Error('no address')
  return { url: `http://127.0.0.1:${a.port}`, close: () => new Promise<void>(r => { for (const s of sockets) s.destroy(); server.close(() => r()) }) }
}

describe('#1532 re-audit round (core)', () => {
  let hang: Counting
  let unauth: Counting
  let stub: StubServer
  let stubUrl: string
  let other: StubServer
  let otherUrl: string
  let dir: string

  beforeAll(async () => {
    hang = await counting('hang')
    unauth = await counting('401')
    stub = new StubServer(TOKEN); stubUrl = (await stub.start()).url
    other = new StubServer(TOKEN); otherUrl = (await other.start()).url
  })
  afterAll(async () => { await hang.close(); await unauth.close(); await stub.stop(); await other.stop() })
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-round3-')); stub.reset(); other.reset() })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function config(stores: Array<{ url: string; scope: string; readonly?: boolean }>): void {
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n'
      + (stores.length ? 'stores:\n' + stores.map(s => `  - url: "${s.url}"\n    token: "${TOKEN}"\n    scope: "${s.scope}"\n${s.readonly ? '    readonly: true\n' : ''}`).join('') : ''))
  }
  async function open(): Promise<Plur> { const p = new Plur({ path: dir }); await p.ready(); return p }
  const yaml = (): string => readFileSync(join(dir, 'engrams.yaml'), 'utf8')
  async function local(statement: string): Promise<string> {
    config([])
    return (await (await open()).learn(statement, { scope: 'global' })).id
  }

  // --- R1 --------------------------------------------------------------------

  for (const [label, which] of [['hangs', 'hang'], ['answers 401', '401']] as const) {
    it(`R1: a scope move is refused when the twin probe ${label}`, async () => {
      const id = await local('local engram the update must not overwrite')
      config([{ url: which === 'hang' ? hang.url : unauth.url, scope: TEAM }])
      const p = await open()
      const row = (await p.getById(id))!
      await expect(p.updateEngram({ ...row, scope: TEAM, statement: 'team content with the same bare id' }))
        .rejects.toThrow(/could not be checked|could not be reached|rejected/)
      expect(yaml()).toContain('local engram the update must not overwrite')
      expect(yaml()).not.toContain('team content with the same bare id')
    }, 60_000)
  }

  // --- R2 --------------------------------------------------------------------

  it('R2: a team row returned by recall is remembered, and a later 401 forget of that id refuses', async () => {
    const id = await local('local engram whose id a team engram also has')
    stub.recallRows = [{ id, scope: TEAM, status: 'active', statement: 'unrelated team engram', score: 1 }]
    config([{ url: stubUrl, scope: TEAM }])
    const p = await open()
    const rows = await p.recall('unrelated team engram', { scope: TEAM, limit: 5 })
    expect(rows.some(r => (r as any)._originalId === id)).toBe(true)
    expect(existsSync(join(dir, 'seen-on-server.jsonl'))).toBe(true)
    config([{ url: unauth.url, scope: TEAM }])
    await expect((await open()).forget(id, 'test', { force: true })).rejects.toThrow(/--scope primary/)
    expect(yaml()).not.toMatch(/status: retired/)
  }, 60_000)

  it('R2: an id the outbox delivered stays evidence after the outbox id map is gone', async () => {
    const id = await local('local engram whose id the server later assigns to a queued row')
    // Queue a team save while the server is unreachable…
    config([{ url: hang.url, scope: TEAM }])
    const queued = await (await open()).learnRouted('queued team note', { scope: TEAM }, { remoteTimeoutMs: 300 })
    expect(queued.id).not.toBe(id)
    // …deliver it to a healthy server that numbers it with OUR local id…
    config([{ url: stubUrl, scope: TEAM }])
    stub.badAppendId = id
    const flushed = await (await open()).flushOutbox({ force: true })
    expect(flushed.flushed).toBe(1)
    stub.badAppendId = null
    // …and lose the id map (pruned past its cap, or deleted).
    rmSync(join(dir, 'cache', 'outbox-id-map.json'), { force: true })
    config([{ url: unauth.url, scope: TEAM }])
    await expect((await open()).forget(id, 'test', { force: true })).rejects.toThrow(/--scope primary/)
  }, 60_000)

  // --- R3 --------------------------------------------------------------------

  it('R3: rescope --keep-local does not make the LOCAL id look like a server id', async () => {
    const id = await local('local engram copied to the team, local kept')
    config([{ url: stubUrl, scope: TEAM }])
    const res = await (await open()).rescope(id, TEAM, { keep_local: true })
    expect(res.success).toBe(true)
    expect(res.results[0].new_id).not.toBe(id)
    config([{ url: unauth.url, scope: TEAM }])
    const out = await (await open()).forget(id, 'test', { force: true })
    expect(out.warnings.join(' ')).toMatch(/token/i)
    expect(yaml()).toMatch(/status: retired/)
  }, 60_000)

  // --- R6 --------------------------------------------------------------------

  it('R6: the scoped pin quota costs the row in the first WRITABLE store for that scope', async () => {
    const id = await local('short local')
    // A read-only store listed first holds a long row; the writable one a short row.
    other.seedEngram({ id, scope: TEAM, status: 'active', data: { statement: 'long read-only row '.repeat(60), type: 'behavioral' } })
    stub.seedEngram({ id, scope: TEAM, status: 'active', data: { statement: 'short writable row', type: 'behavioral' } })
    config([{ url: otherUrl, scope: TEAM, readonly: true }, { url: stubUrl, scope: TEAM }])
    const p = await open()
    const q = await p.pinnedQuota(id, { scope: TEAM })
    expect(q.candidate).toBeDefined()
    expect(q.candidate!.cost).toBeLessThan(40)
  }, 60_000)
})
