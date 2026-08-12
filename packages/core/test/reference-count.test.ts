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
 *   - First learn of a statement creates the engram with write_count: 1
 *     and a single source entry.
 *   - Subsequent learns of the same normalized statement at the same scope
 *     increment write_count and append to sources[] — no new engram.
 *   - forget() decrements write_count; physical retirement only at 0.
 *   - Old engrams without these fields get write_count: 1, sources: []
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
    it('initializes write_count to 1 and sources to one entry', async () => {
      const engram = await plur.learn('always use semicolons', { scope: 'global' })

      expect(engram.write_count).toBe(1)
      expect(engram.sources).toHaveLength(1)
      expect(engram.sources![0].scope).toBe('global')
      expect(engram.sources![0].stored_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('records session_episode_id in the source when provided', async () => {
      const engram = await plur.learn('use trailing commas', {
        scope: 'global',
        session_episode_id: 'EP-12345',
      })

      expect(engram.sources![0].session_id).toBe('EP-12345')
    })

    it('records null session_id when no episode provided', async () => {
      const engram = await plur.learn('prefer named exports', { scope: 'global' })
      expect(engram.sources![0].session_id).toBeNull()
    })
  })

  describe('duplicate writes', () => {
    it('increments write_count on second write of the same statement', async () => {
      const first = await plur.learn('always use semicolons', { scope: 'global' })
      const second = await plur.learn('always use semicolons', { scope: 'global' })

      expect(second.id).toBe(first.id)
      expect(second.write_count).toBe(2)
      expect(second.sources).toHaveLength(2)
    })

    it('keeps incrementing on Nth duplicate write', async () => {
      let engram
      for (let i = 0; i < 5; i++) {
        engram = await plur.learn('repeated correction', { scope: 'global' })
      }
      expect(engram!.write_count).toBe(5)
      expect(engram!.sources).toHaveLength(5)
    })

    it('persists the mutation — fresh Plur instance sees updated count', async () => {
      await plur.learn('persisted correction', { scope: 'global' })
      await plur.learn('persisted correction', { scope: 'global' })
      await plur.learn('persisted correction', { scope: 'global' })

      const fresh = new Plur({ path: dir })
      const list = await fresh.list({ scope: 'global' })
      const found = list.find(e => e.statement === 'persisted correction')
      expect(found?.write_count).toBe(3)
      expect(found?.sources).toHaveLength(3)
    })

    it('normalizes for dedup — punctuation/case/whitespace differences merge', async () => {
      const first = await plur.learn('Always Use Semicolons!', { scope: 'global' })
      const second = await plur.learn('always use   semicolons', { scope: 'global' })
      expect(second.id).toBe(first.id)
      expect(second.write_count).toBe(2)
    })

    it('cross-scope re-learn merges into existing engram as recurrence (#107 superseded by #176)', async () => {
      // ORIGINAL #107 semantics: cross-scope was NOT deduplicated — fresh engram per scope.
      // SUPERSEDED by #176: cross-scope re-learn is treated as evidence of
      // universal applicability and merges into the existing engram with
      // recurrence_count++ instead of creating a duplicate.
      const a = await plur.learn('use 2-space indent', { scope: 'project:a' })
      const b = await plur.learn('use 2-space indent', { scope: 'project:b' })
      expect(b.id).toBe(a.id)                         // SAME engram, mutated
      expect(b.recurrence_count).toBe(1)              // 1st cross-scope hit
      expect(b.write_count).toBe(2)               // also bumped by recurrence path
      expect(b.scope).toBe('project:a')               // unchanged on 1st hit (no broadening)
    })

    it('records different session_ids across multiple write sources', async () => {
      await plur.learn('rule X', { scope: 'global', session_episode_id: 'EP-A' })
      await plur.learn('rule X', { scope: 'global', session_episode_id: 'EP-B' })
      const final = await plur.learn('rule X', { scope: 'global', session_episode_id: 'EP-C' })

      expect(final.write_count).toBe(3)
      const ids = final.sources!.map(s => s.session_id)
      expect(ids).toEqual(['EP-A', 'EP-B', 'EP-C'])
    })
  })

  describe('forget — decrement semantics', () => {
    it('decrements write_count, leaves engram active when count > 0', async () => {
      const a = await plur.learn('soon-to-be-forgotten', { scope: 'global' })
      await plur.learn('soon-to-be-forgotten', { scope: 'global' })
      await plur.learn('soon-to-be-forgotten', { scope: 'global' })
      // count is now 3

      await plur.forget(a.id)
      const after = await plur.getById(a.id)
      expect(after).toBeTruthy()
      expect(after!.status).toBe('active')
      expect(after!.write_count).toBe(2)
    })

    it('physically retires only when write_count reaches 0', async () => {
      const a = await plur.learn('eventually-retired', { scope: 'global' })
      await plur.learn('eventually-retired', { scope: 'global' })

      await plur.forget(a.id) // 2 → 1
      expect((await plur.getById(a.id))!.status).toBe('active')

      await plur.forget(a.id) // 1 → 0 → retired
      const final = await plur.getById(a.id)
      expect(final!.status).toBe('retired')
      expect(final!.write_count).toBe(0)
    })

    it('retired engrams are excluded from dedup — new write creates new engram', async () => {
      const first = await plur.learn('phoenix correction', { scope: 'global' })
      await plur.forget(first.id) // 1 → 0 → retired
      expect((await plur.getById(first.id))!.status).toBe('retired')

      const second = await plur.learn('phoenix correction', { scope: 'global' })
      expect(second.id).not.toBe(first.id)
      expect(second.write_count).toBe(1)
      expect(second.sources).toHaveLength(1)
    })
  })

  describe('migration — old engrams without these fields', () => {
    it('loads pre-existing engrams with default write_count: 1 and empty sources', async () => {
      // Hand-write an old-format engram (no write_count, no sources)
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
        content_hash: 'placeholder', // present but write_count missing
        episode_ids: [],
      }
      const path = join(dir, 'engrams.yaml')
      saveEngrams(path, [EngramSchema.parse(oldEngram)])

      const fresh = new Plur({ path: dir })
      const loaded = await fresh.getById('ENG-2024-LEGACY-001')
      expect(loaded).toBeTruthy()
      expect(loaded!.write_count).toBe(1)
      expect(loaded!.sources).toEqual([])
    })

    it('next re-learn after migration appends to sources (no resurrection of phantom history)', async () => {
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
      const updated = await fresh.learn(stmt, { scope: 'global' })

      expect(updated.id).toBe('ENG-2024-LEGACY-002') // dedup hit
      expect(updated.write_count).toBe(2) // 1 (default) + 1 (new write)
      expect(updated.sources).toHaveLength(1) // only the new source, no fabricated history
    })

    it('backfills write_count from legacy reference_count field in raw YAML (#866)', async () => {
      // Simulate a YAML store written before #866 that has 'reference_count' not 'write_count'
      const fs = await import('fs')
      const content = `engrams:\n- id: ENG-2024-LEGACY-RC-001\n  version: 2\n  status: active\n  consolidated: false\n  type: behavioral\n  scope: global\n  visibility: private\n  statement: pre-866 engram with old field name\n  activation:\n    retrieval_strength: 0.7\n    storage_strength: 1.0\n    frequency: 5\n    last_accessed: "2024-01-01"\n  feedback_signals:\n    positive: 0\n    negative: 0\n    neutral: 0\n  episode_ids: []\n  reference_count: 3\n  sources: []\n`
      const path = join(dir, 'engrams.yaml')
      fs.writeFileSync(path, content)

      const fresh = new Plur({ path: dir })
      const loaded = await fresh.getById('ENG-2024-LEGACY-RC-001')
      expect(loaded).toBeTruthy()
      expect(loaded!.write_count).toBe(3)    // migrated from reference_count
      expect((loaded as any).reference_count).toBeUndefined()  // old field stripped
    })
  })

  describe('injection_count — inject path (#866)', () => {
    it('starts at 0 on a new engram', async () => {
      const engram = await plur.learn('injection count starts at zero', { scope: 'global' })
      expect(engram.injection_count).toBe(0)
    })

    it('increments injection_count after inject()', async () => {
      const engram = await plur.learn('inject me please', { scope: 'global' })
      expect(engram.injection_count).toBe(0)

      await plur.inject('inject me please')

      const after = await plur.getById(engram.id)
      expect(after!.injection_count).toBe(1)
    })

    it('injection_count is distinct from activation.frequency (recall vs inject)', async () => {
      const engram = await plur.learn('dual counter engram', { scope: 'global' })

      // recall() increments activation.frequency
      await plur.recall('dual counter')
      const afterRecall = await plur.getById(engram.id)
      expect(afterRecall!.activation.frequency).toBeGreaterThan(0)
      expect(afterRecall!.injection_count).toBe(0)  // inject not yet called

      // inject() increments injection_count
      await plur.inject('dual counter engram')
      const afterInject = await plur.getById(engram.id)
      expect(afterInject!.injection_count).toBe(1)
    })
  })
})
