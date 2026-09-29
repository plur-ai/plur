import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

/**
 * #1264 — a learn to a shared scope with no matching url store falls through
 * to the local primary write. That is by design (nothing is auto-routed into a
 * shared scope), but it happened silently: an enterprise deployment reported
 * engrams that were created and never left the laptop. Every learn result now
 * says where it went — `remote`, `outbox` or `local` — and a shared scope that
 * lands `local` carries a warning naming the scope.
 */
const TEAM = 'group:example/eng'
const URL = 'https://store.example.test/sse'

function writeStoresConfig(dir: string, stores: Array<Record<string, unknown>>) {
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }))
}

function localStatements(dir: string): Array<{ statement: string; structured_data?: Record<string, unknown> }> {
  const doc = yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf-8')) as { engrams: any[] }
  return doc.engrams
}

describe('learn delivery (#1264)', () => {
  let dir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-delivery-'))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  function mockRemote(postOk: boolean) {
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return postOk
          ? ({ ok: true, status: 201, json: async () => ({ id: 'ENG-2026-09-28-900' }), text: async () => '' } as Response)
          : ({ ok: false, status: 500, json: async () => ({ error: 'boom' }), text: async () => 'boom' } as Response)
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
    }) as any)
  }

  describe('shared scope with no matching url store', () => {
    it('learn() reports local and warns, naming the scope', async () => {
      const plur = new Plur({ path: dir })
      const e = await plur.learn('team fact with nowhere to go', { scope: TEAM, type: 'behavioral' })
      const d = plur.deliveryOf(e)
      expect(d.delivery).toBe('local')
      expect(d.warning).toBeDefined()
      expect(d.warning).toContain(TEAM)
      expect(d.warning).toMatch(/store/i)
    })

    it('learnRouted() reports local and warns', async () => {
      const plur = new Plur({ path: dir })
      const e = await plur.learnRouted('another team fact with nowhere to go', { scope: TEAM, type: 'behavioral' })
      const d = plur.deliveryOf(e)
      expect(d.delivery).toBe('local')
      expect(d.warning).toContain(TEAM)
    })

    it('warns when the only store for the scope is a different scope', async () => {
      writeStoresConfig(dir, [{ url: URL, token: 't', scope: 'group:example/other', shared: true, readonly: false }])
      mockRemote(true)
      const plur = new Plur({ path: dir })
      const e = await plur.learnRouted('fact aimed at an unregistered team', { scope: TEAM, type: 'behavioral' })
      const d = plur.deliveryOf(e)
      expect(d.delivery).toBe('local')
      expect(d.warning).toContain(TEAM)
    })

    it('warns when the matching store is read-only', async () => {
      writeStoresConfig(dir, [{ url: URL, token: 't', scope: TEAM, shared: true, readonly: true }])
      mockRemote(true)
      const plur = new Plur({ path: dir })
      const e = await plur.learnRouted('fact aimed at a read-only store', { scope: TEAM, type: 'behavioral' })
      const d = plur.deliveryOf(e)
      expect(d.delivery).toBe('local')
      expect(d.warning).toContain(TEAM)
      expect(d.warning).toMatch(/read-only/i)
    })

    it('does not change where the engram is written, and persists no delivery marker', async () => {
      const plur = new Plur({ path: dir })
      await plur.learn('team fact stays exactly where it always went', { scope: TEAM, type: 'behavioral' })
      const found = localStatements(dir).find(x => x.statement === 'team fact stays exactly where it always went')
      expect(found).toBeDefined()
      expect((found as any).scope).toBe(TEAM)
      expect(JSON.stringify(found)).not.toMatch(/delivery/)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('shared scope with a matching writable url store', () => {
    it('learnRouted() reports remote when the store accepts the write', async () => {
      writeStoresConfig(dir, [{ url: URL, token: 't', scope: TEAM, shared: true, readonly: false }])
      mockRemote(true)
      const plur = new Plur({ path: dir })
      const e = await plur.learnRouted('team fact that reaches the store', { scope: TEAM, type: 'behavioral' })
      const d = plur.deliveryOf(e)
      expect(d.delivery).toBe('remote')
      expect(d.warning).toBeUndefined()
    })

    it('learnRouted() reports outbox when the push fails and is queued', async () => {
      writeStoresConfig(dir, [{ url: URL, token: 't', scope: TEAM, shared: true, readonly: false }])
      mockRemote(false)
      const plur = new Plur({ path: dir })
      const e = await plur.learnRouted('team fact queued for retry', { scope: TEAM, type: 'behavioral' })
      const d = plur.deliveryOf(e)
      expect(d.delivery).toBe('outbox')
      expect(d.warning).toBeUndefined()
    })

    it('learn() reports outbox — its push is deferred to the background', async () => {
      writeStoresConfig(dir, [{ url: URL, token: 't', scope: TEAM, shared: true, readonly: false }])
      mockRemote(true)
      const plur = new Plur({ path: dir })
      const e = await plur.learn('team fact pushed later', { scope: TEAM, type: 'behavioral' })
      await new Promise(r => setTimeout(r, 30))
      const d = plur.deliveryOf(e)
      expect(d.delivery).toBe('outbox')
      expect(d.warning).toBeUndefined()
    })
  })

  describe('non-shared scope', () => {
    for (const scope of ['global', 'local', 'user:alice']) {
      it(`${scope} reports local with no warning`, async () => {
        const plur = new Plur({ path: dir })
        const e = await plur.learnRouted(`personal fact at ${scope}`, { scope, type: 'behavioral' })
        const d = plur.deliveryOf(e)
        expect(d.delivery).toBe('local')
        expect(d.warning).toBeUndefined()
      })
    }
  })

  // Audit F8 (2026-09-29): when a save to shared scope B came back as an
  // engram in another scope — absorbed into team A's engram, or into a
  // `global` one — the warning named A (the scope NOT written to), or there
  // was no warning at all. The requested scope is what the user must hear.
  describe('the save came back as an engram in a different scope (F8)', () => {
    const OPS = 'group:example/ops'

    it('absorbed into another team scope: the warning names the scope asked for', async () => {
      const plur = new Plur({ path: dir })
      await plur.learn('canary before every deploy', { scope: TEAM })
      const e = await plur.learnRouted('canary before every deploy', { scope: OPS })
      const d = plur.deliveryOf(e, OPS)
      expect(d.delivery).toBe('local')
      expect(d.warning).toContain(OPS)
      if (e.scope !== OPS) expect(d.warning).toContain(`"${e.scope}"`)
    })

    it('came back as a global engram: warns instead of staying silent', async () => {
      const plur = new Plur({ path: dir })
      await plur.learn('document breaking changes', { scope: 'project:a' })
      await plur.learn('document breaking changes', { scope: 'project:b' })
      const e = await plur.learnRouted('document breaking changes', { scope: OPS })
      const d = plur.deliveryOf(e, OPS)
      if (e.scope !== OPS) {
        expect(d.delivery).toBe('local')
        expect(d.warning).toContain(OPS)
        expect(d.warning).toContain(`"${e.scope}"`)
      }
    })

    it('a save that landed where it was asked gets no extra warning', async () => {
      const plur = new Plur({ path: dir })
      const e = await plur.learn('my own preference', { scope: 'global' })
      expect(plur.deliveryOf(e, 'global').warning).toBeUndefined()
    })
  })

  // Formal replay (field-report cluster 1, WritePath §7): with a url store and
  // a path store registered for the SAME scope (url first — both load, as the
  // duplicate-scope loader keeps different stores with one scope), a dedup hit
  // on the PATH store's row was reported `remote` because the scope's first
  // store entry had a url. Nothing was POSTed; the row lives in a local file.
  describe('a hit is classified by the store that served its row', () => {
    const mockNoPost = (posts: unknown[]) => {
      fetchMock.mockImplementation((async (_u: string, init?: { method?: string; body?: string }) => {
        if ((init?.method ?? 'GET') === 'POST') { posts.push(init?.body); throw new Error('must not POST') }
        return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
      }) as any)
    }

    it('a dedup hit on a local path-store row is not reported remote (url store listed first)', async () => {
      const teamDir = mkdtempSync(join(tmpdir(), 'plur-delivery-team-'))
      try {
        await new Plur({ path: teamDir }).learn('page the on-call before a schema migration', { scope: TEAM })
        const posts: unknown[] = []
        mockNoPost(posts)
        writeStoresConfig(dir, [
          { url: URL, token: 't', scope: TEAM, shared: true, readonly: false },
          { path: join(teamDir, 'engrams.yaml'), scope: TEAM, shared: true },
        ])
        const plur = new Plur({ path: dir })
        const e = await plur.learn('page the on-call before a schema migration', { scope: TEAM })
        expect((e as any)._storeScope, 'fixture: the hit is the path-store row').toBe(TEAM)
        expect(posts).toHaveLength(0)
        expect(plur.deliveryOf(e, TEAM).delivery).not.toBe('remote')
      } finally { rmSync(teamDir, { recursive: true, force: true }) }
    })

    it('the same with the path store listed first', async () => {
      const teamDir = mkdtempSync(join(tmpdir(), 'plur-delivery-team-'))
      try {
        await new Plur({ path: teamDir }).learn('page the on-call before a schema migration', { scope: TEAM })
        const posts: unknown[] = []
        mockNoPost(posts)
        writeStoresConfig(dir, [
          { path: join(teamDir, 'engrams.yaml'), scope: TEAM, shared: true },
          { url: URL, token: 't', scope: TEAM, shared: true, readonly: false },
        ])
        const plur = new Plur({ path: dir })
        const e = await plur.learn('page the on-call before a schema migration', { scope: TEAM })
        expect((e as any)._storeScope).toBe(TEAM)
        expect(plur.deliveryOf(e, TEAM).delivery).not.toBe('remote')
      } finally { rmSync(teamDir, { recursive: true, force: true }) }
    })
  })

  it('a duplicate of a local shared-scope engram still reports local and warns', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('team fact written twice', { scope: TEAM, type: 'behavioral' })
    const again = await plur.learnRouted('team fact written twice', { scope: TEAM, type: 'behavioral' })
    const d = plur.deliveryOf(again)
    expect(d.delivery).toBe('local')
    expect(d.warning).toContain(TEAM)
  })
})
