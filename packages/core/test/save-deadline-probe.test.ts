/**
 * Core half of the 0.21.1 save-deadline fix (investigation 2026-10-02).
 *
 *   - learnRouted takes a bounded remote-write deadline; a timeout falls
 *     through to the existing outbox instead of waiting 30 s (item 2a).
 *   - deliveryOf says WHY an engram was queued: a rejected token or an
 *     unreachable server (item 4).
 *   - forget and feedback probe remotes for an id collision BEFORE taking the
 *     store lock, each probe bounded; a 401/403 is "this caller cannot act
 *     there either", so the local row is retired / rated with a warning; a
 *     hanging remote refuses forget quickly, naming `--scope primary` (item 3).
 *   - setPinned and updateEngram refuse a bare id that is ambiguous between
 *     the local store and a remote (item 6) instead of changing the local row.
 *
 * Real HTTP on 127.0.0.1 only: a server that never answers, one that answers
 * 401 to everything, and the StubServer for a healthy remote.
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
const TOKEN = 'probe-token'

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

describe('save deadline and remote probes (core)', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'plur-save-probe-'))
    stub.reset()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function config(url: string | null): void {
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n'
      + (url ? `stores:\n  - url: "${url}"\n    token: "${TOKEN}"\n    scope: "${TEAM}"\n` : ''))
  }
  async function open(): Promise<Plur> {
    const p = new Plur({ path: dir })
    await p.ready()
    return p
  }
  async function localEngram(statement: string): Promise<string> {
    config(null)
    const p = await open()
    return (await p.learn(statement, { scope: 'global' })).id
  }
  const yaml = (): string => readFileSync(join(dir, 'engrams.yaml'), 'utf8')

  // --- learnRouted deadline -------------------------------------------------

  it('learnRouted: a hanging server is cut at the caller deadline and the save is queued', async () => {
    config(hang.url)
    const p = await open()
    const t0 = Date.now()
    const e = await p.learnRouted('note while the server hangs', { scope: TEAM }, { remoteTimeoutMs: 1500 })
    expect(Date.now() - t0).toBeLessThan(10_000)
    const d = p.deliveryOf(e, TEAM)
    expect(d.delivery).toBe('outbox')
    expect(d.reason_code).toBe('unreachable')
    expect(d.reason).toMatch(/unreachable/i)
    expect(yaml()).toContain('note while the server hangs')
    expect(existsSync(join(dir, 'engrams.yaml.lock'))).toBe(false)
  }, 60_000)

  it('deliveryOf: a 401 is reported as a rejected token, with the command to check it', async () => {
    config(unauth.url)
    const p = await open()
    const e = await p.learnRouted('note with an expired token', { scope: TEAM })
    const d = p.deliveryOf(e, TEAM)
    expect(d.delivery).toBe('outbox')
    expect(d.reason_code).toBe('auth_rejected')
    expect(d.reason).toMatch(/token/i)
    expect(d.reason).toContain('plur login')
  }, 60_000)

  // --- forget / feedback probes ----------------------------------------------

  it('forget: a 401 remote does not block retiring a local engram; it warns naming the store', async () => {
    const id = await localEngram('local row, remote says 401')
    config(unauth.url)
    const p = await open()
    const res = await p.forget(id, 'test', { force: true })
    expect(res?.warnings?.join(' ')).toMatch(/token/i)
    expect(res?.warnings?.join(' ')).toContain(TEAM)
    expect(yaml()).toMatch(/status: retired/)
  }, 60_000)

  it('forget: a hanging remote refuses quickly, names --scope primary, and never holds the lock while probing', async () => {
    const id = await localEngram('local row, remote hangs')
    config(hang.url)
    const p = await open()
    const t0 = Date.now()
    const pending = p.forget(id, 'test', { force: true }).then(() => null, (e: Error) => e)
    await new Promise(r => setTimeout(r, 500))
    // Another writer gets the lock while the probe waits.
    const other = await open()
    const s0 = Date.now()
    await other.learn('a concurrent local save', { scope: 'global' })
    const otherMs = Date.now() - s0
    const err = await pending
    const forgetMs = Date.now() - t0
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('--scope primary')
    expect(forgetMs).toBeLessThan(15_000)
    expect(otherMs).toBeLessThan(forgetMs)
    expect(yaml()).not.toMatch(/status: retired/)
  }, 60_000)

  it('feedback: a 401 remote rates the local engram and warns about the token (same rule as forget)', async () => {
    const id = await localEngram('local row rated past a 401')
    config(unauth.url)
    const p = await open()
    const res = await p.feedback(id, 'positive')
    expect(res?.warnings?.join(' ')).toMatch(/token/i)
  }, 60_000)

  it('feedback: a hanging remote is bounded and rates locally with a warning', async () => {
    const id = await localEngram('local row rated past a hang')
    config(hang.url)
    const p = await open()
    const t0 = Date.now()
    const res = await p.feedback(id, 'positive')
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(res?.warnings?.join(' ')).toMatch(/could not be reached|unreachable|timed out/i)
  }, 60_000)

  // --- pin / update ambiguity -------------------------------------------------

  it('setPinned: an ambiguous bare id is refused, the local row is untouched, and scope "primary" pins it', async () => {
    const id = await localEngram('local row that collides with a team row')
    stub.seedEngram({ id, scope: TEAM, status: 'active', data: { statement: 'unrelated team row', type: 'behavioral' } })
    config(stubUrl)
    const p = await open()
    await expect(p.setPinned(id, true)).rejects.toThrow(/Ambiguous/)
    expect(yaml()).not.toMatch(/pinned: true/)
    expect(stub.getEngram(id)?.data.pinned).toBeUndefined()
    const pinned = await p.setPinned(id, true, { scope: 'primary' })
    expect(pinned?.statement).toBe('local row that collides with a team row')
    expect(yaml()).toMatch(/pinned: true/)
  }, 60_000)

  it('updateEngram: a team row whose bare id collides with a local row is refused, not written over the local one', async () => {
    const id = await localEngram('local row an update must not overwrite')
    config(stubUrl)
    const p = await open()
    const local = (await p.getById(id))!
    const teamRow = { ...local, scope: TEAM, statement: 'team content with the same bare id' }
    await expect(p.updateEngram(teamRow)).rejects.toThrow(/Ambiguous/)
    expect(yaml()).toContain('local row an update must not overwrite')
    expect(yaml()).not.toContain('team content with the same bare id')
  }, 60_000)
})
