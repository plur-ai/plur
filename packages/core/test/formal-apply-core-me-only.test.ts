/**
 * Decision E1 "me-only" (owner, 2026-09-26; principle "egress": auto-route may
 * reach the user's OWN personal remote store, never a team store).
 *
 * An unscoped write may auto-route into a REMOTE-backed personal scope only
 * when that scope is the user's own namespace as reported by the remote's
 * `/me` identity. Any other url-backed personal scope is refused exactly like a
 * shared scope (reported through `_routeRefused` / `refusedShared`). Unknown
 * identity (never fetched, offline) → refuse (fail closed). Path-backed
 * personal routing is unchanged; `allow_shared_auto_route` governs shared
 * scopes only; `previewAutoRoute` (plur_suggest_scope) reports the same.
 *
 * Fake remote via mocked fetch; nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, decideAutoRoute } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'
const COVERS = ['plur.*', 'embeddings']

describe('Decision E1 — auto-route into a url-backed personal scope only for the /me namespace', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let posts: Array<Record<string, unknown>>
  let me: { username: string; org_id: string } | null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-apply-meonly-'))
    originalFetch = globalThis.fetch
    posts = []
    me = { username: 'me', org_id: 'acme' }
    globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && String(url).endsWith('/me')) {
        if (!me) throw new Error('fetch failed')
        return { ok: true, status: 200, json: async () => ({ ...me, role: 'developer', scopes: [] }), text: async () => '' } as unknown as Response
      }
      if (method === 'POST') {
        posts.push(JSON.parse(String(init?.body ?? '{}')))
        return { ok: true, status: 201, json: async () => ({ id: `SRV-${posts.length}` }), text: async () => '' } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as unknown as Response
    }) as never
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const config = (stores: unknown[], extra: Record<string, unknown> = {}) =>
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores, index: false, unscoped_default: 'local', ...extra }))
  const urlStore = (scope: string) =>
    ({ url: REMOTE, token: 'tok', scope, shared: false, readonly: false, description: 'personal', covers: COVERS })
  const write = (plur: Plur) =>
    plur.learnRouted('embeddings are computed locally with bge-small', { type: 'behavioral', domain: 'plur.engineering.embeddings' })

  it('unknown /me identity (never fetched) → refused, fails closed, nothing POSTed', async () => {
    config([urlStore('user:me')])
    const plur = new Plur({ path: dir })
    const e = await write(plur)
    expect(e.scope).toBe('local')
    expect(posts).toHaveLength(0)
    expect((e.structured_data as any)?._routeRefused?.scope).toBe('user:me')
    expect(plur.previewAutoRoute({ statement: 'x', domain: 'plur.engineering.embeddings' }).action).toBe('refuse-shared')
  })

  it('/me unreachable → still refused', async () => {
    config([urlStore('user:me')])
    me = null
    const plur = new Plur({ path: dir })
    await plur.discoverRemoteScopes()
    const e = await write(plur)
    expect(e.scope).toBe('local')
    expect(posts).toHaveLength(0)
  })

  it.each(['user:me', 'user:acme:me'])('the user\'s own /me namespace (%s) routes and is POSTed', async scope => {
    config([urlStore(scope)])
    const plur = new Plur({ path: dir })
    await plur.discoverRemoteScopes()
    const preview = plur.previewAutoRoute({ statement: 'x', domain: 'plur.engineering.embeddings' })
    expect(preview.action).toBe('route')
    expect(preview.scope).toBe(scope)
    const e = await write(plur)
    expect(e.scope).toBe(scope)
    expect(posts).toHaveLength(1)
    expect(posts[0].scope_source).toBe('routed')
  })

  it('a server-declared personal namespace that is not the user\'s own → refused like shared', async () => {
    config([urlStore('user:alice')])
    const plur = new Plur({ path: dir })
    await plur.discoverRemoteScopes()
    const e = await write(plur)
    expect(e.scope).toBe('local')
    expect(posts).toHaveLength(0)
    expect((e.structured_data as any)?._routeRefused?.scope).toBe('user:alice')
    const preview = plur.previewAutoRoute({ statement: 'x', domain: 'plur.engineering.embeddings' })
    expect(preview.action).toBe('refuse-shared')
    expect(preview.refusedShared?.scope).toBe('user:alice')
  })

  it('agent:* url-backed scope is never the user\'s own namespace', async () => {
    config([urlStore('agent:me')])
    const plur = new Plur({ path: dir })
    await plur.discoverRemoteScopes()
    const e = await write(plur)
    expect(e.scope).toBe('local')
    expect(posts).toHaveLength(0)
  })

  it('allow_shared_auto_route does not unlock a foreign personal namespace', async () => {
    config([urlStore('user:alice')], { scope_routing: { allow_shared_auto_route: true } })
    const plur = new Plur({ path: dir })
    await plur.discoverRemoteScopes()
    const e = await write(plur)
    expect(e.scope).toBe('local')
    expect(posts).toHaveLength(0)
  })

  it('path-backed personal routing is unchanged', async () => {
    config([{ path: join(dir, 'alice.yaml'), scope: 'user:alice', shared: false, readonly: false, description: 'p', covers: COVERS }])
    const plur = new Plur({ path: dir })
    const e = await write(plur)
    expect(e.scope).toBe('user:alice')
  })

  it('decideAutoRoute: the refusal predicate refuses a personal candidate the same way as shared', () => {
    const cand = { scope: 'user:alice', confidence: 0.9, reason: 'domain', coverContainsDomain: true } as any
    const d = decideAutoRoute([cand], { refuseScope: s => s === 'user:alice' })
    expect(d.action).toBe('refuse-shared')
    expect(d.refusedShared?.scope).toBe('user:alice')
    expect(decideAutoRoute([cand]).action).toBe('route')
  })
})
