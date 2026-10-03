/**
 * A namespaced team-engram id names exactly one store (0.21.1 pre-release
 * audit of PR #1570, finding H1).
 *
 * The store prefix used to be three letters derived from the scope, so every
 * team store of one org got the same one (`group:plur/eng` and
 * `group:plur/ops` were both `GPL`). Two servers minting on the same day then
 * handed out the same namespaced id for two different engrams, recall scoped
 * to one team returned the other team's row, and forget by the second team's
 * id retired the first team's engram while reporting success. A row in a
 * readonly store could also be forgotten, rated or pinned through a writable
 * store that shared its prefix.
 *
 * These tests pin:
 *   - two stores of one org get different ids for their same-day engrams;
 *   - recall, forget, feedback and pin by that id reach that store only;
 *   - a readonly store's row is refused, never reached through a writable one;
 *   - an id in the old three-letter form still works when it resolves to one
 *     row, and is refused as ambiguous (changing nothing) when it names two.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur, bareEngramId } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TOKEN = 'prefix-unique-token'
const ENG = 'group:plur/eng'
const OPS = 'group:plur/ops'

/** The three-letter prefix releases up to 0.21.0 gave every store (copied, so this file runs on any build). */
function legacyPrefix(scope: string): string {
  const parts = scope.split(/[:\-_./]/).filter(Boolean)
  if (parts.length >= 2) {
    const p2 = parts[1]
    return (parts[0][0] + p2[0] + (p2[1] || p2[0])).toUpperCase()
  }
  const w = parts[0] || scope
  if (w.length >= 3) return (w[0] + w[Math.floor(w.length / 2)] + w[w.length - 1]).toUpperCase()
  return (w[0] + (w[1] || w[0]) + (w[2] || w[0])).toUpperCase()
}
const legacyId = (bare: string, scope: string) => bare.replace(/^(ENG|ABS|META)-/, `$1-${legacyPrefix(scope)}-`)

let sa: StubServer, sb: StubServer
let ua = '', ub = ''
const dirs: string[] = []
let clients: Client[] = []

