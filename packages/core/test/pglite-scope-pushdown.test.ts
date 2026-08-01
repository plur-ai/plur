/**
 * Scope pushdown — PGLiteAdapter (Phase 3, core half of the enterprise
 * recall bug).
 *
 * The bug this file exists to prevent: a vector search that returns the
 * ORG-WIDE nearest neighbours and lets the caller filter by scope afterwards.
 * With a fixed overfetch factor, a caller
 * whose permitted scopes are a small share of the corpus asks for N results
 * and silently gets a handful — the relevant in-scope engrams sit just below
 * the cut and are never seen. Pushing the permitted-scope list INTO the query
 * makes `limit` count permitted rows, so N asked is N returned.
 *
 * Contract under test (see ScopeRestriction in storage-adapter.ts):
 *   - `scopes` absent      → no scope restriction (byte-identical behaviour)
 *   - `scopes: []`         → matches NOTHING (security-relevant degenerate
 *                            case: a principal with no permitted scopes must
 *                            see zero engrams, never the whole corpus)
 *   - `scopes: ['a']`      → EXACT membership — no hierarchy expansion, no
 *                            personal-family pass-through
 *   - composes (AND) with status / scope / domain
 *   - applies to loadFiltered, searchBM25 AND searchVector
 *   - applies on the pgvector path AND the BYTEA/JS-cosine fallback
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
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
      last_accessed: '2026-07-26',
    },
    feedback_signals: opts.feedback_signals ?? { positive: 0, negative: 0, neutral: 0 },
  } as Engram
}

function seedYaml(path: string, engrams: Engram[]): void {
  writeFileSync(path, yaml.dump({ engrams }), 'utf8')
}

const DIM = 8

/** Build a DIM-length vector from its leading components. */
function vec(...head: number[]): Float32Array {
  const v = new Float32Array(DIM)
  for (let i = 0; i < head.length && i < DIM; i++) v[i] = head[i]
  return v
}

// PGLite WASM startup + schema init; generous because the serial core-pglite
// project trades wall-clock for correctness.
const PGLITE_TIMEOUT = 60_000

/**
 * Dilution fixture: a corpus dominated by engrams the caller may NOT see,
 * where every out-of-scope engram is a NEARER neighbour than every in-scope
 * one. Post-filtering `limit * 3` here returns zero in-scope results; a real
 * pushdown returns exactly `limit`.
 */
const OUT_OF_SCOPE = 100
const IN_SCOPE = 20

async function seedDilutionCorpus(adapter: PGLiteAdapter, yamlPath: string): Promise<void> {
  const engrams: Engram[] = []
  for (let i = 0; i < OUT_OF_SCOPE; i++) {
    engrams.push(mkEngram(`ENG-2026-0726-O${String(i).padStart(3, '0')}`, `other org memory ${i}`, {
      scope: 'project:other',
    }))
  }
  for (let j = 0; j < IN_SCOPE; j++) {
    engrams.push(mkEngram(`ENG-2026-0726-M${String(j).padStart(3, '0')}`, `mine org memory ${j}`, {
      scope: 'project:mine',
    }))
  }
  seedYaml(yamlPath, engrams)
  await adapter.reindex()
  // Out-of-scope rows hug the query axis (cosine ~1.0); in-scope rows sit well
  // off it (cosine ~0.89). Ordering is therefore 100 forbidden rows first.
  for (let i = 0; i < OUT_OF_SCOPE; i++) {
    await adapter.upsertEmbedding(`ENG-2026-0726-O${String(i).padStart(3, '0')}`, vec(1, 0.0001 * (i + 1)))
  }
  for (let j = 0; j < IN_SCOPE; j++) {
    await adapter.upsertEmbedding(`ENG-2026-0726-M${String(j).padStart(3, '0')}`, vec(1, 0.5 + 0.001 * j))
  }
}

