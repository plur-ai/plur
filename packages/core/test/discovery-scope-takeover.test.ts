/**
 * Security audit 2026-11-06: a server's GET /api/v1/me answer must not take
 * over a scope the user serves from a local path store, and the org the
 * answer may claim is bound to the org cached at first discovery.
 *
 * globalThis.fetch is stubbed in-process: no network, no listening socket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { acceptDiscoveredScopes } from '../src/server-discovery.js'

const SRV = 'https://srv.example.invalid'
let dir: string
let home: string
let oldHome: string | undefined
let oldPlurPath: string | undefined
let posts: Array<{ url: string; body: string }>

function stubFetch(me: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    if (method !== 'GET') {
      posts.push({ url: u, body: String(init?.body ?? '') })
      return new Response(JSON.stringify({ id: 'ENG-REMOTE-1' }), { status: 201, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('/api/v1/me')) return new Response(JSON.stringify(me), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ engrams: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawConfig = (): any => yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-v29-'))
  home = mkdtempSync(join(tmpdir(), 'plur-v29-home-'))
  oldHome = process.env.HOME
  oldPlurPath = process.env.PLUR_PATH
  process.env.HOME = home
  process.env.PLUR_PATH = dir
  posts = []
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
  if (oldPlurPath === undefined) delete process.env.PLUR_PATH; else process.env.PLUR_PATH = oldPlurPath
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('discovery never moves a locally served scope to a server', () => {
  it('a scope served by a path store is refused as claimed', async () => {
    const local = join(dir, 'local-store')
    mkdirSync(local)
    writeFileSync(join(dir, 'config.yaml'),
      `stores:\n  - path: ${local}\n    scope: project:acme/web\n    shared: true\n` +
      `  - url: ${SRV}\n    token: dummy-token\n    scope: user:acme:eve\n    scopes: [user:acme:eve]\n    enterprise: {}\n    discovery: { org_id: acme }\n`)
    stubFetch({ username: 'eve', org_id: 'acme', role: 'dev', scopes: ['user:acme:eve', 'project:acme/web'], scopes_status: 'ok' })
    const plur = new Plur({ path: dir })
    const [o] = await plur.refreshServerScopes()
    expect(o.rejected).toEqual([{ scope: 'project:acme/web', reason: 'claimed-by-other-server' }])
    expect(rawConfig().stores[1].scopes).toEqual(['user:acme:eve'])
    const after = new Plur({ path: dir })
    await after.learn('the web project uses a monorepo', { scope: 'project:acme/web' })
    expect(posts.filter(p => p.url.includes('/api/v1/engrams'))).toEqual([])
  })

  it('an answer naming another org than the cached one is degraded and changes nothing', async () => {
    const local = join(dir, 'local-store')
    mkdirSync(local)
    writeFileSync(join(dir, 'config.yaml'),
      `stores:\n  - path: ${local}\n    scope: project:zeta/web\n    shared: true\n` +
      `  - url: ${SRV}\n    token: dummy-token\n    scope: user:other:eve\n    scopes: [user:other:eve]\n    enterprise: {}\n    discovery: { org_id: other }\n`)
    stubFetch({ username: 'eve', org_id: 'zeta', role: 'dev', scopes: ['user:zeta:eve', 'project:zeta/web'], scopes_status: 'ok' })
    const plur = new Plur({ path: dir })
    const [o] = await plur.refreshServerScopes()
    expect(o.status).toBe('degraded')
    expect(o.applied).toBe(false)
    const entry = rawConfig().stores[1]
    expect(entry.scopes).toEqual(['user:other:eve'])
    expect(entry.discovery.org_id).toBe('other')

    const after = new Plur({ path: dir })
    await after.learn('the web project uses a monorepo', { scope: 'project:zeta/web' })
    expect(posts.filter(p => p.url.includes('/api/v1/engrams'))).toEqual([])
  })
})

describe('acceptDiscoveredScopes binds org_id to the cached org', () => {
  const me = (org: string) => ({
    username: 'eve', org_id: org, role: 'dev', scopes: [`user:${org}:eve`, `group:${org}/eng`],
    scopes_status: 'ok' as const, project_paths: {},
  })
  it('a changed org keeps the cache and rejects every scope', () => {
    const r = acceptDiscoveredScopes({ me: me('zeta') as never, cached: ['user:acme:eve'], otherServersScopes: new Map(), cachedOrgId: 'acme' })
    expect(r).toMatchObject({ status: 'degraded', replaceCache: false, scopes: ['user:acme:eve'] })
    expect(r.rejected.map(x => x.reason)).toEqual(['org-prefix', 'org-prefix'])
  })
  it('the same org (any case) is accepted as before', () => {
    const r = acceptDiscoveredScopes({ me: me('acme') as never, cached: [], otherServersScopes: new Map(), cachedOrgId: 'ACME' })
    expect(r).toMatchObject({ status: 'ok', replaceCache: true, scopes: ['user:acme:eve', 'group:acme/eng'] })
  })
})
