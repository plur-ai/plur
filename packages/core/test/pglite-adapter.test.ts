/**
 * PGLiteAdapter test — substrate-level adapter for the YAML-as-truth invariant.
 *
 * Issue plur-ai/plur#226 (ADR-0001), Sprint 0 PR 2.
 *
 * Contract:
 * - YAML stays the source of truth. PGLite is a rebuildable index.
 * - The adapter implements the StorageAdapter interface (load filtered,
 *   reindex from YAML, search BM25, search vector).
 * - reindex() drops all rows and rebuilds from YAML idempotently.
 * - syncFromYaml() applies incremental diffs from YAML to DB.
 * - Vector search uses pgvector when available; falls back to JSONB-stored
 *   embeddings with cosine computed in TypeScript otherwise.
 * - Cosine search returns engrams ordered by similarity descending.
 * - Concurrent writes are safe (PGLite is single-writer per process; we
 *   serialize via the adapter).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import type { Engram } from '../src/schemas/engram.js'

function mkEngram(id: string, statement: string, opts: Partial<Engram> = {}): Engram {
  return {
    id,
    statement,
    type: opts.type ?? 'behavioral',
    scope: opts.scope ?? 'project:plur',
    domain: opts.domain ?? 'plur.test',
    status: opts.status ?? 'active',
    tags: opts.tags ?? [],
    activation: {
      retrieval_strength: 1.0,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2026-05-30',
      ...((opts as any).activation ?? {}),
    },
    feedback_signals: opts.feedback_signals ?? { positive: 0, negative: 0, neutral: 0 },
    ...(opts as any),
  } as Engram
}

function seedYaml(path: string, engrams: Engram[]): void {
  writeFileSync(path, yaml.dump({ engrams }), 'utf8')
}

// PGLite WASM startup can briefly exceed the 5s default under heavy
// workspace-parallel test load (each test instantiates a fresh PGLite).
// 30s is generous and only kicks in if the cold start is slow.
const PGLITE_TIMEOUT = 30_000

describe('PGLiteAdapter — substrate', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-pglite-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
  })

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('lifecycle', () => {
    it('initializes with no engrams when YAML is empty', async () => {
      seedYaml(yamlPath, [])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      const all = await adapter.loadFiltered({})
      expect(all).toEqual([])
      await adapter.close()
    }, PGLITE_TIMEOUT)

    it('creates a PGLite directory on first reindex', async () => {
      seedYaml(yamlPath, [mkEngram('ENG-2026-0530-001', 'first')])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      expect(existsSync(dbPath)).toBe(true)
      await adapter.close()
    }, PGLITE_TIMEOUT)

    it('reindex is idempotent — calling twice yields same row set', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-001', 'one'),
        mkEngram('ENG-2026-0530-002', 'two'),
      ])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      await adapter.reindex()
      const all = await adapter.loadFiltered({})
      expect(all.map(e => e.id).sort()).toEqual(['ENG-2026-0530-001', 'ENG-2026-0530-002'])
      await adapter.close()
    }, PGLITE_TIMEOUT)
  })

  describe('rebuild from YAML', () => {
    it('rebuilds engrams from YAML on reindex', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-001', 'one'),
        mkEngram('ENG-2026-0530-002', 'two'),
        mkEngram('ENG-2026-0530-003', 'three'),
      ])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      const all = await adapter.loadFiltered({})
      expect(all.length).toBe(3)
      expect(all.map(e => e.id).sort()).toEqual([
        'ENG-2026-0530-001',
        'ENG-2026-0530-002',
        'ENG-2026-0530-003',
      ])
      await adapter.close()
    }, PGLITE_TIMEOUT)

    it('drops PGLite content and rebuilds from YAML when YAML changes', async () => {
      seedYaml(yamlPath, [mkEngram('ENG-2026-0530-001', 'first')])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      expect((await adapter.loadFiltered({})).length).toBe(1)

      // YAML changes (the user edited or pulled new state)
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-002', 'replacement'),
      ])
      await adapter.reindex()
      const all = await adapter.loadFiltered({})
      expect(all.map(e => e.id)).toEqual(['ENG-2026-0530-002'])
      await adapter.close()
    }, PGLITE_TIMEOUT)

    it('survives nuking the PGLite dir — calling reindex rebuilds it', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-001', 'one'),
        mkEngram('ENG-2026-0530-002', 'two'),
      ])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      await adapter.close()

      // Simulate "nuke the db"
      rmSync(dbPath, { recursive: true, force: true })
      expect(existsSync(dbPath)).toBe(false)

      const fresh = new PGLiteAdapter(yamlPath, dbPath)
      await fresh.reindex()
      const all = await fresh.loadFiltered({})
      expect(all.map(e => e.id).sort()).toEqual(['ENG-2026-0530-001', 'ENG-2026-0530-002'])
      await fresh.close()
    }, PGLITE_TIMEOUT)
  })

  describe('filtered queries', () => {
    it('filters by status', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-001', 'active', { status: 'active' }),
        mkEngram('ENG-2026-0530-002', 'retired', { status: 'retired' }),
      ])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      const active = await adapter.loadFiltered({ status: 'active' })
      expect(active.map(e => e.id)).toEqual(['ENG-2026-0530-001'])
      await adapter.close()
    }, PGLITE_TIMEOUT)

    it('filters by scope with global fallback', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-001', 'project a', { scope: 'project:a' }),
        mkEngram('ENG-2026-0530-002', 'project b', { scope: 'project:b' }),
        mkEngram('ENG-2026-0530-003', 'universal', { scope: 'global' }),
      ])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      const onlyA = await adapter.loadFiltered({ scope: 'project:a' })
      const ids = onlyA.map(e => e.id).sort()
      // project:a engrams plus global engrams
      expect(ids).toEqual(['ENG-2026-0530-001', 'ENG-2026-0530-003'])
      await adapter.close()
    }, PGLITE_TIMEOUT)

    it('#402 personal-family scopes (local, user:*) pass a project recall — not just global', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-101', 'project a', { scope: 'project:a' }),
        mkEngram('ENG-2026-0530-102', 'project b', { scope: 'project:b' }),     // shared sibling → excluded
        mkEngram('ENG-2026-0530-103', 'universal', { scope: 'global' }),
        mkEngram('ENG-2026-0530-104', 'personal note', { scope: 'local' }),
        mkEngram('ENG-2026-0530-105', 'my note', { scope: 'user:gregor' }),
      ])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      const underA = await adapter.loadFiltered({ scope: 'project:a' })
      const ids = underA.map(e => e.id).sort()
      // project:a + EVERY personal-family scope (global, local, user:*); project:b stays out.
      // Pre-#402 the hardcoded `scope = 'global'` dropped local + user:* here.
      expect(ids).toEqual(['ENG-2026-0530-101', 'ENG-2026-0530-103', 'ENG-2026-0530-104', 'ENG-2026-0530-105'])
      await adapter.close()
    }, PGLITE_TIMEOUT)

    it('filters by domain prefix', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-001', 'one', { domain: 'plur.architecture' }),
        mkEngram('ENG-2026-0530-002', 'two', { domain: 'plur.retrieval' }),
        mkEngram('ENG-2026-0530-003', 'three', { domain: 'workflow.testing' }),
      ])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      const plurOnly = await adapter.loadFiltered({ domain: 'plur' })
      expect(plurOnly.map(e => e.id).sort()).toEqual([
        'ENG-2026-0530-001',
        'ENG-2026-0530-002',
      ])
      await adapter.close()
    }, PGLITE_TIMEOUT)
  })

  describe('count', () => {
    it('counts engrams', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-001', 'one'),
        mkEngram('ENG-2026-0530-002', 'two', { status: 'retired' }),
      ])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      expect(await adapter.count()).toBe(2)
      expect(await adapter.count({ status: 'active' })).toBe(1)
      await adapter.close()
    }, PGLITE_TIMEOUT)
  })

  describe('vector search', () => {
    it('stores embeddings and returns engrams ordered by cosine similarity', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-001', 'apple'),
        mkEngram('ENG-2026-0530-002', 'banana'),
        mkEngram('ENG-2026-0530-003', 'cherry'),
      ])
      const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8 })
      await adapter.reindex()

      // Hand-build embeddings: identical to query for one engram, far for others
      const targetVec = new Float32Array(8)
      targetVec[0] = 1
      const orthoVec = new Float32Array(8)
      orthoVec[1] = 1
      const partialVec = new Float32Array(8)
      partialVec[0] = 0.8
      partialVec[1] = 0.6

      await adapter.upsertEmbedding('ENG-2026-0530-001', targetVec)
      await adapter.upsertEmbedding('ENG-2026-0530-002', partialVec)
      await adapter.upsertEmbedding('ENG-2026-0530-003', orthoVec)

      const results = await adapter.searchVector(targetVec, 3)
      expect(results.length).toBe(3)
      expect(results[0].engram.id).toBe('ENG-2026-0530-001')
      expect(results[1].engram.id).toBe('ENG-2026-0530-002')
      expect(results[2].engram.id).toBe('ENG-2026-0530-003')
      // scores: cosine similarity, 1.0 for identical, lower for others
      expect(results[0].score).toBeCloseTo(1.0, 3)
      expect(results[0].score).toBeGreaterThan(results[1].score)
      expect(results[1].score).toBeGreaterThan(results[2].score)
      await adapter.close()
    }, PGLITE_TIMEOUT)

    it('returns empty array when no embeddings have been stored', async () => {
      seedYaml(yamlPath, [mkEngram('ENG-2026-0530-001', 'no embeds')])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      const queryVec = new Float32Array(8)
      queryVec[0] = 1
      const results = await adapter.searchVector(queryVec, 5)
      expect(results).toEqual([])
      await adapter.close()
    }, PGLITE_TIMEOUT)
  })

  describe('BM25 search', () => {
    it('returns engrams matching token query', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-001', 'always run tests before merging'),
        mkEngram('ENG-2026-0530-002', 'yaml is the source of truth'),
        mkEngram('ENG-2026-0530-003', 'embedding choice dominates fusion'),
      ])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()
      const hits = await adapter.searchBM25('source of truth', { limit: 5 })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].id).toBe('ENG-2026-0530-002')
      await adapter.close()
    }, PGLITE_TIMEOUT)
  })

  describe('concurrent writes', () => {
    it('serializes reindex calls so the final state is consistent', async () => {
      seedYaml(yamlPath, [mkEngram('ENG-2026-0530-001', 'one')])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()

      // Fire several reindex calls concurrently; the YAML stays the same.
      // Final state must reflect that single engram exactly once.
      await Promise.all([
        adapter.reindex(),
        adapter.reindex(),
        adapter.reindex(),
        adapter.reindex(),
      ])
      const all = await adapter.loadFiltered({})
      expect(all.map(e => e.id)).toEqual(['ENG-2026-0530-001'])
      expect(await adapter.count()).toBe(1)
      await adapter.close()
    }, PGLITE_TIMEOUT)

    it('serializes concurrent embedding upserts without dropping rows', async () => {
      const engrams: Engram[] = []
      for (let i = 0; i < 10; i++) {
        engrams.push(mkEngram(`ENG-2026-0530-${String(i).padStart(3, '0')}`, `e${i}`))
      }
      seedYaml(yamlPath, engrams)
      const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8 })
      await adapter.reindex()

      await Promise.all(engrams.map((e, i) => {
        const v = new Float32Array(8)
        v[i % 8] = 1
        return adapter.upsertEmbedding(e.id, v)
      }))

      // searchVector against a zero vector should return all 10 rows
      const queryVec = new Float32Array(8)
      queryVec[0] = 1
      const results = await adapter.searchVector(queryVec, 20)
      expect(results.length).toBe(10)
      await adapter.close()
    }, PGLITE_TIMEOUT)
  })

  describe('syncFromYaml — incremental', () => {
    it('picks up new engrams added to YAML without dropping existing rows', async () => {
      seedYaml(yamlPath, [mkEngram('ENG-2026-0530-001', 'one')])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()

      // Append a new engram to YAML
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-001', 'one'),
        mkEngram('ENG-2026-0530-002', 'two'),
      ])
      await adapter.syncFromYaml()
      const all = await adapter.loadFiltered({})
      expect(all.map(e => e.id).sort()).toEqual([
        'ENG-2026-0530-001',
        'ENG-2026-0530-002',
      ])
      await adapter.close()
    }, PGLITE_TIMEOUT)

    it('removes engrams that were deleted from YAML', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0530-001', 'one'),
        mkEngram('ENG-2026-0530-002', 'two'),
      ])
      const adapter = new PGLiteAdapter(yamlPath, dbPath)
      await adapter.reindex()

      seedYaml(yamlPath, [mkEngram('ENG-2026-0530-001', 'one')])
      await adapter.syncFromYaml()
      const all = await adapter.loadFiltered({})
      expect(all.map(e => e.id)).toEqual(['ENG-2026-0530-001'])
      await adapter.close()
    }, PGLITE_TIMEOUT)
  })
})

/**
 * Integration: Plur class with PLUR_BACKEND=pglite.
 *
 * Demonstrates the full path — Plur constructor wires in PGLite, learn()
 * writes YAML first then mirrors into PGLite via _syncIndex, sync({ full })
 * drops and rebuilds the index. YAML remains the source of truth.
 */