describe('PGLiteAdapter — permitted-scope pushdown', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string
  let adapter: PGLiteAdapter

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-scope-push-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
  })

  afterEach(async () => {
    if (adapter) await adapter.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('loadFiltered', () => {
    beforeEach(async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0726-001', 'alpha', { scope: 'project:a' }),
        mkEngram('ENG-2026-0726-002', 'alpha sub', { scope: 'project:a:sub' }),
        mkEngram('ENG-2026-0726-003', 'beta', { scope: 'project:b' }),
        mkEngram('ENG-2026-0726-004', 'personal global', { scope: 'global' }),
        mkEngram('ENG-2026-0726-005', 'personal local', { scope: 'local' }),
      ])
      adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: DIM })
      await adapter.reindex()
    }, PGLITE_TIMEOUT)

    it('REGRESSION GUARD: omitting scopes returns exactly what it returned before', async () => {
      const all = await adapter.loadFiltered({})
      expect(all.length).toBe(5)
      const active = await adapter.loadFiltered({ status: 'active' })
      expect(active.length).toBe(5)
      // Explicit `scopes: undefined` must be indistinguishable from absent.
      const explicitUndefined = await adapter.loadFiltered({ scopes: undefined })
      expect(explicitUndefined.map(e => e.id).sort()).toEqual(all.map(e => e.id).sort())
    }, PGLITE_TIMEOUT)

    it('SECURITY: an empty permitted-scope list matches NOTHING', async () => {
      const none = await adapter.loadFiltered({ scopes: [] })
      expect(none).toEqual([])
      // …and stays empty when combined with other filters, rather than the
      // empty list being quietly dropped.
      expect(await adapter.loadFiltered({ status: 'active', scopes: [] })).toEqual([])
      expect(await adapter.loadFiltered({ scope: 'project:a', scopes: [] })).toEqual([])
    }, PGLITE_TIMEOUT)

    it('restricts to exactly the listed scopes', async () => {
      const onlyA = await adapter.loadFiltered({ scopes: ['project:a'] })
      expect(onlyA.map(e => e.id)).toEqual(['ENG-2026-0726-001'])
      const aAndB = await adapter.loadFiltered({ scopes: ['project:a', 'project:b'] })
      expect(aAndB.map(e => e.id).sort()).toEqual(['ENG-2026-0726-001', 'ENG-2026-0726-003'])
    }, PGLITE_TIMEOUT)

    it('does NOT expand the hierarchy and does NOT pass personal scopes through', async () => {
      // `scopes` is an authorization decision the caller already resolved:
      // descendants (project:a:sub) and personal-family scopes (global, local)
      // are NOT implied. This is the opposite of `scope`, deliberately.
      const onlyA = await adapter.loadFiltered({ scopes: ['project:a'] })
      const ids = onlyA.map(e => e.id)
      expect(ids).not.toContain('ENG-2026-0726-002') // project:a:sub
      expect(ids).not.toContain('ENG-2026-0726-004') // global
      expect(ids).not.toContain('ENG-2026-0726-005') // local
      // Contrast: the visibility filter `scope` DOES expand + pass through.
      const visibility = await adapter.loadFiltered({ scope: 'project:a' })
      const visIds = visibility.map(e => e.id)
      expect(visIds).toContain('ENG-2026-0726-002')
      expect(visIds).toContain('ENG-2026-0726-004')
    }, PGLITE_TIMEOUT)

    it('composes with status, domain and scope as an AND (intersection)', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0726-010', 'a active plur', { scope: 'project:a', domain: 'plur.search', status: 'active' }),
        mkEngram('ENG-2026-0726-011', 'a retired plur', { scope: 'project:a', domain: 'plur.search', status: 'retired' }),
        mkEngram('ENG-2026-0726-012', 'a active other', { scope: 'project:a', domain: 'other.thing', status: 'active' }),
        mkEngram('ENG-2026-0726-013', 'b active plur', { scope: 'project:b', domain: 'plur.search', status: 'active' }),
      ])
      await adapter.reindex()
      const hits = await adapter.loadFiltered({
        status: 'active',
        domain: 'plur',
        scopes: ['project:a', 'project:b'],
      })
      expect(hits.map(e => e.id).sort()).toEqual(['ENG-2026-0726-010', 'ENG-2026-0726-013'])
      // Intersecting `scope` (visibility) with `scopes` (authorization) can
      // only narrow: project:b is visible under neither.
      const both = await adapter.loadFiltered({ scope: 'project:a', scopes: ['project:b'] })
      expect(both).toEqual([])
    }, PGLITE_TIMEOUT)
  })

  describe('searchBM25', () => {
    beforeEach(async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0726-020', 'yaml is the source of truth', { scope: 'project:a' }),
        mkEngram('ENG-2026-0726-021', 'yaml is the source of truth', { scope: 'project:b' }),
        mkEngram('ENG-2026-0726-022', 'yaml is the source of truth', { scope: 'global' }),
      ])
      adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: DIM })
      await adapter.reindex()
    }, PGLITE_TIMEOUT)

    it('REGRESSION GUARD: omitting scopes searches the whole active corpus', async () => {
      const hits = await adapter.searchBM25('source of truth', { limit: 10 })
      expect(hits.map(e => e.id).sort()).toEqual([
        'ENG-2026-0726-020', 'ENG-2026-0726-021', 'ENG-2026-0726-022',
      ])
    }, PGLITE_TIMEOUT)

    it('SECURITY: an empty permitted-scope list returns no hits', async () => {
      const hits = await adapter.searchBM25('source of truth', { limit: 10, scopes: [] })
      expect(hits).toEqual([])
    }, PGLITE_TIMEOUT)

    it('restricts hits to the listed scopes', async () => {
      const hits = await adapter.searchBM25('source of truth', { limit: 10, scopes: ['project:a'] })
      expect(hits.map(e => e.id)).toEqual(['ENG-2026-0726-020'])
    }, PGLITE_TIMEOUT)

    it('DILUTION: limit counts in-scope hits, not org-wide hits', async () => {
      adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: DIM })
      await seedDilutionCorpus(adapter, yamlPath)
      // Every engram shares the token "memory", so the org-wide candidate set
      // is 120 and is dominated 5:1 by rows the caller may not see.
      const hits = await adapter.searchBM25('memory', { limit: 10, scopes: ['project:mine'] })
      expect(hits.length).toBe(10)
      expect(hits.every(e => e.scope === 'project:mine')).toBe(true)
    }, PGLITE_TIMEOUT)
  })

  describe('searchVector (pgvector path)', () => {
    it('REGRESSION GUARD: omitting scopes returns the org-wide neighbours, unchanged', async () => {
      adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: DIM })
      await seedDilutionCorpus(adapter, yamlPath)
      expect(await adapter.getVectorColumnType()).toBe('vector') // pgvector, not the fallback
      const hits = await adapter.searchVector(vec(1), 10)
      expect(hits.length).toBe(10)
      // The nearest 10 are all out-of-scope by construction — this is the
      // pre-pushdown behaviour, preserved when no allow-list is supplied.
      expect(hits.every(h => h.engram.scope === 'project:other')).toBe(true)
    }, PGLITE_TIMEOUT)

    it('SECURITY: an empty permitted-scope list returns no hits', async () => {
      adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: DIM })
      await seedDilutionCorpus(adapter, yamlPath)
      const hits = await adapter.searchVector(vec(1), 10, { scopes: [] })
      expect(hits).toEqual([])
    }, PGLITE_TIMEOUT)

    it('THE BUG: post-filtering a 3x overfetch loses in-scope results the pushdown keeps', async () => {
      adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: DIM })
      await seedDilutionCorpus(adapter, yamlPath)
      const limit = 10

      // (a) The post-filter approach: fetch limit*3 unrestricted, filter in
      //     JS afterwards. The caller asked for 10 and gets far fewer.
      const overfetched = await adapter.searchVector(vec(1), limit * 3)
      const postFiltered = overfetched.filter(h => h.engram.scope === 'project:mine')
      expect(postFiltered.length).toBeLessThan(limit)

      // (b) What the pushdown does: filter in the query, so LIMIT counts
      //     permitted rows. Asked for 10, got 10 — all in scope.
      const pushed = await adapter.searchVector(vec(1), limit, { scopes: ['project:mine'] })
      expect(pushed.length).toBe(limit)
      expect(pushed.every(h => h.engram.scope === 'project:mine')).toBe(true)
      // Scores stay real cosine similarities, ordered descending.
      for (let i = 1; i < pushed.length; i++) {
        expect(pushed[i - 1].score).toBeGreaterThanOrEqual(pushed[i].score)
      }
    }, PGLITE_TIMEOUT)

    it('returns every in-scope row when the limit exceeds the permitted corpus', async () => {
      adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: DIM })
      await seedDilutionCorpus(adapter, yamlPath)
      const hits = await adapter.searchVector(vec(1), 999, { scopes: ['project:mine'] })
      expect(hits.length).toBe(IN_SCOPE)
      expect(hits.every(h => h.engram.scope === 'project:mine')).toBe(true)
    }, PGLITE_TIMEOUT)

    it('still excludes non-active engrams when a permitted-scope list is supplied', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0726-030', 'active', { scope: 'project:a', status: 'active' }),
        mkEngram('ENG-2026-0726-031', 'retired', { scope: 'project:a', status: 'retired' }),
      ])
      adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: DIM })
      await adapter.reindex()
      await adapter.upsertEmbedding('ENG-2026-0726-030', vec(1))
      await adapter.upsertEmbedding('ENG-2026-0726-031', vec(1))
      const hits = await adapter.searchVector(vec(1), 10, { scopes: ['project:a'] })
      expect(hits.map(h => h.engram.id)).toEqual(['ENG-2026-0726-030'])
    }, PGLITE_TIMEOUT)
  })
})

