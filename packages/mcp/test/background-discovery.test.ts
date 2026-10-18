/**
 * MCP startup never waits on the network for a company server's scopes (#1631).
 *
 * A server entry (a store entry with a `scopes` list and an `enterprise`
 * block) has its scopes discovered from `GET /api/v1/me`. Editors give an MCP
 * server a short startup window, so the discovery runs in the background:
 * createServer starts one refresh without awaiting it, plur_session_start
 * starts another only when none is in flight and builds its guide from the
 * cached scopes, and the next tool call sees the refreshed list. A hanging or
 * failing /me never delays a tool, and a failure is logged by the server's
 * safe origin only. Full MCP → core → /me pipeline against the in-process
 * stub (real HTTP).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { whenDiscoverySettled, discoverySummary } from '../src/background-discovery.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'background-discovery-token'
const PERSONAL = 'user:acme:alice'
const BACKEND = 'project:acme/team/backend'
const API = 'project:acme/team/api'

let stub: StubServer
let baseUrl: string
const dirs: string[] = []
let clients: Client[] = []
let release: (() => void) | null = null

/** Holds every /me answer until the test ends (a server that never answers). */
function holdMe(): void {
  const gate = new Promise<void>(resolve => { release = resolve })
  stub.beforeMe = () => gate
}

function seed(opts: { scopes: string[]; scope?: string; url?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-bg-discovery-'))
  dirs.push(dir)
  const entry: Record<string, unknown> = {
    url: opts.url ?? baseUrl, token: TOKEN, scopes: opts.scopes, enterprise: {},
    ...(opts.scope ? { scope: opts.scope } : {}),
  }
  // JSON is valid YAML (this package has no js-yaml dependency).
  writeFileSync(join(dir, 'config.yaml'), JSON.stringify({ embeddings: { enabled: false }, stores: [entry] }))
  return dir
}

async function connect(plur: Plur, options?: { discovery?: boolean }): Promise<Client> {
  const server = await createServer(plur, options)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const raw = await client.callTool({ name, arguments: args })
  return JSON.parse((raw.content as any)[0].text)
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
  stub.setMe({ username: 'alice', org_id: 'acme', role: 'developer', scopes: [PERSONAL, BACKEND], scopes_status: 'ok', scope_metadata_status: 'ok' })
})

afterEach(async () => {
  release?.()
  release = null
  await Promise.all(clients.map(c => c.close().catch(() => {})))
  clients = []
  vi.restoreAllMocks()
})

