import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { loadEngrams, saveEngrams } from '../src/engrams.js'
import { EngramSchema } from '../src/schemas/engram.js'
import { computeContentHash } from '../src/content-hash.js'

/**
 * Reference-counted content-addressed deduplication (issue #107).
 *
 * Contract:
 *   - First learn of a statement creates the engram with reference_count: 1
 *     and a single source entry.
 *   - Subsequent learns of the same normalized statement at the same scope
 *     increment reference_count and append to sources[] — no new engram.
 *   - forget() decrements reference_count; physical retirement only at 0.
 *   - Old engrams without these fields get reference_count: 1, sources: []
 *     on load (Zod defaults). Next re-learn appends.
 *   - Retired engrams are excluded from dedup hits (re-learning a retired
 *     statement creates a new engram).
 */
describe('reference-counted content-addressed dedup (#107)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-refcount-'))
    plur = new Plur({ path: dir })
  })

  afterEach(() => { rmSync(dir, { recursive: true }) })

  describe('first write', () => {
    it('initializes reference_count to 1 and sources to one entry', () => {
      const engram = plur.learn('always use semicolons', { scope: 'global' })

      expect(engram.reference_count).toBe(1)
      expect(engram.sources).toHaveLength(1)
      expect(engram.sources![0].scope).toBe('global')
      expect(engram.sources![0].stored_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('records session_episode_id in the source when provided', () => {
      const engram = plur.learn('use trailing commas', {
        scope: 'global',
        session_episode_id: 'EP-12345',
      })

      expect(engram.sources![0].session_id).toBe('EP-12345')
    })

    it('records null session_id when no episode provided', () => {
      const engram = plur.learn('prefer named exports', { scope: 'global' })
      expect(engram.sources![0].session_id).toBeNull()
    })
  })

  describe('duplicate writes', () => {
    it('increments reference_count on second write of the same statement', () => {
      const first = plur.learn('always use semicolons', { scope: 'global' })
      const second = plur.learn('always use semicolons', { scope: 'global' })

      expect(second.id).toBe(first.id)
      expect(second.reference_count).toBe(2)
      expect(second.sources).toHaveLength(2)
    })

    it('keeps incrementing on Nth duplicate write', () => {
      let engram
      for (let i = 0; i < 5; i++) {
        engram = plur.learn('repeated correction', { scope: 'global' })
      }
      expect(engram!.reference_count).toBe(5)
      expect(engram!.sources).toHaveLength(5)
    })

    it('persists the mutation — fresh Plur instance sees updated count', () => {
      plur.learn('persisted correction', { scope: 'global' })
      plur.learn('persisted correction', { scope: 'global' })
      plur.learn('persisted correction', { scope: 'global' })

      const fresh = new Plur({ path: dir })
      const list = fresh.list({ scope: 'global' })
      const found = list.find(e => e.statement === 'persisted correction')
      expect(found?.reference_count).toBe(3)
      expect(found?.sources).toHaveLength(3)
    })

    it('normalizes for dedup — punctuation/case/whitespace differences merge', () => {
      const first = plur.learn('Always Use Semicolons!', { scope: 'global' })
      const second = plur.learn('always use   semicolons', { scope: 'global' })
      expect(second.id).toBe(first.id)
      expect(second.reference_count).toBe(2)
    })

    it('creates separate engrams across different scopes (no cross-scope dedup)', () => {
      const a = plur.learn('use 2-space indent', { scope: 'project:a' })
      const b = plur.learn('use 2-space indent', { scope: 'project:b' })
      expect(a.id).not.toBe(b.id)
      expect(a.reference_count).toBe(1)
      expect(b.reference_count).toBe(1)
    })

    it('records different session_ids across multiple write sources', () => {
      plur.learn('rule X', { scope: 'global', session_episode_id: 'EP-A' })
      plur.learn('rule X', { scope: 'global', session_episode_id: 'EP-B' })
      const final = plur.learn('rule X', { scope: 'global', session_episode_id: 'EP-C' })

      expect(final.reference_count).toBe(3)
      const ids = final.sources!.map(s => s.session_id)
      expect(ids).toEqual(['EP-A', 'EP-B', 'EP-C'])
    })
  })

  describe('forget — decrement semantics', () => {
    it('decrements reference_count, leaves engram active when count > 0', async () => {
      const a = plur.learn('soon-to-be-forgotten', { scope: 'global' })
      plur.learn('soon-to-be-forgotten', { scope: 'global' })
      plur.learn('soon-to-be-forgotten', { scope: 'global' })
      // count is now 3

      await plur.forget(a.id)
      const after = plur.getById(a.id)
      expect(after).toBeTruthy()
      expect(after!.status).toBe('active')
      expect(after!.reference_count).toBe(2)
    })

    it('physically retires only when reference_count reaches 0', async () => {
      const a = plur.learn('eventually-retired', { scope: 'global' })
      plur.learn('eventually-retired', { scope: 'global' })

      await plur.forget(a.id) // 2 → 1
      expect(plur.getById(a.id)!.status).toBe('active')

      await plur.forget(a.id) // 1 → 0 → retired
      const final = plur.getById(a.id)
      expect(final!.status).toBe('retired')
      expect(final!.reference_count).toBe(0)
    })

    it('retired engrams are excluded from dedup — new write creates new engram', async () => {
      const first = plur.learn('phoenix correction', { scope: 'global' })
      await plur.forget(first.id) // 1 → 0 → retired
      expect(plur.getById(first.id)!.status).toBe('retired')

      const second = plur.learn('phoenix correction', { scope: 'global' })
      expect(second.id).not.toBe(first.id)
      expect(second.reference_count).toBe(1)
      expect(second.sources).toHaveLength(1)
    })
  })

  describe('migration — old engrams without these fields', () => {
    it('loads pre-existing engrams with default reference_count: 1 and empty sources', () => {
      // Hand-write an old-format engram (no reference_count, no sources)
      const oldEngram = {
        id: 'ENG-2024-LEGACY-001',
        version: 2,
        status: 'active',
        consolidated: false,
        type: 'behavioral',
        scope: 'global',
        visibility: 'private',
        statement: 'legacy engram from before ref-counting',
        activation: {
          retrieval_strength: 0.7,
          storage_strength: 1.0,
          frequency: 0,
          last_accessed: '2024-01-01',
        },
        feedback_signals: { positive: 0, negative: 0, neutral: 0 },
        content_hash: 'placeholder', // present but reference_count missing
        episode_ids: [],
      }
      const path = join(dir, 'engrams.yaml')
      saveEngrams(path, [EngramSchema.parse(oldEngram)])

      const fresh = new Plur({ path: dir })
      const loaded = fresh.getById('ENG-2024-LEGACY-001')
      expect(loaded).toBeTruthy()
      expect(loaded!.reference_count).toBe(1)
      expect(loaded!.sources).toEqual([])
    })

    it('next re-learn after migration appends to sources (no resurrection of phantom history)', () => {
      // Set up a legacy engram with proper hash for dedup match
      const stmt = 'legacy correction with real hash'
      const legacy = EngramSchema.parse({
        id: 'ENG-2024-LEGACY-002',
        version: 2,
        status: 'active',
        consolidated: false,
        type: 'behavioral',
        scope: 'global',
        visibility: 'private',
        statement: stmt,
        activation: {
          retrieval_strength: 0.7,
          storage_strength: 1.0,
          frequency: 0,
          last_accessed: '2024-01-01',
        },
        feedback_signals: { positive: 0, negative: 0, neutral: 0 },
        episode_ids: [],
      })
      // computeContentHash matches what _hashDedup will compute
      ;(legacy as any).content_hash = computeContentHash(stmt)

      const path = join(dir, 'engrams.yaml')
      saveEngrams(path, [legacy])

      const fresh = new Plur({ path: dir })
      const updated = fresh.learn(stmt, { scope: 'global' })

      expect(updated.id).toBe('ENG-2024-LEGACY-002') // dedup hit
      expect(updated.reference_count).toBe(2) // 1 (default) + 1 (new write)
      expect(updated.sources).toHaveLength(1) // only the new source, no fabricated history
    })
  })
})
