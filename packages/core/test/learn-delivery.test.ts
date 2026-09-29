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

  it('a duplicate of a local shared-scope engram still reports local and warns', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('team fact written twice', { scope: TEAM, type: 'behavioral' })
    const again = await plur.learnRouted('team fact written twice', { scope: TEAM, type: 'behavioral' })
    const d = plur.deliveryOf(again)
    expect(d.delivery).toBe('local')
    expect(d.warning).toContain(TEAM)
  })
})
