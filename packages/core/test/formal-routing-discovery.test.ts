/**
 * Formal RoutingDiscovery (spec/formal/PlurSpec/RoutingDiscovery.lean,
 * spec/formal/findings/routing-discovery.md).
 *
 *   - D4: refreshServerScopes applies a /me answer to the server entry it was
 *     asked with. Two server entries on one url (another key) cannot be told
 *     apart in the locked write, so neither is written and both answers are
 *     reported `failed` (as rotation and owner decision 17 refuse an ambiguous
 *     entry). Before the fix the second key's answer overwrote the first
 *     entry: its token stayed, its scopes and personal `scope` became the
 *     other user's.
 *   - Pure decision rules the model proves, pinned as examples.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, ScopeConflictError } from '../src/index.js'
import { resolveScopeTarget } from '../src/store-resolver.js'
import { acceptDiscoveredScopes } from '../src/server-discovery.js'
import type { MeResponse } from '../src/store/remote-store.js'

const SERVER = 'https://plur.example.com'

describe('refreshServerScopes — two server entries on one url (D4)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-frd-'))
    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      const url = new URL(typeof input === 'string' ? input : input.url)
      const h = init?.headers ?? {}
      const auth = String(h.Authorization ?? h.authorization ?? '')
      if (/\/me\/?$/.test(url.pathname)) {
        const who = auth.includes('t-bob') ? 'bob' : 'alice'
        const body = {
          username: who, org_id: 'acme', role: 'developer',
          scopes: [`user:acme:${who}`, `group:acme/${who}-team`],
          scopes_status: 'ok', scope_metadata_status: 'absent', scope_metadata: [], capabilities: [],
        }
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], results: [] }), text: async () => '' } as Response
    }) as any
  })
  afterEach(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

  const cfg = (stores: unknown[]) => writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, stores }))
  const disk = (): any[] => (yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any).stores

  it('neither entry is written and both outcomes are failed', async () => {
    cfg([
      { url: SERVER, token: 't-alice', scopes: [], enterprise: {} },
      { url: `${SERVER}/sse`, token: 't-bob', scopes: [], enterprise: {} },
    ])
    const before = readFileSync(join(dir, 'config.yaml'), 'utf8')
    const out = await new Plur({ path: dir }).refreshServerScopes()
    expect(out.map(o => [o.status, o.applied])).toEqual([['failed', false], ['failed', false]])
    expect(out[0].error).toMatch(/more than one server entry/)
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(before)
  })

  it('one entry per url is still refreshed (the good case)', async () => {
    cfg([{ url: SERVER, token: 't-bob', scopes: [], enterprise: {} }])
    const [o] = await new Plur({ path: dir }).refreshServerScopes()
    expect(o).toMatchObject({ status: 'ok', applied: true, username: 'bob' })
    expect(disk().map(s => [s.token, s.scope, s.scopes])).toEqual([
      ['t-bob', 'user:acme:bob', ['user:acme:bob', 'group:acme/bob-team']],
    ])
  })
})

describe('updateEngram moving a queued row into a scope two servers claim (D6)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let posts: string[]
  let failPosts: boolean
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-frd-up-'))
    originalFetch = globalThis.fetch
    posts = []; failPosts = true
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      const url = new URL(typeof input === 'string' ? input : input.url)
      if ((init?.method ?? 'GET') === 'POST' && /\/engrams\/?$/.test(url.pathname)) {
        if (failPosts) return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' } as Response
        posts.push(url.host)
        return { ok: true, status: 201, json: async () => ({ id: 'ENG-2026-10-18-902' }), text: async () => '' } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], results: [], total_count: 0 }), text: async () => '' } as Response
    }) as any
  })
  afterEach(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })
  const rows = (): any[] => ((yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as any)?.engrams ?? [])

  it('is refused, and the row stays queued for its old server and scope', async () => {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, stores: [
      { url: SERVER, token: 'a', scope: 'group:acme/a', shared: true, readonly: false },
      { url: 'https://other.example.com', token: 'b', scope: 'group:acme/team', shared: true, readonly: false },
      { url: SERVER, token: 'a', scope: 'group:acme/team', shared: true, readonly: false },
    ] }))
    const plur = new Plur({ path: dir })
    await plur.learnRouted('queued then moved', { scope: 'group:acme/a' })
    const row = rows().find(r => r.statement === 'queued then moved')
    expect(row?.structured_data?._outbox?.target_scope).toBe('group:acme/a')
    await expect(plur.updateEngram({ ...row, scope: 'group:acme/team' })).rejects.toBeInstanceOf(ScopeConflictError)
    const after = rows().find(r => r.statement === 'queued then moved')
    expect(after.scope).toBe('group:acme/a')
    expect(after.structured_data._outbox).toMatchObject({ target_scope: 'group:acme/a', target_url: SERVER })
    expect(posts).toHaveLength(0)
  })
})

describe('resolveScopeTarget — rules the model proves (examples)', () => {
  const A = { url: SERVER, token: 'a', scope: 'group:acme/team', readonly: false } as any
  const B = { url: 'https://other.example.com', token: 'b', scope: 'group:acme/team', readonly: false } as any
  it('a readonly entry listed first: the write goes through the writable one of the same server', () => {
    const ro = { ...A, readonly: true }
    expect(resolveScopeTarget(A.scope, [ro, A])).toEqual({ kind: 'remote', entry: A, writable: true })
  })
  it('conflict outranks the enterprise org rule and a path store', () => {
    const E = { ...A, scope: 'user:acme:alice', enterprise: {}, discovery: { org_id: 'acme' } }
    const P = { path: '/tmp/x.yaml', scope: 'group:acme/team' } as any
    expect(resolveScopeTarget('group:acme/team', [P, E, A, B]).kind).toBe('conflict')
  })
  it('a personal scope two servers claim answers the first writable one (#1515 selection, not conflict)', () => {
    const a = { ...A, scope: 'user:acme:alice' }
    const b = { ...B, scope: 'user:acme:alice' }
    expect(resolveScopeTarget('user:acme:alice', [a, b])).toEqual({ kind: 'remote', entry: a, writable: true })
  })
})

describe('acceptDiscoveredScopes — accepted scopes stay inside the org (examples)', () => {
  const me = (o: Partial<MeResponse>): MeResponse => ({
    username: 'alice', org_id: 'acme', role: 'developer', scopes: [], scope_metadata: [], capabilities: [],
    scopes_status: 'ok', scope_metadata_status: 'ok', gitlab_host: null, project_paths: {}, key_expires_at: undefined, ...o,
  })
  it('a look-alike org, a deeper personal scope and a case-changed kind are refused', () => {
    const r = acceptDiscoveredScopes({
      me: me({ scopes: ['group:acme/x', 'group:acme-evil/x', 'group:acme:x', 'user:acme:alice:x', 'Group:acme/x', 'org:acme', 'org:acme/x'] }),
      cached: [], otherServersScopes: new Map(),
    })
    expect(r.scopes).toEqual(['group:acme/x', 'org:acme'])
  })
  it('an ok answer whose every scope is refused still replaces the cache, with [] (the plan table)', () => {
    const r = acceptDiscoveredScopes({ me: me({ scopes: ['group:other/x'] }), cached: ['group:acme/x'], otherServersScopes: new Map() })
    expect(r).toMatchObject({ status: 'ok', replaceCache: true, scopes: [] })
  })
})