import { Plur } from '../src/index.js'

describe('Plur — PGLite backend integration', () => {
  let dir: string
  const originalBackend = process.env.PLUR_BACKEND

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-pglite-integ-'))
    process.env.PLUR_BACKEND = 'pglite'
  })

  afterEach(() => {
    if (originalBackend) process.env.PLUR_BACKEND = originalBackend
    else delete process.env.PLUR_BACKEND
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a PGLite directory when constructed with PLUR_BACKEND=pglite', async () => {
    const plur = new Plur({ path: dir })
    plur.learn('YAML is the source of truth', {
      scope: 'project:plur',
      type: 'architectural',
    })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    expect(existsSync(join(dir, 'store.pglite'))).toBe(true)
  }, PGLITE_TIMEOUT)

  it('list and recall stay YAML-backed when PGLite is active', async () => {
    const plur = new Plur({ path: dir })
    plur.learn('first statement', { scope: 'project:plur', type: 'behavioral' })
    plur.learn('second statement', { scope: 'project:plur', type: 'behavioral' })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    const all = plur.list()
    expect(all.length).toBe(2)
    const recalled = plur.recall('first')
    expect(recalled.length).toBeGreaterThan(0)
  }, PGLITE_TIMEOUT)

  it('sync({ full: true }) survives a nuked PGLite dir', async () => {
    const plur = new Plur({ path: dir })
    plur.learn('one', { scope: 'project:plur', type: 'behavioral' })
    plur.learn('two', { scope: 'project:plur', type: 'behavioral' })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()
    const before = plur.list().map(e => e.id).sort()

    // Nuke the index — YAML is untouched.
    rmSync(join(dir, 'store.pglite'), { recursive: true, force: true })
    expect(existsSync(join(dir, 'store.pglite'))).toBe(false)

    // Construct a fresh Plur — should reinitialize PGLite, sync from YAML.
    const fresh = new Plur({ path: dir })
    await (fresh as unknown as { reindexAsync: () => Promise<void> }).reindexAsync()
    await (fresh as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()

    const after = fresh.list().map(e => e.id).sort()
    expect(after).toEqual(before)
    expect(existsSync(join(dir, 'store.pglite'))).toBe(true)
  }, PGLITE_TIMEOUT)
})
