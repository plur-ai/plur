/**
 * YAML-as-truth invariant — Test B: public API traceability
 *
 * Issue plur-ai/plur#249, ADR-0001 (#226), engram ENG-2026-0530-019.
 *
 * Principle: every engram returned by any PLUR public method must trace
 * to a record in the YAML source on disk. If a future feature inserts
 * engrams into the DB-only index without also writing them to YAML
 * (e.g. materialized cache, "synthetic" engrams, reranker artifacts),
 * this test fails.
 *
 * Iter-2 audit M-1: parameterized over PLUR_BACKEND so both SQLite
 * (IndexedStorage) and PGLite paths are policed. Closes the
 * "Test B doesn't probe the substrate" critique from iter-1
 * (Critic F-CRIT-009, Data F-DATA-004).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, PGLiteAdapter } from '../src/index.js'
import { loadEngrams } from '../src/engrams.js'
import { embed } from '../src/embeddings.js'

/**
 * Read every YAML file under `dir` recursively and return a set of all
 * engram IDs present.  This is the YAML ground truth — the universe of
 * IDs any public method is allowed to return.
 */
function yamlGroundTruth(dir: string): Set<string> {
  const ids = new Set<string>()
  const primary = join(dir, 'engrams.yaml')
  for (const e of loadEngrams(primary)) ids.add(e.id)
  // Pack stores, secondary stores, scoped stores all live at well-known
  // sub-paths or are configured.  Extending this set is the right move
  // when a new YAML source is added.
  return ids
}

const BACKENDS: Array<'sqlite' | 'pglite'> = ['sqlite', 'pglite']

for (const backend of BACKENDS) {
describe(`yaml-as-truth: public API traceability (Test B) [backend=${backend}]`, () => {
  let dir: string
  let plur: Plur
  const originalBackend = process.env.PLUR_BACKEND

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `plur-yaml-truth-trace-${backend}-`))
    process.env.PLUR_BACKEND = backend
    plur = new Plur({ path: dir })

    plur.learn('verify dates with datacore.date', {
      scope: 'project:plur',
      domain: 'workflow.dates',
      type: 'procedural',
    })
    plur.learn('YAML is the source of truth', {
      scope: 'project:plur',
      domain: 'plur.architecture',
      type: 'architectural',
    })
    plur.learn('the user prefers terse responses', {
      scope: 'global',
      domain: 'workflow.communication',
      type: 'behavioral',
    })
    plur.learn('embedding choice dominates fusion choice', {
      scope: 'project:plur',
      domain: 'plur.retrieval',
      type: 'terminological',
    })
  })

  afterEach(() => {
    if (originalBackend === undefined) delete process.env.PLUR_BACKEND
    else process.env.PLUR_BACKEND = originalBackend
    rmSync(dir, { recursive: true, force: true })
  })

  it('list() returns only engrams present in YAML', () => {
    const truth = yamlGroundTruth(dir)
    const returned = plur.list()
    expect(returned.length).toBeGreaterThan(0)
    for (const e of returned) {
      expect(truth.has(e.id),
        `list returned ${e.id} which is NOT in YAML ground truth — ` +
        `this is a YAML-as-truth invariant violation (#249)`
      ).toBe(true)
    }
  })

  it('recall() returns only engrams present in YAML', () => {
    const truth = yamlGroundTruth(dir)
    const returned = plur.recall('source of truth')
    expect(returned.length).toBeGreaterThan(0)
    for (const e of returned) {
      expect(truth.has(e.id),
        `recall returned ${e.id} which is NOT in YAML ground truth`
      ).toBe(true)
    }
  })

  it('recallHybrid() returns only engrams present in YAML', async () => {
    const truth = yamlGroundTruth(dir)
    const returned = await plur.recallHybrid('source of truth')
    for (const e of returned) {
      expect(truth.has(e.id),
        `recallHybrid returned ${e.id} which is NOT in YAML ground truth`
      ).toBe(true)
    }
  })

  it('inject() returns only engrams present in YAML', () => {
    const truth = yamlGroundTruth(dir)
    const result = plur.inject('about to merge a PR')
    for (const id of result.injected_ids) {
      expect(truth.has(id),
        `inject returned ${id} which is NOT in YAML ground truth`
      ).toBe(true)
    }
  })

  it('getById() returns only engrams present in YAML', () => {
    const truth = yamlGroundTruth(dir)
    const ids = Array.from(truth)
    for (const id of ids) {
      const e = plur.getById(id)
      expect(e).not.toBeNull()
      expect(truth.has(e!.id)).toBe(true)
    }
  })

  it('getById() returns null for ids not in YAML', () => {
    expect(plur.getById('ENG-9999-9999-999')).toBeNull()
  })

  it('list with scope filter returns only YAML-backed engrams', () => {
    const truth = yamlGroundTruth(dir)
    const returned = plur.list({ scope: 'project:plur' })
    for (const e of returned) {
      expect(truth.has(e.id)).toBe(true)
    }
  })

  it('every returned engram has its YAML-derived fields intact', () => {
    const truth = yamlGroundTruth(dir)
    const yamlEngrams = loadEngrams(join(dir, 'engrams.yaml'))
    const byId = new Map(yamlEngrams.map(e => [e.id, e]))

    for (const returned of plur.list()) {
      expect(truth.has(returned.id)).toBe(true)
      const yaml = byId.get(returned.id)!
      // Core authoritative fields must match YAML exactly — these cannot
      // be DB-only because they're what gets shipped in packs / synced
      // via git.
      expect(returned.statement).toBe(yaml.statement)
      expect(returned.scope).toBe(yaml.scope)
      expect(returned.type).toBe(yaml.type)
      expect(returned.status).toBe(yaml.status)
    }
  })
})
}

