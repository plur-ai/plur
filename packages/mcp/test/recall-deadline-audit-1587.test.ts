/**
 * #1586 audit round (PR #1587), MCP side.
 *
 *   L1  the recall deadline starts at handler entry, before workspace
 *       resolution: core gets an absolute `deadline_at`.
 *   L6  plur_inject_hybrid and session-start injection carry the same
 *       per-call report (`remote`, `results_complete`) as plur_recall.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur, normalizeEndpointUrl, DEFAULT_RECALL_DEADLINE_MS } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TOKEN = 'audit-1587-token'
const SCOPE = 'group:test'
const PROJECT = 'project:test/app'

let stub: StubServer
let baseUrl: string
const dirs: string[] = []
let activeClients: Client[] = []

async function makeClient(plur: Plur): Promise<Client> {
  const server = await createServer(plur, { profile: 'full' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  activeClients.push(client)
  return client
}

function callResult(raw: Awaited<ReturnType<Client['callTool']>>): any {
  return JSON.parse((raw.content as any)[0].text)
}

function storeDir(url: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-1587-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'config.yaml'),
    url
      ? `embeddings:\n  enabled: false\nstores:\n  - url: "${url}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n`
      : `embeddings:\n  enabled: false\n`,
  )
  return dir
}

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
  stub.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [SCOPE] })
})

afterEach(async () => {
  await Promise.all(activeClients.map(c => c.close().catch(() => {})))
  activeClients = []
})

describe('L1 — plur_recall takes its deadline at handler entry', () => {
  for (const [mode, method] of [['hybrid', 'recallHybridWithMeta'], ['keyword', 'recallWithMeta']] as const) {
    it(`${mode}: core receives an absolute deadline_at set before the handler awaited anything`, async () => {
      const plur = new Plur({ path: storeDir(null) })
      let seen: any
      const orig = (plur as any)[method].bind(plur)
      ;(plur as any)[method] = (q: string, o: any) => { seen = o; return orig(q, o) }
      const client = await makeClient(plur)
      const before = Date.now()
      await client.callTool({ name: 'plur_recall', arguments: { query: 'anything', mode } })
      expect(typeof seen?.deadline_at).toBe('number')
      expect(seen.deadline_at).toBeGreaterThanOrEqual(before + DEFAULT_RECALL_DEADLINE_MS - 50)
      expect(seen.deadline_at).toBeLessThanOrEqual(Date.now() + DEFAULT_RECALL_DEADLINE_MS)
    })
  }
})

describe('L6 — injection replies carry the per-call remote report', () => {
  it('plur_inject_hybrid: healthy host → remote ok, results_complete true; existing fields unchanged', async () => {
    stub.recallRows = [{ id: 'ENG-2026-1004-301', scope: SCOPE, status: 'active', statement: 'inject audit fact', score: 1 }]
    const client = await makeClient(new Plur({ path: storeDir(baseUrl) }))
    const res = callResult(await client.callTool({
      name: 'plur_inject_hybrid',
      arguments: { task: 'inject audit fact', scope: PROJECT },
    }))
    expect(res.remote.state).toBe('ok')
    expect(res.remote.hosts[0].host).toBe(normalizeEndpointUrl(baseUrl))
    expect(res.results_complete).toBe(true)
    expect(typeof res.count).toBe('number')
    expect(res.mode).toBe('hybrid')
  })

  it('plur_inject_hybrid: no store → remote not_dialed, results_complete true', async () => {
    const client = await makeClient(new Plur({ path: storeDir(null) }))
    const res = callResult(await client.callTool({ name: 'plur_inject_hybrid', arguments: { task: 'anything' } }))
    expect(res.remote.state).toBe('not_dialed')
    expect(res.results_complete).toBe(true)
  })

  it('plur_session_start: the injection report is attached', async () => {
    const client = await makeClient(new Plur({ path: storeDir(null) }))
    const res = callResult(await client.callTool({ name: 'plur_session_start', arguments: { task: 'anything at all' } }))
    expect(res.remote?.state).toBe('not_dialed')
    expect(res.results_complete).toBe(true)
  })
})
