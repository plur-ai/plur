/**
 * Audit of #1228, UNCONFIRMED item "storePrefix collisions" — replayed here.
 *
 * `storePrefix` is three letters, so two store scopes can share one
 * (group:plur/eng and group:plur/ops are both GPL). A namespaced id then names
 * BOTH stores, and ids collide across stores as the common case (each store
 * has its own daily sequence). Before the fix:
 *   - updateEngram of store B's engram ran store A's guard (A's stricter
 *     policy refused it) and PATCHed A first — B's content sent to A;
 *   - a same-scope re-learn of store B's path-store row recorded the
 *     recurrence on store A's row that happened to have the same bare id.
 * Fix: disambiguate on the full store scope — the row's `_storeScope` (the
 * loader's stamp) and, failing that, the store whose scope contains the
 * row's scope.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import yaml from 'js-yaml'
import { Plur, computeContentHash } from '../src/index.js'
import { storePrefix } from '../src/engrams.js'

const ENG = 'group:plur/eng'
const OPS = 'group:plur/ops'
const INFRA = 'The staging box answers on 10.1.2.3:8080'

function row(id: string, scope: string, statement: string) {
  return {
    id, version: 2, status: 'active', consolidated: false, type: 'behavioral',
    scope, visibility: 'public', statement,
    activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-09-01' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    associations: [], derivation_count: 1, tags: [], pack: null, abstract: null,
    derived_from: null, reference_count: 1, sources: [],
    content_hash: computeContentHash(statement),
  }
}

describe('audit #1228 — two stores sharing a storePrefix', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    expect(storePrefix(ENG)).toBe(storePrefix(OPS))
    dir = mkdtempSync(join(tmpdir(), 'plur-audit-collide-'))
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  describe('remote stores: updateEngram', () => {
    let patches: string[]
    beforeEach(() => {
      patches = []
      globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? 'GET'
        const ok = (body: unknown, status = 200) =>
          ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
        if (method === 'PATCH') {
          patches.push(new URL(String(url)).host)
          const id = decodeURIComponent(String(url).split('/engrams/')[1] ?? '')
          // Both stores hold a row with this server id (per-store sequences).
          return ok({ engram: { id, scope: String(url).startsWith('https://a.') ? ENG : OPS, status: 'active', data: { statement: 'x', type: 'behavioral' } } })
        }
        return ok({ rows: [], total_count: 0 })
      }) as never
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({
        stores: [
          { url: 'https://a.example.com/sse', token: 'ta', scope: ENG, shared: true, readonly: false, sensitivity: { forbid: ['secrets', 'infra'] } },
          { url: 'https://b.example.com/sse', token: 'tb', scope: OPS, shared: true, readonly: false, sensitivity: { forbid: ['secrets'], allow: ['infra'] } },
        ],
        index: false,
      }))
    })

    const opsEngram = (extra: Record<string, unknown> = {}) =>
      ({ id: `ENG-${storePrefix(OPS)}-2026-09-26-001`, statement: INFRA, type: 'behavioral', scope: OPS, status: 'active', ...extra }) as any

    it('store A\'s stricter policy does not refuse an update of store B\'s engram', async () => {
      const plur = new Plur({ path: dir })
      await expect(plur.updateEngram(opsEngram())).resolves.toBe(true)
    })

    it('store A never receives the PATCH for store B\'s engram (by row scope)', async () => {
      const plur = new Plur({ path: dir })
      await plur.updateEngram(opsEngram())
      expect(patches).toEqual(['b.example.com'])
    })

    it('the loader stamp `_storeScope` names the store too', async () => {
      const plur = new Plur({ path: dir })
      await plur.updateEngram(opsEngram({ _storeScope: OPS }))
      expect(patches).toEqual(['b.example.com'])
    })
  })

  describe('path stores: recurrence lands on the right row', () => {
    let engPath: string
    let opsPath: string
    const BARE = 'ENG-2026-09-01-001'
    beforeEach(() => {
      engPath = join(dir, 'eng.yaml')
      opsPath = join(dir, 'ops.yaml')
      writeFileSync(engPath, yaml.dump({ engrams: [row(BARE, ENG, 'the engineering team deploys on tuesdays only')] }))
      writeFileSync(opsPath, yaml.dump({ engrams: [row(BARE, OPS, 'the ops rota changes every monday morning')] }))
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({
        stores: [
          { path: engPath, scope: ENG, readonly: false },
          { path: opsPath, scope: OPS, readonly: false },
        ],
        index: false,
      }))
    })
    const load = (p: string) => (yaml.load(readFileSync(p, 'utf8')) as { engrams: any[] }).engrams

    it('a re-learn of store B\'s row counts against B, and store A\'s row is untouched', async () => {
      const before = load(engPath)
      const plur = new Plur({ path: dir })
      await plur.learn('the ops rota changes every monday morning', { scope: OPS, type: 'behavioral' })
      expect(load(engPath), 'store A\'s unrelated row was written').toEqual(before)
      expect(load(opsPath)[0].write_count).toBe(2)
    })
  })
})
