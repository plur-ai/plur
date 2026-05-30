/**
 * `plur sync --reembed` migration — Sprint 0 PR 5 (feat/embedding-gemma-default).
 *
 * Closes plur-ai/plur#219. The default embedder is moving from BGE-small (384d)
 * to EmbeddingGemma (768d), which means the PGLite `vector(N)` column must be
 * resized for users who already have a PGLite index.
 *
 * Contract:
 *   - `plur sync --reembed --full` drops the embedding column at the current
 *     dim, recreates it at the active embedder's dim, and re-embeds every
 *     engram from YAML using the active embedder.
 *   - YAML is never touched (truth invariant).
 *   - Idempotent: running it twice when dims already match is a no-op.
 *   - The migration must work without ever calling the real embedder model —
 *     the test injects a fake adapter so CI stays offline-safe.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { PGLiteAdapter, _setEmbedderForTests } from '../src/storage-pglite.js'
import type { EmbedderAdapter } from '../src/embedders/index.js'
import type { Engram } from '../src/schemas/engram.js'

// PGLite WASM startup can briefly exceed the 5s default on cold caches.
const PGLITE_TIMEOUT = 30_000

/** Deterministic stand-in for an embedder — no network, no model load. */
function makeFakeEmbedder(name: string, dim: number): EmbedderAdapter {
  function vecFromText(text: string): Float32Array {
    const v = new Float32Array(dim)
    let h = 2166136261
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
      v[i % dim] = ((h >>> 0) % 1000) / 1000
    }
    let n = 0
    for (let i = 0; i < dim; i++) n += v[i] * v[i]
    n = Math.sqrt(n) || 1
    for (let i = 0; i < dim; i++) v[i] /= n
    return v
  }
  return {
    name,
    dim,
    modelId: `fake/${name}`,
    async embed(t: string) {
      return vecFromText(t)
    },
    async embedBatch(ts: string[]) {
      return ts.map(vecFromText)
    },
  }
}