// Iter-2 audit M-2: adversarial Test B variant — insert a synthetic engram
// directly into PGLite (bypassing the YAML write path) and confirm no public
// method surfaces it. The original Test B trivially passed because every
// read path was YAML-rooted; this variant exercises the wired PGLite path
// (B-1) and proves the intersect-with-filtered defense.
//
// Iter-3 audit F-DATA-NEW-001 / F-DATA-004: the original M-2 test only
// inserted into `engram_embeddings`, but `searchVector` does
// `JOIN engrams e ON e.id = em.engram_id` and silently drops orphan rows
// at SQL level — so the application-level intersect-with-filtered defense
// (index.ts:1228, 1267) was never actually exercised. Iter-4 strengthens
// the test to insert into BOTH `engrams` AND `engram_embeddings` via the
// adapter's internal db handle, then:
//   1. assert `adapter.searchVector` SEES the synthetic row at the storage
//      layer (proves the SQL JOIN no longer drops it),
//   2. assert the public methods STILL hide it (proves the
//      application-level YAML-rooted intersect is the actual defense).
// If the YAML intersect defense were removed (e.g. someone deletes the
// `allowed.get(hit.engram.id)` filter in `_pgliteSemanticRecall` /
// `_pgliteHybridRecall`), `recallHybrid` and `recallSemantic` would surface
// the synthetic id and this test would fail — TDD-rigor for the invariant.
describe('yaml-as-truth Test B — adversarial direct PGLite insert (iter-4 strengthened)', () => {
  let dir: string
  const originalBackend = process.env.PLUR_BACKEND
  const syntheticId = 'ENG-9999-SYNTHETIC-001'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-yaml-truth-adv-'))
    process.env.PLUR_BACKEND = 'pglite'
  })

  afterEach(() => {
    if (originalBackend === undefined) delete process.env.PLUR_BACKEND
    else process.env.PLUR_BACKEND = originalBackend
    rmSync(dir, { recursive: true, force: true })
  })

  // Helper — build a valid Engram body for raw-insert into the engrams table.
  function syntheticEngramRow(id: string) {
    return {
      id,
      version: 2,
      status: 'active' as const,
      consolidated: false,
      type: 'behavioral' as const,
      scope: 'global',
      visibility: 'private' as const,
      statement: 'synthetic engram injected directly into PGLite (no YAML)',
      derivation_count: 1,
      pack: null,
      abstract: null,
      derived_from: null,
      tags: [],
      activation: {
        retrieval_strength: 0.7,
        storage_strength: 1.0,
        frequency: 0,
        last_accessed: new Date().toISOString().slice(0, 10),
      },
      associations: [],
      knowledge_anchors: [],
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      polarity: null,
      reference_count: 1,
      sources: [],
      recurrence_count: 0,
      engram_version: 1,
      episode_ids: [],
    }
  }

  it('a synthetic engram inserted into BOTH PGLite tables is visible at the storage layer but hidden by the YAML-rooted defense', async () => {
    const plur = new Plur({ path: dir })
    plur.learn('legitimate engram from YAML', { type: 'behavioral', scope: 'global' })
    await plur.waitForIndex()

    // Reach into Plur's INTERNAL pgliteAdapter and raw-insert. PGLite is
    // single-writer per process and two PGLiteAdapter instances on the same
    // path don't share state — so to truly compromise the storage layer
    // Plur reads from, we have to write through the same adapter instance
    // Plur uses.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internalAdapter: PGLiteAdapter = (plur as any).pgliteAdapter
    expect(internalAdapter, 'plur instance must have a pgliteAdapter when PLUR_BACKEND=pglite').toBeTruthy()
    // Force schema init.
    await internalAdapter.loadFiltered({})

    // Raw-insert into BOTH `engrams` and `engram_embeddings`, bypassing
    // YAML entirely. This is the actual failure mode Test B should defend
    // against — a future code path (materialized cache, reranker artifact,
    // bulk-import shortcut) that writes to PGLite without going through
    // YAML.
    const row = syntheticEngramRow(syntheticId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (internalAdapter as any).db
    await db.query(
      `INSERT INTO engrams (id, status, scope, domain, last_accessed, data, source)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [row.id, row.status, row.scope, null, row.activation.last_accessed, JSON.stringify(row), 'primary'],
    )
    // Use the actual embedder to embed the query terms we'll search for,
    // and pin the synthetic's embedding to that vector. This guarantees
    // searchVector ranks the synthetic at the top — so if the YAML-rooted
    // intersect defense is removed, the synthetic WILL leak into
    // recallHybrid/recallSemantic results.
    const queryVec = await embed('synthetic engram injected')
    expect(queryVec, 'embedder must produce a vector for this test to exercise the defense').not.toBeNull()
    await internalAdapter.upsertEmbedding(syntheticId, queryVec!)

    // === Storage-layer assertion ===
    // The synthetic row IS visible to `searchVector` now that it lives in
    // both tables — the SQL JOIN no longer drops it. This proves the
    // adversarial insert successfully compromised the storage layer Plur
    // reads from.
    const storageHits = await internalAdapter.searchVector(queryVec!, 50)
    const storageHitIds = storageHits.map(h => h.engram.id)
    expect(storageHitIds, 'storage-layer searchVector must surface the synthetic row — otherwise the test is not actually exercising the YAML-defense').toContain(syntheticId)

    // === Application-layer assertions ===
    // Despite the storage layer being compromised, the public methods MUST
    // NOT surface the synthetic id — because they intersect vector hits
    // with the YAML-rooted `filtered` set (index.ts:1228, 1267) and the
    // YAML ground truth has no record of this id.
    const truth = yamlGroundTruth(dir)
    expect(truth.has(syntheticId), 'YAML ground truth must NOT contain the synthetic id').toBe(false)

    // getById reads only from YAML — straightforward.
    expect(plur.getById(syntheticId)).toBeNull()

    // list / recall read from YAML — straightforward.
    for (const e of plur.list()) {
      expect(e.id).not.toBe(syntheticId)
      expect(truth.has(e.id)).toBe(true)
    }
    for (const e of plur.recall('synthetic')) {
      expect(e.id).not.toBe(syntheticId)
    }

    // recallHybrid / recallSemantic go through `_pgliteHybridRecall` /
    // `_pgliteSemanticRecall` which call `pgliteAdapter.searchVector` (we
    // just proved that returns the synthetic). The intersect-with-filtered
    // defense at index.ts:1228, 1267 is what keeps the synthetic out. We
    // search with the SAME query string we embedded into the synthetic, so
    // searchVector returns the synthetic at rank 1 — if someone removes
    // the YAML-rooted intersect, these assertions will fail.
    for (const e of await plur.recallHybrid('synthetic engram injected')) {
      expect(e.id, 'recallHybrid must NOT surface the synthetic id (YAML-rooted intersect defense)').not.toBe(syntheticId)
    }
    for (const e of await plur.recallSemantic('synthetic engram injected')) {
      expect(e.id, 'recallSemantic must NOT surface the synthetic id (YAML-rooted intersect defense)').not.toBe(syntheticId)
    }

    // inject is the highest-level public surface — must also hide it.
    const injectResult = plur.inject('synthetic engram injected')
    expect(injectResult.injected_ids, 'inject must NOT surface the synthetic id').not.toContain(syntheticId)
  }, 30_000)
})