describe('PGLiteAdapter — mounted-scope visibility grants (#775)', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string
  let adapter: PGLiteAdapter

  const GRANTS_CORPUS = [
    mkEngram('ENG-2026-0730-201', 'project deploy row', { scope: 'project:a' }),
    mkEngram('ENG-2026-0730-202', 'personal deploy row', { scope: 'global' }),
    mkEngram('ENG-2026-0730-203', 'team deploy row', { scope: 'group:acme/eng' }),
    mkEngram('ENG-2026-0730-204', 'team sub deploy row', { scope: 'group:acme/eng/sub' }),
    mkEngram('ENG-2026-0730-205', 'sibling deploy row', { scope: 'group:acme/eng-private' }),
    mkEngram('ENG-2026-0730-206', 'other team deploy row', { scope: 'group:other/team' }),
  ]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-775-pglite-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
    seedYaml(yamlPath, GRANTS_CORPUS)
    adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: DIM })
    await adapter.reindex()
  }, PGLITE_TIMEOUT)

  afterEach(async () => {
    if (adapter) await adapter.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('loadFiltered: a granted scope and its true descendants pass the scope filter', async () => {
    const ids = (await adapter.loadFiltered({
      scope: 'project:a',
      visibilityGrants: ['group:acme/eng'],
    })).map(e => e.id)
    expect(ids).toContain('ENG-2026-0730-201') // the filter scope
    expect(ids).toContain('ENG-2026-0730-202') // personal pass-through
    expect(ids).toContain('ENG-2026-0730-203') // granted scope
    expect(ids).toContain('ENG-2026-0730-204') // true descendant
    expect(ids, 'sibling string-prefix leaked through a grant (#383)').not.toContain('ENG-2026-0730-205')
    expect(ids, 'an ungranted shared scope leaked').not.toContain('ENG-2026-0730-206')
  }, PGLITE_TIMEOUT)

  it('grants are inert without a scope filter', async () => {
    const withGrants = (await adapter.loadFiltered({ visibilityGrants: ['group:acme/eng'] }))
      .map(e => e.id).sort()
    const without = (await adapter.loadFiltered({})).map(e => e.id).sort()
    expect(withGrants).toEqual(without)
  }, PGLITE_TIMEOUT)

  it('SECURITY: grants never widen the scopes authorization allow-list', async () => {
    const ids = (await adapter.loadFiltered({
      scope: 'project:a',
      scopes: ['project:a'],
      visibilityGrants: ['group:acme/eng'],
    })).map(e => e.id)
    expect(ids).toEqual(['ENG-2026-0730-201'])
    expect(await adapter.loadFiltered({ scopes: [], visibilityGrants: ['group:acme/eng'] })).toEqual([])
  }, PGLITE_TIMEOUT)

  it('searchBM25: the granted team row survives a scope-filtered search', async () => {
    const hits = await adapter.searchBM25('deploy row', {
      limit: 10,
      scope: 'project:a',
      visibilityGrants: ['group:acme/eng'],
    })
    const ids = hits.map(e => e.id)
    expect(ids).toContain('ENG-2026-0730-203')
    expect(ids).not.toContain('ENG-2026-0730-205')
    expect(ids).not.toContain('ENG-2026-0730-206')
  }, PGLITE_TIMEOUT)
})