describe('MCP scope discovery runs in the background (#1631)', () => {
  it('startup and session_start return while /me is still hanging', async () => {
    holdMe()
    const plur = new Plur({ path: seed({ scopes: [PERSONAL, BACKEND], scope: PERSONAL }) })
    const t0 = Date.now()
    const client = await connect(plur)
    const r = await call(client, 'plur_session_start', { task: 'x' })
    // /me never answers: waiting on it at all would take at least the
    // refresh's 5 s budget (or the legacy probe's 3 s). The bound leaves room
    // for a loaded CI machine running the whole suite in parallel.
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(r.discovery).toEqual([{ url: baseUrl, status: 'pending', scopes: 2 }])
    // The guide is built from the cached scopes.
    expect(r.guide).toContain(`"${BACKEND}"`)
    // One refresh in flight: session_start did not start a second one.
    expect(stub.meCalls).toBe(1)
  })

  it('a refreshed scope list is used by the next learn without a restart', async () => {
    stub.setMe({ scopes: [PERSONAL, BACKEND, API] })
    const dir = seed({ scopes: [PERSONAL, BACKEND], scope: PERSONAL })
    const plur = new Plur({ path: dir })
    const client = await connect(plur)
    await whenDiscoverySettled(plur)
    expect((await plur.listStores()).map(s => s.scope)).toContain(API)
    const r = await call(client, 'plur_learn', { statement: 'the api service owns rate limiting', scope: API })
    expect(r.scope, JSON.stringify(r)).toBe(API)
    expect(stub.engramCount).toBe(1)
  })

  it('guide caps the scope list at 20', async () => {
    holdMe()
    const many = Array.from({ length: 300 }, (_, i) => `project:acme/p${i}`)
    const plur = new Plur({ path: seed({ scopes: many }) })
    const client = await connect(plur)
    const r = await call(client, 'plur_session_start', { task: 'x' })
    expect(r.guide).toContain('+280 more')
    expect((r.guide.match(/"project:acme\/p\d+"/g) ?? []).length).toBe(20)
    expect(r.discovery[0].scopes).toBe(300)
  })

  it('discovery: false makes no /me request', async () => {
    const plur = new Plur({ path: seed({ scopes: [PERSONAL, BACKEND], scope: PERSONAL }) })
    const client = await connect(plur, { discovery: false })
    await call(client, 'plur_session_start', { task: 'x' })
    await whenDiscoverySettled(plur)
    expect(stub.meCalls).toBe(0)
  })

  it('each session_start runs at most one discovery', async () => {
    const plur = new Plur({ path: seed({ scopes: [PERSONAL, BACKEND], scope: PERSONAL }) })
    const client = await connect(plur)
    await whenDiscoverySettled(plur)
    expect(stub.meCalls).toBe(1)
    const r = await call(client, 'plur_session_start', { task: 'x' })
    await whenDiscoverySettled(plur)
    expect(stub.meCalls).toBe(2)
    expect(r.discovery).toHaveLength(1)
    await call(client, 'plur_session_start', { task: 'y' })
    await whenDiscoverySettled(plur)
    expect(stub.meCalls).toBe(3)
  })

  it('a failing /me does not delay session_start, keeps the cache and is logged by safe origin only', async () => {
    stub.meStatus = 503
    stub.meBody = { error: 'scope_lookup_failed', echoed: TOKEN }
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true }) as any)
    const dir = seed({ scopes: [PERSONAL, BACKEND], scope: PERSONAL, url: `${baseUrl}/` })
    const plur = new Plur({ path: dir })
    const t0 = Date.now()
    const client = await connect(plur)
    await whenDiscoverySettled(plur)
    const r = await call(client, 'plur_session_start', { task: 'x' })
    expect(Date.now() - t0).toBeLessThan(2500)
    await whenDiscoverySettled(plur)
    expect((await plur.listStores()).map(s => s.scope).filter(sc => sc !== 'global')).toEqual(expect.arrayContaining([PERSONAL, BACKEND]))
    expect(r.discovery[0].scopes).toBe(2)
    const lines = writes.filter(w => w.includes('[plur:discovery]'))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(l).toContain(new URL(baseUrl).origin)
      expect(l).not.toContain(TOKEN)
      expect(l).not.toContain('scope_lookup_failed')
    }
    // With nothing in flight, the last outcome is what is reported.
    expect(discoverySummary(plur)).toEqual([{ url: baseUrl, status: 'failed', scopes: 2 }])
  })

  it('a url with credentials never reaches the log or the discovery field', async () => {
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true }) as any)
    const withUser = baseUrl.replace('http://', 'http://alice:hunter2@')
    const plur = new Plur({ path: seed({ scopes: [PERSONAL, BACKEND], scope: PERSONAL, url: withUser }) })
    const client = await connect(plur)
    await whenDiscoverySettled(plur)
    const r = await call(client, 'plur_session_start', { task: 'x' })
    await whenDiscoverySettled(plur)
    expect(JSON.stringify(r.discovery)).not.toContain('hunter2')
    expect(r.discovery[0].url).toBe(baseUrl)
    for (const l of writes.filter(w => w.includes('[plur:discovery]'))) expect(l).not.toContain('hunter2')
  })

  it('an install with no server entry gets no discovery field and no extra /me', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-bg-discovery-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    const plur = new Plur({ path: dir })
    const client = await connect(plur)
    const r = await call(client, 'plur_session_start', { task: 'x' })
    await whenDiscoverySettled(plur)
    expect(r.discovery).toBeUndefined()
    expect(stub.meCalls).toBe(0)
  })
})
