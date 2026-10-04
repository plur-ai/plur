import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

/**
 * Defects the formal model of the write path (field-report cluster 1) replayed
 * against #1268, each pinned here failing-first.
 *
 *  - The ladder must never advance a commitment it does not own. `draft`
 *    (pending human approval) and any unknown value stay as they are, as in
 *    `feedback.ts` `nextCommitment`.
 *  - The tension gate (#181) applies at EVERY escalation site: an unresolved
 *    tension on the source engram blocks the step into `locked` for the
 *    global copy made by copy-on-promote and for an existing global twin it
 *    credits, exactly as it does for in-place promotion.
 */
const ENG = 'group:example/eng'
const URL = 'https://store.example.test/sse'

describe('#1268 formal replays', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-1268-'))
    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('no network in this test') }) as any
  })
  afterEach(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })

  const file = () => join(dir, 'engrams.yaml')
  const rows = (): any[] => (yaml.load(readFileSync(file(), 'utf8')) as any)?.engrams ?? []
  const editRows = (fn: (engrams: any[]) => void) => {
    const doc = yaml.load(readFileSync(file(), 'utf8')) as any
    fn(doc.engrams)
    writeFileSync(file(), yaml.dump(doc, { lineWidth: 200, noRefs: true }))
  }
  const patchRow = (id: string, patch: Record<string, unknown>) =>
    editRows(es => Object.assign(es.find(e => e.id === id), patch))
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
  const STMT = 'rotate signing keys every quarter'

  describe('the ladder never advances a commitment it does not own', () => {
    for (const commitment of ['draft', 'some-extension-value']) {
      it(`a ${commitment} engram hit by the ladder keeps its commitment`, async () => {
        const plur = new Plur({ path: dir })
        const d = await plur.learn(STMT, { scope: 'project:a' })
        patchRow(d.id, { commitment })
        await plur.learn(STMT, { scope: 'local' })       // recurrence 1
        await plur.learn(STMT, { scope: 'user:alice' })  // recurrence 2 → ladder
        await plur.learn(STMT, { scope: 'agent:b' })     // recurrence 3
        expect(rows().find(e => e.id === d.id).commitment).toBe(commitment)
      })
    }

    it('team validation does not advance a draft either', async () => {
      const plur = new Plur({ path: dir })
      const d = await plur.learn(STMT, { scope: 'global' })
      patchRow(d.id, { commitment: 'draft' })
      await plur.learn(STMT, { scope: 'local' })
      await plur.learn(STMT, { scope: 'user:alice' })
      await plur.learn(STMT, { scope: ENG })             // team validation
      expect(rows().find(e => e.id === d.id).commitment).toBe('draft')
    })
  })

  describe('the tension gate applies at every escalation site', () => {
    it('in-place promotion honours the hit\'s tension (regression guard)', async () => {
      const plur = new Plur({ path: dir })
      const d = await plur.learn(STMT, { scope: 'project:a' })
      patchRow(d.id, { commitment: 'decided' })
      writeFileSync(join(dir, 'tensions.yaml'), yaml.dump([tension(d.id, 'ENG-2026-09-29-999')]))
      await plur.learn(STMT, { scope: 'local' })
      await plur.learn(STMT, { scope: 'user:alice' })
      const row = rows().find(e => e.id === d.id)
      expect(row.scope).toBe('global')
      expect(row.commitment).toBe('decided')
    })

    it('copy-on-promote: the source engram\'s tension blocks the new global copy from locking', async () => {
      queuedStore()
      const plur = new Plur({ path: dir })
      const queued = await plur.learnRouted(STMT, { scope: ENG })
      expect(rows().find(e => e.id === queued.id).structured_data?._outbox, 'fixture: row is queued').toBeDefined()
      patchRow(queued.id, { commitment: 'decided' })
      writeFileSync(join(dir, 'tensions.yaml'), yaml.dump([tension(queued.id, 'ENG-2026-09-29-999')]))
      await plur.learn(STMT, { scope: 'local' })
      await plur.learn(STMT, { scope: 'user:alice' })
      const copies = rows().filter(e => e.scope === 'global' && e.derived_from === queued.id)
      expect(copies).toHaveLength(1)
      expect(copies[0].commitment).toBe('decided')
    })

    it('twin credit: the source engram\'s tension blocks the existing global twin from locking', async () => {
      queuedStore()
      const plur = new Plur({ path: dir })
      const queued = await plur.learnRouted(STMT, { scope: ENG })
      patchRow(queued.id, { commitment: 'decided' })
      // A global engram with the same text, placed after the queued row.
      editRows(es => {
        const src = es.find(e => e.id === queued.id)
        es.push({ ...structuredClone(src), id: 'ENG-2026-09-29-777', scope: 'global', commitment: 'decided', structured_data: undefined })
      })
      writeFileSync(join(dir, 'tensions.yaml'), yaml.dump([tension(queued.id, 'ENG-2026-09-29-999')]))
      await plur.learn(STMT, { scope: 'local' })
      await plur.learn(STMT, { scope: 'user:alice' })
      const twin = rows().find(e => e.id === 'ENG-2026-09-29-777')
      expect(twin.recurrence_count ?? 0).toBeGreaterThan(0)   // fixture: the twin was credited
      expect(twin.commitment).toBe('decided')
    })
  })
})
