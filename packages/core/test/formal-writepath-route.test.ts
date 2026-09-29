/**
 * Formal-verification replay (spec/formal/PlurSpec/WritePath.lean, candidate 3):
 * auto-route + leak-guard pipeline, and the `scope_source` wire field.
 *
 *  - An unscoped write auto-routes into a URL-backed PERSONAL scope (user:*),
 *    which leaves the machine. #1115 refused only SHARED scopes; decision E1
 *    (me-only, 2026-09-26) refuses it unless /me names it the user's own.
 *  - `scope_source` is read from caller-settable `structured_data._scopeSource`
 *    and was forwarded as ANY string. It must be one of the four ScopeSource
 *    values or be omitted.
 *
 * Fake remote via mocked fetch; nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'

describe('formal WritePath — routing pipeline and scope_source (candidate 3)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let posts: Array<Record<string, unknown>>
  let fail: boolean

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-route-'))
    originalFetch = globalThis.fetch
    posts = []
    fail = false
    globalThis.fetch = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        if (fail) throw new Error('fetch failed')
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

  const rowOf = (id: string): any => {
    const p = join(dir, 'engrams.yaml')
    if (!existsSync(p)) return undefined
    const doc = yaml.load(readFileSync(p, 'utf8')) as { engrams?: any[] } | null
    return (doc?.engrams ?? []).find(e => e.id === id)
  }

  it('Decision E1 (me-only): an unscoped write does NOT auto-route into a url-backed personal scope whose /me identity is unknown', async () => {
    // Was "PINS current behaviour: … auto-routes … and is POSTed" (owner
    // decision pending, WP-Q4). The owner chose me-only: without a /me
    // identity naming this scope as the user's own, the candidate is refused
    // like a shared scope and the write stays on the unscoped default.
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: 'user:me', shared: false, readonly: false,
        description: 'Me', covers: ['plur.*', 'embeddings'] }],
      index: false,
    }))
    const plur = new Plur({ path: dir })
    const e = await plur.learnRouted('embeddings are computed locally with bge-small', {
      type: 'behavioral', domain: 'plur.engineering.embeddings',
    })
    expect(e.scope).not.toBe('user:me')
    expect(posts.length, 'the unscoped write left the machine').toBe(0)
    expect((e.structured_data as any)?._routeRefused?.scope).toBe('user:me')
  })

  it('scope_source outside the four ScopeSource values is not forwarded', async () => {
    const TEAM = 'group:acme/team'
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: TEAM, shared: true, readonly: false }],
      index: false,
    }))
    fail = true
    const plur = new Plur({ path: dir })
    const e = await plur.learn('a team fact queued while the store is down', { scope: TEAM, type: 'behavioral' })
    const deadline = Date.now() + 5000
    while (!rowOf(e.id)?.structured_data?._outbox?.last_error) {
      if (Date.now() > deadline) throw new Error('never queued')
      await new Promise(r => setTimeout(r, 5))
    }
    await new Promise(r => setTimeout(r, 30))
    const row = (await plur.getById(e.id))!
    ;(row as any).structured_data = { ...(row as any).structured_data, _scopeSource: 'approved-by-admin' }
    expect(await plur.updateEngram(row)).toBe(true)

    fail = false
    const res = await plur.flushOutbox()
    expect(res.flushed).toBe(1)
    expect(posts.length).toBe(1)
    expect(posts[0].scope_source, 'an arbitrary caller-set string rode the wire as scope_source').toBeUndefined()
  })

  it('good case: a valid scope_source is still forwarded', async () => {
    const TEAM = 'group:acme/team'
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: TEAM, shared: true, readonly: false }],
      index: false,
    }))
    const plur = new Plur({ path: dir })
    await plur.learnRouted('a team fact written with an explicit scope', { scope: TEAM, type: 'behavioral' })
    expect(posts.length).toBe(1)
    expect(posts[0].scope_source).toBe('explicit')
  })
})
