/**
 * Security audit 2026-11-06: moving a still-queued team write to another
 * team scope (updateEngram, decision D4) kept the queued write's
 * idempotency key. When an earlier attempt for the OLD scope had already
 * reached the server (answer lost, or the update landed while learn()'s
 * background push was on the wire), a key-honouring server answered the
 * new-scope POST with the old copy's id (`deduplicated: true`). The flush
 * took that as delivery and dropped the local row: the memory stayed only in
 * the old scope, or, after the old copy was retired, existed nowhere.
 *
 * Fixes under test:
 *  - a retarget mints a fresh idempotency key;
 *  - a `deduplicated` reply naming a server id this client is retiring is
 *    never taken as delivery (the row stays local and queued).
 *
 * In-process `globalThis.fetch` stub only — no sockets, dummy data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const URL_ = 'https://team.example.invalid/sse'
const A = 'group:acme/all'
const B = 'group:acme/leads'
type Row = { id: string; scope: string; key: string | null; statement: string; deleted: boolean }

/** A server that deduplicates by Idempotency-Key per token, as the remote-store contract requires. */
function mkServer(mode: { lose: boolean; holdFirst: boolean; dedupByStatement?: boolean }) {
  const rows: Row[] = []
  const byKey = new Map<string, Row>()
  const log: string[] = []
  let release!: () => void
  let arrived!: () => void
  const arrivedP = new Promise<void>(r => { arrived = r })
  let hold: Promise<void> | null = mode.holdFirst ? new Promise<void>(r => { release = r }) : null
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchStub = (async (url: any, init?: any) => {
    const method = init?.method ?? 'GET'
    const u = String(url)
    if (method === 'POST' && /\/engrams$/.test(u)) {
      const body = JSON.parse(String(init.body))
      const hdrKey = init?.headers?.['Idempotency-Key'] ?? init?.headers?.get?.('Idempotency-Key')
      const key = body.idempotency_key ?? hdrKey ?? null
      log.push(`POST ${body.scope} ${String(key).slice(0, 8)}`)
      if (key && byKey.has(key)) return json({ id: byKey.get(key)!.id, deduplicated: true }, 200)
      // A server that (wrongly, or by content) replays an earlier id.
      if (mode.dedupByStatement) {
        const same = rows.find(r => r.statement === body.statement)
        if (same) return json({ id: same.id, deduplicated: true }, 200)
      }
      const row: Row = { id: `SRV-${rows.length + 1}`, scope: body.scope, key, statement: body.statement, deleted: false }
      rows.push(row)
      if (key) byKey.set(key, row)
      if (hold) { const h = hold; hold = null; arrived(); await h }
      if (mode.lose) { mode.lose = false; throw new TypeError('fetch failed (answer lost)') }
      return json({ id: row.id }, 201)
    }
    const m = /\/engrams\/([^/?]+)$/.exec(u)
    if (method === 'DELETE' && m) {
      const id = decodeURIComponent(m[1])
      log.push(`DELETE ${id}`)
      const r = rows.find(x => x.id === id)
      if (!r || r.deleted) return new Response('gone', { status: 404 })
      r.deleted = true
      return new Response(null, { status: 204 })
    }
    return json({ rows: [], total_count: 0 }, 200)
  }) as typeof globalThis.fetch
  return { rows, log, fetchStub, arrivedP, release: () => release?.() }
}

