import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, ScopeConflictError } from '../src/index.js'

/**
 * #1631: write routing and the leak guard read ONE resolver
 * (`resolveScopeTarget`), through Plur. The remote side is a fetch mock that
 * counts engram POSTs per host and keeps every request body, so a test can
 * prove what did and did not leave the machine.
 */
const SERVER = 'https://plur.example.com'
const OTHER = 'https://other.example.com'
// Infra topology: the policy scan demotes it (a hard credential is refused outright).
const SECRET = 'db-prod.internal:5432'

function writeConfig(dir: string, stores: Array<Record<string, unknown>>) {
  const p = join(dir, 'config.yaml')
  writeFileSync(p, yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }))
  // A later mtime than any earlier write, so the next reload sees the change.
  const t = new Date(Date.now() + 5_000)
  utimesSync(p, t, t)
}

function localRows(dir: string): Array<{ statement: string; scope: string; structured_data?: Record<string, unknown> }> {
  const p = join(dir, 'engrams.yaml')
  if (!existsSync(p)) return []
  const doc = yaml.load(readFileSync(p, 'utf-8')) as { engrams?: any[] } | null
  return doc?.engrams ?? []
}

describe('routing through the shared resolver (#1631)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let posts: Array<{ host: string; body: string }>
  let bodies: string[]
  let failPosts: boolean

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-resolver-'))
    originalFetch = globalThis.fetch
    posts = []
    bodies = []
    failPosts = false
    globalThis.fetch = vi.fn(async (input: any, init?: { method?: string; body?: unknown }) => {
      const url = new URL(typeof input === 'string' ? input : input.url)
      const body = typeof init?.body === 'string' ? init.body : ''
      bodies.push(body)
      if ((init?.method ?? 'GET') === 'POST' && /\/engrams\/?$/.test(url.pathname)) {
        if (failPosts) return { ok: false, status: 503, json: async () => ({}), text: async () => 'down' } as Response
        posts.push({ host: url.host, body })
        return { ok: true, status: 201, json: async () => ({ id: 'ENG-2026-10-18-901' }), text: async () => '' } as Response
      }
      if (/\/me\/?$/.test(url.pathname)) {
        return { ok: true, status: 200, json: async () => ({ username: 'alice', org_id: 'acme', scopes: [] }), text: async () => '' } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], results: [], total_count: 0 }), text: async () => '' } as Response
    }) as any
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  describe('a scope two servers claim', () => {
    beforeEach(() => {
      writeConfig(dir, [
        { url: SERVER, token: 'a', scope: 'group:acme/team', shared: true, readonly: false },
        { url: OTHER, token: 'b', scope: 'group:acme/team', shared: true, readonly: false },
      ])
    })

    it('learnRouted is refused, nothing sent, nothing saved', async () => {
      const plur = new Plur({ path: dir })
      await expect(plur.learnRouted('x conflict routed', { scope: 'group:acme/team' }))
        .rejects.toThrow(/claimed by two servers.*plur\.example\.com.*other\.example\.com/)
      expect(posts).toHaveLength(0)
      expect(localRows(dir).some(r => r.statement === 'x conflict routed')).toBe(false)
    })

    it('learn is refused, nothing sent, nothing saved', async () => {
      const plur = new Plur({ path: dir })
      await expect(plur.learn('x conflict', { scope: 'group:acme/team' })).rejects.toBeInstanceOf(ScopeConflictError)
      await new Promise(r => setTimeout(r, 30))
      expect(posts).toHaveLength(0)
      expect(localRows(dir).some(r => r.statement === 'x conflict')).toBe(false)
    })

    it('a scope only one of them claims still routes', async () => {
      writeConfig(dir, [
        { url: SERVER, token: 'a', scope: 'group:acme/team', shared: true, readonly: false },
        { url: OTHER, token: 'b', scope: 'group:acme/other', shared: true, readonly: false },
      ])
      const plur = new Plur({ path: dir })
      await plur.learnRouted('x reaches one server', { scope: 'group:acme/team' })
      expect(posts.map(p => p.host)).toEqual(['plur.example.com'])
    })
  })

  describe('the secret scan runs before any save leaves the machine', () => {
    beforeEach(() => {
      writeConfig(dir, [{
        url: SERVER, token: 'a', scope: 'user:acme:alice',
        scopes: ['user:acme:alice', 'group:acme/team'],
        enterprise: {}, discovery: { status: 'ok', org_id: 'acme' },
      }])
    })

    for (const scope of ['user:acme:alice', 'group:acme/team']) {
      it(`a write to the discovered scope ${scope} with infra topology in it is demoted and never sent`, async () => {
        const plur = new Plur({ path: dir })
        const e = await plur.learnRouted(`the staging database is reachable at ${SECRET} from the bastion`, { scope })
        expect((e as any).structured_data?._demoted).toMatchObject({ from: scope, to: 'local' })
        expect(e.scope).toBe('local')
        await new Promise(r => setTimeout(r, 30))
        expect(posts).toHaveLength(0)
        expect(bodies.some(b => b.includes(SECRET))).toBe(false)
      })
    }

    it('a clean write to the discovered scope is sent to the server', async () => {
      const plur = new Plur({ path: dir })
      await plur.learnRouted('a harmless team fact', { scope: 'group:acme/team' })
      expect(posts.map(p => p.host)).toEqual(['plur.example.com'])
    })
  })

  it('#1473: a store added to config.yaml after construction is routed to on the next learn', async () => {
    const plur = new Plur({ path: dir })
    writeConfig(dir, [{ url: SERVER, token: 'a', scope: 'group:acme/team', shared: true, readonly: false }])
    await plur.learnRouted('routed after a config edit', { scope: 'group:acme/team' })
    expect(posts.map(p => p.host)).toEqual(['plur.example.com'])
  })

  it('deliveryOf names the server for an unauthorized scope', async () => {
    writeConfig(dir, [{
      url: SERVER, token: 'a', scope: 'user:acme:alice',
      scopes: ['user:acme:alice', 'group:acme/team'],
      enterprise: {}, discovery: { status: 'ok', org_id: 'acme' },
    }])
    const plur = new Plur({ path: dir })
    const e = await plur.learnRouted('a fact for a project I was not granted', { scope: 'project:acme/other' })
    expect(posts).toHaveLength(0)
    const d = plur.deliveryOf(e)
    expect(d.delivery).toBe('local')
    expect(d.warning).toBe(
      'Scope "project:acme/other" is not granted to you on https://plur.example.com; this engram was saved on this machine only.',
    )
  })
  it('a queued save whose scope a second server now claims is not flushed to either', async () => {
    writeConfig(dir, [{ url: SERVER, token: 'a', scope: 'group:acme/team', shared: true, readonly: false }])
    failPosts = true
    const plur = new Plur({ path: dir })
    await plur.learnRouted('queued while the server was down', { scope: 'group:acme/team' })
    const row = localRows(dir).find(r => r.statement === 'queued while the server was down')
    expect(row?.structured_data?._outbox).toBeTruthy()
    failPosts = false
    writeConfig(dir, [
      { url: OTHER, token: 'b', scope: 'group:acme/team', shared: true, readonly: false },
      { url: SERVER, token: 'a', scope: 'group:acme/team', shared: true, readonly: false },
    ])
    const r = await plur.flushOutbox({ force: true })
    expect(posts).toHaveLength(0)
    expect(r.flushed).toBe(0)
    expect(r.expired_warnings.join('\n')).toMatch(/claimed by two servers.*other\.example\.com.*plur\.example\.com.*stays queued/)
    // still queued: nothing was dropped
    expect(localRows(dir).find(x => x.statement === 'queued while the server was down')?.structured_data?._outbox).toBeTruthy()
  })
})
