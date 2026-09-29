/**
 * #1310 — automatic feedback reaches a remote store only when the server says
 * it will treat it as ranking-only.
 *
 * Contract (docs/specs/2026-09-29-feedback-source-contract.md):
 * - the server advertises `capabilities: ["feedback.source"]` in GET /api/v1/me;
 * - the client then sends `{ signal, source: "auto" }` on POST /engrams/:id/feedback;
 * - a server that does not advertise it receives nothing automatic;
 * - explicit feedback's request body is unchanged: `{ signal }` only.
 * The capability is looked up at most once per (url, token) per process.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { RemoteStore, FEEDBACK_SOURCE_CAPABILITY, _resetRemoteCapabilityCache } from '../src/store/remote-store.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'feedback-source-token'
const SCOPE = 'group:test'
let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

describe('remote feedback source (#1310)', () => {
  let dir: string
  let serverId: string

  beforeEach(async () => {
    server.reset()
    server.setMe({ capabilities: [] })
    _resetRemoteCapabilityCache()
    dir = mkdtempSync(join(tmpdir(), 'plur-fb-source-'))
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: baseUrl, token: TOKEN, scope: SCOPE, shared: true, readonly: false }],
      index: false,
    }))
    const seeded = new RemoteStore(baseUrl, TOKEN, SCOPE, { ttlMs: 0 })
    await seeded.append({ id: 'tmp', scope: SCOPE, status: 'active', statement: 'team rule for auto feedback' } as any)
    serverId = 'ENG-SRV-001'
    expect(server.getEngram(serverId)).toBeTruthy()
    server.meCalls = 0
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    server.setMe({ capabilities: [] })
  })

  const history = (): Array<Record<string, any>> => {
    const h = join(dir, 'history')
    if (!existsSync(h)) return []
    return readdirSync(h).flatMap(f => readFileSync(join(h, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
  }

  it('me() exposes advertised capabilities and drops malformed entries', async () => {
    server.setMe({ capabilities: [FEEDBACK_SOURCE_CAPABILITY, 42, 'bad\nvalue'] })
    const me = await new RemoteStore(baseUrl, TOKEN, SCOPE).me()
    expect(me.capabilities).toEqual([FEEDBACK_SOURCE_CAPABILITY])
  })

  it('a capable server receives source: "auto" (scope-routed)', async () => {
    server.setMe({ capabilities: [FEEDBACK_SOURCE_CAPABILITY] })
    const plur = new Plur({ path: dir })
    await plur.feedback(serverId, 'positive', SCOPE, { source: 'auto' })
    expect(server.feedbackBodies).toEqual([{ signal: 'positive', source: 'auto' }])
    const ev = history().find(h => h.event === 'feedback_received')
    expect(ev?.data).toMatchObject({ signal: 'positive', routed_to: 'remote', source: 'auto' })
  })

  it('a capable server receives source: "auto" (unscoped walk)', async () => {
    server.setMe({ capabilities: [FEEDBACK_SOURCE_CAPABILITY] })
    const plur = new Plur({ path: dir })
    await plur.feedback(serverId, 'negative', undefined, { source: 'auto' })
    expect(server.feedbackBodies).toEqual([{ signal: 'negative', source: 'auto' }])
  })

  it('an incapable server receives nothing automatic', async () => {
    const plur = new Plur({ path: dir })
    await expect(plur.feedback(serverId, 'positive', SCOPE, { source: 'auto' })).rejects.toThrow(/feedback\.source/)
    await expect(plur.feedback(serverId, 'positive', undefined, { source: 'auto' })).rejects.toThrow(/not found/i)
    expect(server.feedbackBodies).toEqual([])
    expect((server.getEngram(serverId)?.data as any)?.feedback_signals?.positive ?? 0).toBe(0)
  })

  it('explicit feedback is unchanged: body is { signal } only, capable or not', async () => {
    const plur = new Plur({ path: dir })
    await plur.feedback(serverId, 'positive', SCOPE)
    server.setMe({ capabilities: [FEEDBACK_SOURCE_CAPABILITY] })
    await plur.feedback(serverId, 'positive', SCOPE)
    expect(server.feedbackBodies).toEqual([{ signal: 'positive' }, { signal: 'positive' }])
    // Explicit feedback never needs the capability, so it never asks for it.
    expect(server.meCalls).toBe(0)
  })

  it('looks the capability up once per process, not once per rating', async () => {
    server.setMe({ capabilities: [FEEDBACK_SOURCE_CAPABILITY] })
    const plur = new Plur({ path: dir })
    for (let i = 0; i < 4; i++) await plur.feedback(serverId, 'positive', SCOPE, { source: 'auto' })
    expect(server.feedbackBodies).toHaveLength(4)
    expect(server.meCalls).toBe(1)
  })

  it('a capability learned from an earlier /me (session start) costs no further call', async () => {
    server.setMe({ capabilities: [FEEDBACK_SOURCE_CAPABILITY] })
    await new RemoteStore(baseUrl, TOKEN, SCOPE).me()
    server.meCalls = 0
    const plur = new Plur({ path: dir })
    await plur.feedback(serverId, 'positive', SCOPE, { source: 'auto' })
    expect(server.meCalls).toBe(0)
    expect(server.feedbackBodies).toEqual([{ signal: 'positive', source: 'auto' }])
  })
})
