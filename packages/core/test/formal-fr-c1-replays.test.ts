/**
 * Formal-verification replays, field-report cluster 1 (write path + core).
 * Models: spec/formal/PlurSpec/R2CoreA.lean §9 and WritePath.lean §5b/§7.
 * Findings: spec/formal/findings/r2-corea.md and writepath.md ("field report").
 *
 * `it.fails` marks a CONFIRMED defect: the body asserts the intended behaviour
 * and fails on the current code. When the owning PR fixes it, vitest reports
 * the test as unexpectedly passing — drop `.fails` then.
 * Plain `it` pins a property the model proves (the good case is reachable).
 *
 * Temp dirs only; fetch is stubbed, no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { runImport } from '../src/importers/engine.js'

const ENG = 'group:example/eng'
const URL = 'https://store.example.test/sse'

describe('formal field-report cluster 1 — replays', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-fr-c1-'))
    originalFetch = globalThis.fetch
    // Any unexpected network call fails loudly.
    globalThis.fetch = vi.fn(async () => { throw new Error('no network in this test') }) as any
  })
  afterEach(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

  const file = () => join(dir, 'engrams.yaml')
  const rows = (): any[] => (yaml.load(readFileSync(file(), 'utf8')) as any)?.engrams ?? []
  const patchRow = (id: string, patch: Record<string, unknown>) => {
    const doc = yaml.load(readFileSync(file(), 'utf8')) as any
    const r = doc.engrams.find((e: any) => e.id === id)
    Object.assign(r, patch)
    writeFileSync(file(), yaml.dump(doc, { lineWidth: 200, noRefs: true }))
  }
  const tension = (a: string, b: string) => ({
    id: 'T-2026-0929-001', engram_a: a, engram_b: b, statement_a: 'x', statement_b: 'y',
    confidence: 0.9, reason: 'contradiction', detected_at: '2026-09-29T00:00:00.000Z',
    status: 'detected', resolved_by: null, resolved_at: null, category: 'factual',
  })
  const queuedStore = () => {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false, stores: [{ url: URL, token: 't', scope: ENG, shared: true, readonly: false }],
    }))
    globalThis.fetch = vi.fn(async (_u: string, init?: { method?: string }) => (
      (init?.method ?? 'GET') === 'POST'
        ? { ok: false, status: 500, json: async () => ({}), text: async () => 'down' }
        : { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' }
    ) as Response) as any
  }

  // ── A1 (R2CoreA §9a) ────────────────────────────────────────────────────
  describe('A1: a shared-scope save lands in its own scope', () => {
    it('learn(): proved good case — a shared save matching another scope gets its own row', async () => {
      const plur = new Plur({ path: dir })
      const a = await plur.learn('Run the linter before every commit', { scope: 'project:a' })
      const b = await plur.learn('Run the linter before every commit', { scope: 'project:b' })
      expect(b.id).not.toBe(a.id)
      expect(b.scope).toBe('project:b')
    })

    // CONFIRMED: wouldDeduplicate() still answers with a cross-scope hit for a
    // SHARED scope, although learn() writes the team copy (A1). The importer
    // asks it first (Decision R) and skips — the record never reaches project:b.
    it.fails('wouldDeduplicate() agrees with learn() for a shared scope (null: learn() writes a new row)', async () => {
      const plur = new Plur({ path: dir })
      await plur.learn('Run the linter before every commit', { scope: 'project:a' })
      expect(await plur.wouldDeduplicate('Run the linter before every commit', { scope: 'project:b' })).toBeNull()
    })

    it.fails('importer: a shared-scope record whose text exists in another scope is imported into its own scope', async () => {
      const plur = new Plur({ path: dir })
      await plur.learn('Run the linter before every commit', { scope: 'project:a' })
      const report = await runImport(plur, [{ statement: 'Run the linter before every commit' }], { from: 'generic', scope: 'project:b' })
      expect(report.imported).toBe(1)
      expect(rows().some(e => e.scope === 'project:b')).toBe(true)
    })
  })

  // ── A3 + tension gate (WritePath §5b) ───────────────────────────────────
  describe('A3: the ladder never escalates past its bounds', () => {
    // CONFIRMED: `_stepCommitment` treats `draft` (pending human approval,
    // never injected — schemas/engram.ts) like `decided` and steps it into
    // `locked`. feedback.ts's nextCommitment leaves `draft` untouched on
    // purpose ("unknown means not mine to advance").
    it.fails('a draft engram hit by the ladder stays draft', async () => {
      const plur = new Plur({ path: dir })
      const d = await plur.learn('rotate signing keys every quarter', { scope: 'project:a' })
      patchRow(d.id, { commitment: 'draft' })
      await plur.learn('rotate signing keys every quarter', { scope: 'local' })       // recurrence 1
      await plur.learn('rotate signing keys every quarter', { scope: 'user:alice' })  // recurrence 2 → ladder
      expect(rows().find(e => e.id === d.id).commitment).toBe('draft')
    })

    it('proved good case: in-place promotion honours the hit\'s tension (stays decided)', async () => {
      const plur = new Plur({ path: dir })
      const d = await plur.learn('rotate signing keys every quarter', { scope: 'project:a' })
      patchRow(d.id, { commitment: 'decided' })
      writeFileSync(join(dir, 'tensions.yaml'), yaml.dump([tension(d.id, 'ENG-2026-09-29-999')]))
      await plur.learn('rotate signing keys every quarter', { scope: 'local' })
      await plur.learn('rotate signing keys every quarter', { scope: 'user:alice' })
      const row = rows().find(e => e.id === d.id)
      expect(row.scope).toBe('global')
      expect(row.commitment).toBe('decided')
    })

    // CONFIRMED: the same engram, queued for a team store, is promoted through
    // `_promoteTeamCopy`, whose new global copy is stepped with
    // `lockBlocked = false` — the hit's unresolved tension is never consulted,
    // so the copy locks.
    it.fails('copy-on-promote honours the hit\'s tension: the global copy does not lock', async () => {
      queuedStore()
      const plur = new Plur({ path: dir })
      const queued = await plur.learnRouted('rotate signing keys every quarter', { scope: ENG })
      expect(rows().find(e => e.id === queued.id).structured_data?._outbox, 'fixture: row is queued').toBeDefined()
      patchRow(queued.id, { commitment: 'decided' })
      writeFileSync(join(dir, 'tensions.yaml'), yaml.dump([tension(queued.id, 'ENG-2026-09-29-999')]))
      await plur.learn('rotate signing keys every quarter', { scope: 'local' })
      await plur.learn('rotate signing keys every quarter', { scope: 'user:alice' })
      const copies = rows().filter(e => e.scope === 'global' && e.derived_from === queued.id)
      expect(copies).toHaveLength(1)
      expect(copies[0].commitment).not.toBe('locked')
    })
  })

  // ── Delivery (WritePath §7) ─────────────────────────────────────────────
  describe('delivery: a path-store row is never reported remote', () => {
    // CONFIRMED: `deliveryOf` classifies a secondary-store hit by the FIRST
    // store entry with that scope. When a url store and a shared path store
    // are registered for the same scope (url first), a dedup hit on the PATH
    // store's row is reported `remote` — nothing was POSTed and the row lives
    // in a local file.
    it.fails('a dedup hit on a local path-store row is not reported remote', async () => {
      const teamDir = mkdtempSync(join(tmpdir(), 'plur-fr-c1-team-'))
      try {
        const seed = new Plur({ path: teamDir })
        await seed.learn('page the on-call before a schema migration', { scope: ENG })
        const posts: unknown[] = []
        globalThis.fetch = vi.fn(async (_u: string, init?: { method?: string; body?: string }) => {
          if ((init?.method ?? 'GET') === 'POST') { posts.push(init?.body); throw new Error('must not POST') }
          return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
        }) as any
        writeFileSync(join(dir, 'config.yaml'), yaml.dump({
          index: false,
          stores: [
            { url: URL, token: 't', scope: ENG, shared: true, readonly: false },
            { path: join(teamDir, 'engrams.yaml'), scope: ENG, shared: true },
          ],
        }))
        const plur = new Plur({ path: dir })
        const e = await plur.learn('page the on-call before a schema migration', { scope: ENG })
        expect((e as any)._storeScope, 'fixture: the hit is the path-store row').toBe(ENG)
        expect(posts).toHaveLength(0)
        expect(plur.deliveryOf(e, ENG).delivery).not.toBe('remote')
      } finally {
        rmSync(teamDir, { recursive: true, force: true })
      }
    })
  })
})