beforeAll(async () => {
  sa = new StubServer(TOKEN); sb = new StubServer(TOKEN)
  ua = (await sa.start()).url; ub = (await sb.start()).url
})
afterAll(async () => {
  await sa.stop(); await sb.stop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
afterEach(async () => {
  await Promise.all(clients.map(c => c.close().catch(() => {})))
  clients = []
})

function storeYaml(url: string, scope: string, readonly = false): string {
  return `  - url: "${url}"\n    token: "${TOKEN}"\n    scope: "${scope}"\n${readonly ? '    readonly: true\n' : ''}`
}

async function setup(stores: string): Promise<{ client: Client; plur: Plur }> {
  const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-prefix-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n${stores}`)
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

/** Two servers, one team scope each, both minting ENG-<today>-001 for their first save. */
async function twoTeams() {
  for (const s of [sa, sb]) { s.reset(); s.datedIds = true }
  sa.setMe({ username: 'u', org_id: 'plur', role: 'developer', scopes: [ENG] })
  sb.setMe({ username: 'u', org_id: 'plur', role: 'developer', scopes: [OPS] })
  const { client, plur } = await setup(storeYaml(ua, ENG) + storeYaml(ub, OPS))
  const te = await call(client, 'plur_learn', { statement: 'eng team rule alpha', scope: ENG })
  const to = await call(client, 'plur_learn', { statement: 'ops team rule beta', scope: OPS })
  expect(te.delivery).toBe('remote')
  expect(to.delivery).toBe('remote')
  // Same server id on both servers: the collision the namespace must survive.
  expect(bareEngramId(te.id)).toBe(bareEngramId(to.id))
  sa.recallRows = [{ id: bareEngramId(te.id), scope: ENG, status: 'active', statement: 'eng team rule alpha', score: 1 }]
  sb.recallRows = [{ id: bareEngramId(to.id), scope: OPS, status: 'active', statement: 'ops team rule beta', score: 1 }]
  return { client, plur, eng: te.id as string, ops: to.id as string, bare: bareEngramId(te.id) }
}

describe('two team stores of one org (H1)', () => {
  it('save gives the two same-day engrams different ids', async () => {
    const { eng, ops } = await twoTeams()
    expect(eng).not.toBe(ops)
  })

  it('recall scoped to one team returns that team\'s row under the id its save returned', async () => {
    const { client, eng, ops } = await twoTeams()
    const re = await call(client, 'plur_recall', { query: 'team rule', scope: ENG })
    const ro = await call(client, 'plur_recall', { query: 'team rule', scope: OPS })
    expect(re.results.map((r: any) => [r.id, r.scope])).toEqual([[eng, ENG]])
    expect(ro.results.map((r: any) => [r.id, r.scope])).toEqual([[ops, OPS]])
  })

  it('forget by the ops id retires the ops engram and leaves the eng engram active', async () => {
    const { client, bare, ops } = await twoTeams()
    const res = await call(client, 'plur_forget', { id: ops })
    expect(res._isError, JSON.stringify(res)).toBe(false)
    expect(res.success).toBe(true)
    expect(res.retired?.statement ?? 'ops team rule beta').toBe('ops team rule beta')
    expect(sb.getEngram(bare)?.status).toBe('retired')
    expect(sa.getEngram(bare)?.status).toBe('active')
  })

  it('feedback and pin by the ops id reach the ops server only', async () => {
    const { client, bare, ops } = await twoTeams()
    const fb = await call(client, 'plur_feedback', { id: ops, signal: 'positive' })
    expect(fb._isError, JSON.stringify(fb)).toBe(false)
    expect(sb.feedbackBodies.length).toBe(1)
    expect(sa.feedbackBodies.length).toBe(0)
    const pin = await call(client, 'plur_pin', { id: ops })
    expect(pin._isError, JSON.stringify(pin)).toBe(false)
    expect((sb.getEngram(bare)?.data as any).pinned).toBe(true)
    expect((sa.getEngram(bare)?.data as any).pinned ?? false).toBe(false)
  })

  it('an id in the old three-letter form that names both engrams is refused and changes nothing', async () => {
    const { client, bare } = await twoTeams()
    const old = legacyId(bare, OPS)
    for (const [tool, args] of [
      ['plur_forget', { id: old }],
      ['plur_feedback', { id: old, signal: 'negative' }],
      ['plur_pin', { id: old }],
    ] as const) {
      const res = await call(client, tool, args)
      expect(res.success === true && !res._isError, `${tool}: ${JSON.stringify(res)}`).toBe(false)
      expect(JSON.stringify(res), tool).toMatch(/ambiguous/i)
    }
    for (const s of [sa, sb]) {
      expect(s.getEngram(bare)?.status).toBe('active')
      expect((s.getEngram(bare)?.data as any).pinned ?? false).toBe(false)
      expect(s.feedbackBodies.length).toBe(0)
    }
  })

  it('an id in the old three-letter form still works where it names one engram', async () => {
    for (const s of [sa, sb]) { s.reset(); s.datedIds = true }
    sa.setMe({ username: 'u', org_id: 'plur', role: 'developer', scopes: [ENG] })
    const { client } = await setup(storeYaml(ua, ENG))
    const t = await call(client, 'plur_learn', { statement: 'single store rule', scope: ENG })
    const old = legacyId(bareEngramId(t.id), ENG)
    const res = await call(client, 'plur_forget', { id: old })
    expect(res._isError, JSON.stringify(res)).toBe(false)
    expect(res.success).toBe(true)
    expect(sa.getEngram(bareEngramId(t.id))?.status).toBe('retired')
  })
})

describe('one server holding a writable and a readonly team store (H1, readonly bypass)', () => {
  const ROW = 'ENG-2026-10-03-007'

  async function oneServer(readonlyOps: boolean) {
    sa.reset(); sa.datedIds = true
    sa.setMe({ username: 'u', org_id: 'plur', role: 'developer', scopes: [ENG, OPS] })
    // The row lives in the ops scope; the eng store comes FIRST in config.
    sa.seedEngram({ id: ROW, scope: OPS, status: 'active', data: { statement: 'ops readonly rule', type: 'behavioral' } })
    sa.recallRows = [{ id: ROW, scope: OPS, status: 'active', statement: 'ops readonly rule', score: 1 }]
    const { client, plur } = await setup(storeYaml(ua, ENG) + storeYaml(ua, OPS, readonlyOps))
    const rec = await call(client, 'plur_recall', { query: 'ops readonly rule', scope: OPS })
    const id = rec.results.find((r: any) => r.scope === OPS)?.id as string
    expect(id).toBeTruthy()
    return { client, plur, id }
  }

  it('forget, feedback and pin by the readonly row\'s id are refused and nothing reaches the server', async () => {
    const { client, id } = await oneServer(true)
    for (const [tool, args] of [
      ['plur_forget', { id }],
      ['plur_feedback', { id, signal: 'negative' }],
      ['plur_pin', { id }],
    ] as const) {
      const res = await call(client, tool, args)
      expect(res.success === true && !res._isError, `${tool}: ${JSON.stringify(res)}`).toBe(false)
    }
    expect(sa.getEngram(ROW)?.status).toBe('active')
    expect((sa.getEngram(ROW)?.data as any).pinned ?? false).toBe(false)
    expect(sa.feedbackBodies.length).toBe(0)
  })

  it('the old three-letter form of the readonly row\'s id is refused too', async () => {
    const { client } = await oneServer(true)
    const res = await call(client, 'plur_forget', { id: legacyId(ROW, OPS) })
    expect(res.success === true && !res._isError, JSON.stringify(res)).toBe(false)
    expect(sa.getEngram(ROW)?.status).toBe('active')
  })

  it('the old three-letter form resolves to the store whose scope holds the row', async () => {
    const { client } = await oneServer(false)
    const res = await call(client, 'plur_forget', { id: legacyId(ROW, OPS) })
    expect(res._isError, JSON.stringify(res)).toBe(false)
    expect(sa.getEngram(ROW)?.status).toBe('retired')
  })
})

describe('history recorded under an old-form id', () => {
  it('a lookup by the new id still returns events recorded under the old form', async () => {
    sa.reset(); sa.datedIds = true
    sa.setMe({ username: 'u', org_id: 'plur', role: 'developer', scopes: [ENG] })
    const { client, plur } = await setup(storeYaml(ua, ENG))
    const t = await call(client, 'plur_learn', { statement: 'history compat rule', scope: ENG })
    const old = legacyId(bareEngramId(t.id), ENG)
    // An event an earlier release wrote under the old id form.
    ;(plur as any)._appendHistory({ event: 'feedback_received', engram_id: old, timestamp: new Date().toISOString(), data: { signal: 'positive' } })
    const h = await call(client, 'plur_history', { engram_id: t.id })
    expect(h.events.map((e: any) => e.engram_id)).toContain(old)
  })
})
