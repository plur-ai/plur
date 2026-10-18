/**
 * One id for a team engram, from save to recall to forget (#1568, 0.21.1
 * pre-release check finding F3).
 *
 * plur_learn into a team store returns the namespaced id (`ENG-<PREFIX>-…`,
 * #914). plur_recall used to hand the same row back under its BARE server id
 * (#1119), so an agent held two ids for one engram — and the bare one is the
 * id a local engram minted the same day also has. These tests pin:
 *
 *   - recall (hybrid and keyword) and inject return the id save returned;
 *   - feedback, pin and forget accept that id and act on the team row only —
 *     the local engram with the same bare id stays as it was;
 *   - a bare id still works where it names one engram, and is still refused
 *     where it names two (#831);
 *   - a team save does not list itself as its own near-duplicate (L1).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur, bareEngramId, storePrefix } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TOKEN = 'team-id-token'
const SCOPE = 'group:test'
const PREFIX = storePrefix(SCOPE)

let stub: StubServer
let baseUrl: string
const dirs: string[] = []
let clients: Client[] = []

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  baseUrl = (await stub.start()).url
})
afterAll(async () => {
  await stub.stop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
beforeEach(() => {
  stub.reset()
  stub.datedIds = true
  stub.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [SCOPE] })
})
afterEach(async () => {
  await Promise.all(clients.map(c => c.close().catch(() => {})))
  clients = []
})

async function setup(): Promise<{ client: Client; plur: Plur }> {
  const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-teamid-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'config.yaml'),
    `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n`,
  )
  const plur = new Plur({ path: dir })
  const server = await createServer(plur, { profile: 'full' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(ct)
  clients.push(client)
  return { client, plur }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const raw = await client.callTool({ name, arguments: args })
  const text = (raw.content as any)[0].text as string
  try { return { ...JSON.parse(text), _isError: raw.isError === true } } catch { return { _text: text, _isError: raw.isError === true } }
}

/** A local engram, then a team engram whose bare server id is the same. */
async function collidingPair(client: Client): Promise<{ local: string; team: string }> {
  const l = await call(client, 'plur_learn', { statement: 'zebra crossings are painted white locally', scope: 'global' })
  const t = await call(client, 'plur_learn', { statement: 'zebra team rule for deploy windows', scope: SCOPE })
  expect(t.delivery).toBe('remote')
  // The server serves this row from its recall endpoint.
  stub.recallRows = [{ id: bareEngramId(t.id), scope: SCOPE, status: 'active', statement: 'zebra team rule for deploy windows', score: 1 }]
  return { local: l.id, team: t.id }
}