describe('PGLiteAdapter — permitted-scope pushdown on the BYTEA fallback', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-scope-bytea-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
  })

  afterEach(() => {
    vi.doUnmock('@electric-sql/pglite/vector')
    vi.resetModules()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Load a PGLiteAdapter whose pgvector import yields no `vector` export, so
   * the adapter takes the BYTEA + JS-cosine fallback. The scope filter must
   * STILL run in SQL there — a fallback that quietly ignores `scopes` is the
   * same silent-wrong-results bug wearing a different hat.
   */
  async function loadFallbackAdapter(): Promise<typeof PGLiteAdapter> {
    vi.resetModules()
    vi.doMock('@electric-sql/pglite/vector', () => ({}))
    const mod = await import('../src/storage-pglite.js')
    return mod.PGLiteAdapter
  }

  it('filters by permitted scopes on the JS-cosine path, including the empty list', async () => {
    const Adapter = await loadFallbackAdapter()
    seedYaml(yamlPath, [
      mkEngram('ENG-2026-0726-040', 'alpha', { scope: 'project:a' }),
      mkEngram('ENG-2026-0726-041', 'beta', { scope: 'project:b' }),
      mkEngram('ENG-2026-0726-042', 'gamma', { scope: 'global' }),
    ])
    const adapter = new Adapter(yamlPath, dbPath, { vectorDim: DIM })
    await adapter.reindex()
    // Self-check: null column type proves we really are on the BYTEA fallback.
    // Without this the test could silently exercise the pgvector path instead.
    expect(await adapter.getVectorColumnType()).toBeNull()

    await adapter.upsertEmbedding('ENG-2026-0726-040', vec(1))
    await adapter.upsertEmbedding('ENG-2026-0726-041', vec(1, 0.01))
    await adapter.upsertEmbedding('ENG-2026-0726-042', vec(1, 0.02))

    // Unrestricted — regression guard.
    expect((await adapter.searchVector(vec(1), 10)).length).toBe(3)
    // Empty allow-list — nothing.
    expect(await adapter.searchVector(vec(1), 10, { scopes: [] })).toEqual([])
    // Exact membership.
    const only = await adapter.searchVector(vec(1), 10, { scopes: ['project:b'] })
    expect(only.map(h => h.engram.id)).toEqual(['ENG-2026-0726-041'])
    // BM25 + loadFiltered on the fallback store too.
    expect(await adapter.loadFiltered({ scopes: [] })).toEqual([])
    expect((await adapter.searchBM25('alpha', { limit: 10, scopes: ['project:a'] })).map(e => e.id))
      .toEqual(['ENG-2026-0726-040'])

    await adapter.close()
  }, PGLITE_TIMEOUT)

  it('DILUTION on the fallback path: limit counts in-scope hits', async () => {
    const Adapter = await loadFallbackAdapter()
    const adapter = new Adapter(yamlPath, dbPath, { vectorDim: DIM })
    await seedDilutionCorpus(adapter as unknown as PGLiteAdapter, yamlPath)
    expect(await adapter.getVectorColumnType()).toBeNull()
    const hits = await adapter.searchVector(vec(1), 10, { scopes: ['project:mine'] })
    expect(hits.length).toBe(10)
    expect(hits.every(h => h.engram.scope === 'project:mine')).toBe(true)
    await adapter.close()
  }, PGLITE_TIMEOUT)
})