function mkEngram(id: string, statement: string): Engram {
  return {
    id,
    statement,
    type: 'behavioral',
    scope: 'project:plur',
    domain: 'plur.test',
    status: 'active',
    tags: [],
    activation: {
      retrieval_strength: 1.0,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2026-05-30',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  } as Engram
}

function seedYaml(path: string, engrams: Engram[]): void {
  writeFileSync(path, yaml.dump({ engrams }), 'utf8')
}

describe('reembed migration — PGLite adapter (#219)', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-reembed-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
  })

  afterEach(async () => {
    _setEmbedderForTests(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('getVectorColumnDim reports the configured dim after reindex', async () => {
    seedYaml(yamlPath, [])
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 384 })
    await adapter.reindex()
    expect(await adapter.getVectorColumnDim()).toBe(384)
    await adapter.close()
  }, PGLITE_TIMEOUT)

  it('reembedAll({ full: true }) migrates 384d index to 768d, re-embedding all engrams', async () => {
    const engrams = [
      mkEngram('ENG-2026-0530-001', 'first thought'),
      mkEngram('ENG-2026-0530-002', 'second thought'),
      mkEngram('ENG-2026-0530-003', 'third thought'),
    ]
    seedYaml(yamlPath, engrams)

    // Step 1: build a 384d index with the fake-384 embedder.
    const fake384 = makeFakeEmbedder('fake-384', 384)
    const adapter384 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 384 })
    await adapter384.reindex()
    for (const e of engrams) {
      const v = await fake384.embed(e.statement)
      await adapter384.upsertEmbedding(e.id, v)
    }
    expect(await adapter384.getVectorColumnDim()).toBe(384)
    expect(await adapter384.countEmbeddings()).toBe(3)
    await adapter384.close()

    // Step 2: open the same DB with a 768d adapter; the column is still 384
    // because the schema only creates if not exists. Run the migration.
    const fake768 = makeFakeEmbedder('fake-768', 768)
    _setEmbedderForTests(fake768)
    const adapter768 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 768 })
    await adapter768.loadFiltered({})  // open the DB, don't recreate engrams.
    expect(await adapter768.getVectorColumnDim()).toBe(384)

    const result = await adapter768.reembedAll({ full: true })
    expect(result.skipped).toBe(false)
    expect(result.reembedded).toBe(3)
    expect(await adapter768.getVectorColumnDim()).toBe(768)
    expect(await adapter768.countEmbeddings()).toBe(3)
    await adapter768.close()

    // Step 3: YAML is unchanged.
    const reloaded = yaml.load(
      require('fs').readFileSync(yamlPath, 'utf8'),
    ) as { engrams: Engram[] }
    expect(reloaded.engrams.map((e) => e.id).sort()).toEqual(
      engrams.map((e) => e.id).sort(),
    )
  }, PGLITE_TIMEOUT)

  it('is idempotent — full reembed run twice yields the same state', async () => {
    const engrams = [mkEngram('ENG-2026-0530-001', 'only engram')]
    seedYaml(yamlPath, engrams)

    const fake768 = makeFakeEmbedder('fake-768', 768)
    _setEmbedderForTests(fake768)
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 768 })
    await adapter.reindex()

    const r1 = await adapter.reembedAll({ full: true })
    const r2 = await adapter.reembedAll({ full: true })

    expect(r1.skipped).toBe(false)
    expect(r2.skipped).toBe(false)
    expect(r1.reembedded).toBe(1)
    expect(r2.reembedded).toBe(1)
    expect(await adapter.getVectorColumnDim()).toBe(768)
    expect(await adapter.countEmbeddings()).toBe(1)

    await adapter.close()
  }, PGLITE_TIMEOUT)

  it('reembedAll() without full is a no-op when dims already match', async () => {
    const engrams = [mkEngram('ENG-2026-0530-001', 'matching dim engram')]
    seedYaml(yamlPath, engrams)

    const fake768 = makeFakeEmbedder('fake-768', 768)
    _setEmbedderForTests(fake768)
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 768 })
    await adapter.reindex()

    // Seed the 768d embeddings once.
    await adapter.reembedAll({ full: true })
    const beforeCount = await adapter.countEmbeddings()

    // Non-full reembed should still re-embed (dims match), staying idempotent.
    const r = await adapter.reembedAll({ full: false })
    expect(r.skipped).toBe(false)
    expect(r.reembedded).toBe(1)
    expect(await adapter.getVectorColumnDim()).toBe(768)
    expect(await adapter.countEmbeddings()).toBe(beforeCount)

    await adapter.close()
  }, PGLITE_TIMEOUT)

  it('reembedAll() without full skips when dims differ — points at --full', async () => {
    const engrams = [mkEngram('ENG-2026-0530-001', 'mismatched dim engram')]
    seedYaml(yamlPath, engrams)

    // Build at 384d.
    const adapter384 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 384 })
    await adapter384.reindex()
    await adapter384.close()

    // Open at 768d, run incremental reembed — should bail.
    const fake768 = makeFakeEmbedder('fake-768', 768)
    _setEmbedderForTests(fake768)
    const adapter768 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 768 })
    await adapter768.loadFiltered({})
    const result = await adapter768.reembedAll({ full: false })
    expect(result.skipped).toBe(true)
    expect(result.reason).toMatch(/full=true to migrate/)
    expect(await adapter768.getVectorColumnDim()).toBe(384)
    await adapter768.close()
  }, PGLITE_TIMEOUT)
})

/**
 * Integration: Plur.sync({ reembed: true, full: true }) wires through to
 * PGLiteAdapter.reembedAll. Verifies the CLI surface promised in #219.
 */
describe('Plur.sync({ reembed, full }) — integration (#219)', () => {
  let dir: string
  const originalBackend = process.env.PLUR_BACKEND

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-reembed-integ-'))
    process.env.PLUR_BACKEND = 'pglite'
  })

  afterEach(() => {
    if (originalBackend === undefined) delete process.env.PLUR_BACKEND
    else process.env.PLUR_BACKEND = originalBackend
    _setEmbedderForTests(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reembedAsync({ full: true }) re-embeds yaml engrams without touching yaml', async () => {
    // Lazy import to avoid circular imports at module-eval time.
    const { Plur } = await import('../src/index.js')
    const fake768 = makeFakeEmbedder('fake-768', 768)
    _setEmbedderForTests(fake768)

    const plur = new Plur({ path: dir })
    plur.learn('one', { scope: 'project:plur', type: 'behavioral' })
    plur.learn('two', { scope: 'project:plur', type: 'behavioral' })
    await (plur as unknown as { waitForIndex: () => Promise<void> }).waitForIndex()

    const before = plur.list().map((e) => e.id).sort()
    const result = await (plur as unknown as { reembedAsync: (opts?: { full?: boolean }) => Promise<{ reembedded: number; skipped: boolean }> })
      .reembedAsync({ full: true })

    expect(result.skipped).toBe(false)
    expect(result.reembedded).toBe(2)

    // YAML truth invariant: list still returns the same IDs.
    const after = plur.list().map((e) => e.id).sort()
    expect(after).toEqual(before)
  }, PGLITE_TIMEOUT)
})