describe('a team engram keeps one id from save to recall (F3)', () => {
  it('save returns the namespaced id, and its bare form is the local twin\'s id', async () => {
    const { client } = await setup()
    const { local, team } = await collidingPair(client)
    expect(team.startsWith(`ENG-${PREFIX}-`)).toBe(true)
    expect(bareEngramId(team)).toBe(local)
  })

  it('plur_recall (hybrid) returns the id save returned', async () => {
    const { client } = await setup()
    const { local, team } = await collidingPair(client)
    const res = await call(client, 'plur_recall', { query: 'zebra team rule deploy windows', scope: SCOPE })
    const teamRow = res.results.find((r: any) => r.scope === SCOPE)
    expect(teamRow?.id).toBe(team)
    // The local twin keeps its own (bare) id; no two rows share an id.
    const ids = res.results.map((r: any) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((i: string) => i === local).length).toBeLessThanOrEqual(1)
  })

  it('plur_recall (keyword) and plur_recall_hybrid return the id save returned', async () => {
    const { client } = await setup()
    const { team } = await collidingPair(client)
    const kw = await call(client, 'plur_recall', { query: 'zebra team rule deploy windows', scope: SCOPE, mode: 'keyword' })
    expect(kw.results.find((r: any) => r.scope === SCOPE)?.id).toBe(team)
    const hy = await call(client, 'plur_recall_hybrid', { query: 'zebra team rule deploy windows', scope: SCOPE })
    expect(hy.results.find((r: any) => r.scope === SCOPE)?.id).toBe(team)
  })

  it('plur_inject_hybrid names the team row by the id save returned', async () => {
    const { client } = await setup()
    const { team } = await collidingPair(client)
    const res = await call(client, 'plur_inject_hybrid', { task: 'zebra team rule deploy windows', scope: SCOPE })
    const ids: string[] = res.injected_ids ?? []
    expect(ids).toContain(team)
  })

  it('plur_forget with the recalled id retires only the team row', async () => {
    const { client, plur } = await setup()
    const { local, team } = await collidingPair(client)
    const rec = await call(client, 'plur_recall', { query: 'zebra team rule deploy windows', scope: SCOPE })
    const recalledId = rec.results.find((r: any) => r.scope === SCOPE).id
    const res = await call(client, 'plur_forget', { id: recalledId })
    expect(res._isError, JSON.stringify(res)).toBe(false)
    expect(res.success).toBe(true)
    expect(stub.getEngram(bareEngramId(team))?.status).toBe('retired')
    expect((await plur.getById(local))?.status).toBe('active')
  })

  it('plur_feedback and plur_pin accept the namespaced id and reach the team row', async () => {
    const { client, plur } = await setup()
    const { local, team } = await collidingPair(client)
    const fb = await call(client, 'plur_feedback', { id: team, signal: 'positive' })
    expect(fb._isError, JSON.stringify(fb)).toBe(false)
    expect(fb.success).toBe(true)
    expect(stub.feedbackBodies.length).toBe(1)
    const pin = await call(client, 'plur_pin', { id: team })
    expect(pin._isError, JSON.stringify(pin)).toBe(false)
    expect((stub.getEngram(bareEngramId(team))?.data as any).pinned).toBe(true)
    // The local twin was not touched by either.
    const twin = await plur.getById(local)
    expect(twin?.pinned ?? false).toBe(false)
    expect(twin?.feedback_signals?.positive ?? 0).toBe(0)
  })

  it('a bare id that names two engrams is still refused, and changes nothing', async () => {
    const { client, plur } = await setup()
    const { local, team } = await collidingPair(client)
    // Warm the remote cache so the collision is known, as a session would.
    await call(client, 'plur_recall', { query: 'zebra team rule deploy windows', scope: SCOPE })
    const res = await call(client, 'plur_forget', { id: local })
    const text = JSON.stringify(res)
    expect(res.success === true && !res._isError).toBe(false)
    expect(text).toMatch(/ambiguous|both|scope/i)
    expect(stub.getEngram(bareEngramId(team))?.status).toBe('active')
    expect((await plur.getById(local))?.status).toBe('active')
  })

  it('a bare id that names one team engram still works', async () => {
    const { client } = await setup()
    const t = await call(client, 'plur_learn', { statement: 'only on the team side', scope: SCOPE })
    const res = await call(client, 'plur_forget', { id: bareEngramId(t.id) })
    expect(res._isError, JSON.stringify(res)).toBe(false)
    expect(res.success).toBe(true)
    expect(stub.getEngram(bareEngramId(t.id))?.status).toBe('retired')
  })
})

describe('a team save does not list itself as its own near-duplicate (L1)', () => {
  it('excludes the saved row by the id recall gives it', async () => {
    const { client, plur } = await setup()
    const seen: Array<string | undefined> = []
    const orig = plur.nearDuplicates.bind(plur)
    plur.nearDuplicates = (async (s: string, c?: any, excludeId?: string) => {
      seen.push(excludeId)
      return orig(s, c, excludeId)
    }) as typeof plur.nearDuplicates
    const t = await call(client, 'plur_learn', { statement: 'team rule that should not shadow itself', scope: SCOPE })
    expect(t.delivery).toBe('remote')
    expect(seen).toEqual([t.id])
  })
})