describe('retargeting a queued team write (security audit 2026-11-06)', () => {
  let root: string
  let dir: string
  let prevHome: string | undefined
  let prevPlurPath: string | undefined
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-outbox-retarget-'))
    prevHome = process.env.HOME
    prevPlurPath = process.env.PLUR_PATH
    process.env.HOME = join(root, 'home')
    mkdirSync(process.env.HOME, { recursive: true })
    dir = join(root, 'store')
    mkdirSync(dir, { recursive: true })
    process.env.PLUR_PATH = dir
    originalFetch = globalThis.fetch
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [
        { url: URL_, token: 'dummy-token', scope: A, shared: true, readonly: false },
        { url: URL_, token: 'dummy-token', scope: B, shared: true, readonly: false },
      ],
    }))
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env.HOME = prevHome
    if (prevPlurPath === undefined) delete process.env.PLUR_PATH
    else process.env.PLUR_PATH = prevPlurPath
    rmSync(root, { recursive: true, force: true })
  })

  const rowOf = (id: string): any => {
    const p = join(dir, 'engrams.yaml')
    if (!existsSync(p)) return undefined
    return ((yaml.load(readFileSync(p, 'utf8')) as any)?.engrams ?? []).find((e: any) => e.id === id)
  }

  it('after a lost answer, a retarget mints a new key and the memory lands in the new scope', async () => {
    const srv = mkServer({ lose: true, holdFirst: false })
    globalThis.fetch = srv.fetchStub
    const plur = new Plur({ path: dir })
    const e = await plur.learnRouted('Dummy retarget note one', { scope: A, type: 'behavioral' })
    const k1 = rowOf(e.id)?.structured_data?._outbox?.idempotency_key
    expect(k1).toBeTruthy()
    const row = (await plur.getById(e.id))!
    row.scope = B
    expect(await plur.updateEngram(row)).toBe(true)
    const ob = rowOf(e.id)?.structured_data?._outbox
    expect(ob?.target_scope).toBe(B)
    expect(ob?.idempotency_key).toBeTruthy()
    expect(ob?.idempotency_key, 'retarget reused the old-scope key').not.toBe(k1)

    await plur.flushOutbox({ force: true })
    expect(srv.rows.filter(r => r.scope === B && !r.deleted).length, 'nothing stored in the new scope').toBe(1)
  })

  it('a retarget during the in-flight background push leaves exactly one live copy, in the new scope', async () => {
    const srv = mkServer({ lose: false, holdFirst: true })
    globalThis.fetch = srv.fetchStub
    const plur = new Plur({ path: dir })
    const e = await plur.learn('Dummy retarget note two', { scope: A, type: 'behavioral' })
    await srv.arrivedP
    const row = (await plur.getById(e.id))!
    row.scope = B
    expect(await plur.updateEngram(row)).toBe(true)
    srv.release()
    const until = Date.now() + 5000
    while (!rowOf(e.id)?.structured_data?._retireRemote && Date.now() < until) await new Promise(r => setTimeout(r, 10))
    await new Promise(r => setTimeout(r, 100))
    expect(rowOf(e.id)?.structured_data?._retireRemote?.server_id).toBe('SRV-1')

    await plur.flushOutbox({ force: true })
    const live = srv.rows.filter(r => !r.deleted)
    expect(live.length, `wire: ${srv.log.join(' | ')}`).toBe(1)
    expect(live[0].scope).toBe(B)
  })

  it('a deduplicated reply naming a copy being retired is not taken as delivery', async () => {
    // A server that replays the retired copy's id for the same content: the
    // client must keep the row local and queued, never drop it as delivered.
    const srv = mkServer({ lose: false, holdFirst: true, dedupByStatement: true })
    globalThis.fetch = srv.fetchStub
    const plur = new Plur({ path: dir })
    const e = await plur.learn('Dummy retarget note three', { scope: A, type: 'behavioral' })
    await srv.arrivedP
    const row = (await plur.getById(e.id))!
    row.scope = B
    expect(await plur.updateEngram(row)).toBe(true)
    srv.release()
    const until = Date.now() + 5000
    while (!rowOf(e.id)?.structured_data?._retireRemote && Date.now() < until) await new Promise(r => setTimeout(r, 10))
    await new Promise(r => setTimeout(r, 100))

    const res = await plur.flushOutbox({ force: true })
    const after = rowOf(e.id)
    expect(after, `memory lost; wire: ${srv.log.join(' | ')}`).toBeDefined()
    expect(after.structured_data?._outbox?.target_scope).toBe(B)
    expect(res.expired_warnings.join('\n')).toMatch(/SRV-1/)
  })
})
