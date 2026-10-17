/**
 * Plur.refreshServerScopes — discovers a server entry's scopes from
 * GET /api/v1/me and writes the discovery cache into config.yaml.
 *
 * A failed or degraded answer never replaces the cached list: only
 * `discovery.status` and `discovery.checked_at` change then. The `enterprise`
 * block, `pinned_scopes` and `scope_settings` are never touched (metadata
 * aside), and per-scope entries are left alone. Real HTTP against the stub.
 *
 * Refs plur-ai/plur#1631
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { logger } from '../src/logger.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 't-alice'
let stub: StubServer
let url: string
let dir: string
let plur: Plur

const configPath = (): string => join(dir, 'config.yaml')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawConfig = (): any => yaml.load(readFileSync(configPath(), 'utf8'))
const seed = (content: string): void => { writeFileSync(configPath(), content); plur = new Plur({ path: dir }) }
const serverEntry = (extra = ''): string =>
  `stores:\n  - url: ${url}\n    token: ${TOKEN}\n    enterprise: { hello_engram_id: ENG-1 }\n    scopes: []\n${extra}`

const OK_ME = {
  username: 'alice', org_id: 'acme', role: 'developer',
  scopes: ['user:acme:alice', 'project:acme/team/backend'],
  scopes_status: 'ok', scope_metadata_status: 'ok',
  gitlab_host: 'gitlab.example.com',
  project_paths: { 'project:acme/team/backend': 'team/backend' },
}

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  ;({ url } = await stub.start())
})
afterAll(async () => { await stub.stop() })
beforeEach(() => {
  stub.reset()
  stub.setMe(OK_ME)
  dir = mkdtempSync(join(tmpdir(), 'plur-refresh-'))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('refreshServerScopes — accepted answers write the cache', () => {
  it('first run fills scopes, discovered_at and the discovery cache', async () => {
    seed(serverEntry())
    const [o] = await plur.refreshServerScopes()
    expect(o).toMatchObject({ url, status: 'ok', applied: true, scopes: ['user:acme:alice', 'project:acme/team/backend'], rejected: [], pinned_unlisted: [], username: 'alice' })
    const raw = rawConfig()
    expect(raw.stores[0].scopes).toEqual(['user:acme:alice', 'project:acme/team/backend'])
    expect(raw.stores[0].discovery).toMatchObject({
      status: 'ok', scopes_status: 'ok', username: 'alice', org_id: 'acme', gitlab_host: 'gitlab.example.com',
      project_paths: { 'project:acme/team/backend': 'team/backend' },
    })
    expect(typeof raw.stores[0].discovery.discovered_at).toBe('string')
    expect(typeof raw.stores[0].discovery.checked_at).toBe('string')
    expect(raw.stores[0].scope).toBe('user:acme:alice')   // compat scope for older clients
    expect('key_expires_at' in raw.stores[0].discovery).toBe(false)   // absent stays absent
    expect((await plur.listStores()).map(s => s.scope)).toContain('project:acme/team/backend')
  })

  it('key_expires_at null (no expiry) is written as null', async () => {
    stub.setMe({ key_expires_at: null })
    seed(serverEntry())
    await plur.refreshServerScopes()
    expect(rawConfig().stores[0].discovery.key_expires_at).toBeNull()
  })

  it('an older server with no scopes_status: the field is omitted from the cache', async () => {
    stub.reset()
    stub.setMe({ username: 'alice', org_id: 'acme', role: 'developer', scopes: ['user:acme:alice'] })
    seed(serverEntry())
    const [o] = await plur.refreshServerScopes()
    expect(o).toMatchObject({ status: 'ok', applied: true, scopes: ['user:acme:alice'] })
    expect('scopes_status' in rawConfig().stores[0].discovery).toBe(false)
  })

  it('scopes of another org are refused and reported, not written', async () => {
    stub.setMe({ scopes: ['user:acme:alice', 'group:other/team'] })
    seed(serverEntry())
    const [o] = await plur.refreshServerScopes()
    expect(o.rejected).toEqual([{ scope: 'group:other/team', reason: 'org-prefix' }])
    expect(rawConfig().stores[0].scopes).toEqual(['user:acme:alice'])
  })

  it('a scope another server already serves is refused', async () => {
    seed(serverEntry() + `  - url: https://other.example.com\n    token: o\n    scope: project:acme/team/backend\n`)
    const [o] = await plur.refreshServerScopes()
    expect(o.rejected).toEqual([{ scope: 'project:acme/team/backend', reason: 'claimed-by-other-server' }])
    expect(rawConfig().stores[0].scopes).toEqual(['user:acme:alice'])
  })
})

describe('refreshServerScopes — a refused answer keeps the cache', () => {
  const CACHED = `    scope: user:acme:alice\n    scopes: ["user:acme:alice", "group:acme/team"]\n    discovery:\n      discovered_at: "2026-10-16T12:00:00Z"\n      scopes_status: ok\n      status: ok\n`
  const cachedEntry = (): string => `stores:\n  - url: ${url}\n    token: ${TOKEN}\n    enterprise: { hello_engram_id: ENG-1 }\n${CACHED}`

  it('a later 503 leaves scope, scopes and discovery.discovered_at byte-identical and reports failed', async () => {
    seed(cachedEntry())
    const before = rawConfig().stores[0]
    stub.meStatus = 503
    stub.meBody = { error: 'scope_lookup_failed' }
    const [o] = await plur.refreshServerScopes()
    expect(o).toMatchObject({ status: 'failed', applied: false, scopes: ['user:acme:alice', 'group:acme/team'] })
    expect(typeof o.error).toBe('string')
    const after = rawConfig().stores[0]
    expect(after.scope).toBe(before.scope)
    expect(after.scopes).toEqual(before.scopes)
    expect(after.discovery.discovered_at).toBe(before.discovery.discovered_at)
    expect(after.discovery.scopes_status).toBe('ok')
    expect(after.discovery.status).toBe('failed')
    expect(typeof after.discovery.checked_at).toBe('string')
  })

  it('401 reports auth_failed and keeps the cache', async () => {
    seed(cachedEntry())
    stub.meStatus = 401
    const [o] = await plur.refreshServerScopes()
    expect(o).toMatchObject({ status: 'auth_failed', applied: false })
    expect(rawConfig().stores[0].scopes).toEqual(['user:acme:alice', 'group:acme/team'])
    expect(rawConfig().stores[0].discovery.status).toBe('auth_failed')
  })

  it('an older server answering an empty list is degraded and keeps the cache', async () => {
    stub.reset()
    stub.setMe({ username: 'alice', org_id: 'acme', role: 'developer', scopes: [] })
    seed(cachedEntry())
    const [o] = await plur.refreshServerScopes()
    expect(o).toMatchObject({ status: 'degraded', applied: false })
    expect(rawConfig().stores[0].scopes).toEqual(['user:acme:alice', 'group:acme/team'])
    expect(rawConfig().stores[0].discovery.discovered_at).toBe('2026-10-16T12:00:00Z')
  })

  it('not_synced keeps a non-empty cache', async () => {
    stub.setMe({ scopes_status: 'not_synced', scopes: [] })
    seed(cachedEntry())
    const [o] = await plur.refreshServerScopes()
    expect(o).toMatchObject({ status: 'not_synced', applied: false })
    expect(rawConfig().stores[0].scopes).toEqual(['user:acme:alice', 'group:acme/team'])
  })

  it('one server failing does not affect another', async () => {
    const second = new StubServer('t-two')
    const { url: url2 } = await second.start()
    try {
      second.setMe({ ...OK_ME, scopes: ['user:acme:alice', 'group:acme/ops'] })
      stub.meStatus = 503
      seed(cachedEntry() + `  - url: ${url2}\n    token: t-two\n    enterprise: {}\n    scopes: []\n`)
      const out = await plur.refreshServerScopes()
      // the second server's personal scope is the same as the first's cached one
      expect(out.map(o => o.status)).toEqual(['failed', 'ok'])
      expect(rawConfig().stores[1].scopes).toEqual(['group:acme/ops'])
      expect(rawConfig().stores[0].scopes).toEqual(['user:acme:alice', 'group:acme/team'])
    } finally {
      await second.stop()
    }
  })
})

describe('refreshServerScopes — what it never touches', () => {
  it('enterprise.hello_engram_id is untouched by a refresh', async () => {
    seed(serverEntry())
    await plur.refreshServerScopes()
    expect(rawConfig().stores[0].enterprise).toEqual({ hello_engram_id: 'ENG-1' })
  })

  it('a hand-registered scope /me does not list stays, pinned, with a warning', async () => {
    const warn = vi.spyOn(logger, 'warning')
    seed(serverEntry('    pinned_scopes: ["group:acme/legacy"]\n'))
    const [o] = await plur.refreshServerScopes()
    expect(o.pinned_unlisted).toEqual(['group:acme/legacy'])
    expect(rawConfig().stores[0].pinned_scopes).toEqual(['group:acme/legacy'])
    expect((await plur.listStores()).map(s => s.scope)).toContain('group:acme/legacy')
    const pinnedWarnings = () => warn.mock.calls.filter(c => String(c[0]).includes('group:acme/legacy')).length
    expect(pinnedWarnings()).toBe(1)
    await plur.refreshServerScopes()
    expect(pinnedWarnings()).toBe(1)   // logged once
  })

  it('legacy per-scope entries are not touched by refreshServerScopes', async () => {
    seed(`stores:\n  - url: ${url}\n    token: ${TOKEN}\n    scope: group:acme/team\n`)
    const before = readFileSync(configPath(), 'utf8')
    expect(await plur.refreshServerScopes()).toEqual([])
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
    expect(stub.meCalls).toBe(0)
  })

  it('opts.url restricts the refresh to that server', async () => {
    seed(serverEntry())
    expect(await plur.refreshServerScopes({ url: 'https://elsewhere.example.com' })).toEqual([])
    expect(rawConfig().stores[0].scopes).toEqual([])
  })

  it('metadata unavailable does not erase scope_settings', async () => {
    stub.setMe({ scope_metadata_status: 'unavailable', scopes: ['user:acme:alice', 'group:acme/team'] })
    seed(serverEntry('    scope_settings:\n      group:acme/team: { description: "Team-wide", covers: ["acme.team"] }\n'))
    await plur.refreshServerScopes()
    expect(rawConfig().stores[0].scope_settings).toEqual({ 'group:acme/team': { description: 'Team-wide', covers: ['acme.team'] } })
  })

  it('metadata ok lands in scope_settings', async () => {
    stub.setMe({
      scopes: ['user:acme:alice', 'group:acme/team'],
      scope_metadata: [{ scope: 'group:acme/team', description: 'The team', covers: ['acme.team.web'] }],
    })
    seed(serverEntry())
    await plur.refreshServerScopes()
    const raw = rawConfig().stores[0]
    expect(raw.scope_settings['group:acme/team']).toMatchObject({ description: 'The team', covers: ['acme.team.web'] })
    expect(raw.stores).toBeUndefined()
    expect(rawConfig().stores).toHaveLength(1)
  })
})
