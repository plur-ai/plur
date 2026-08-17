/**
 * EMBED_DIM contract — #335 (Sprint-0 integration C).
 *
 * The resolved design (option 2 + derived accessor, per the issue):
 *   - `EMBED_DIM = 384` stays exported as the DEFAULT embedder's dim only —
 *     a documented back-compat constant, pinned to `bge-small`.
 *   - `activeEmbedderDim()` is the source of truth for the dim this install
 *     actually produces (PLUR_EMBEDDER-dependent: 384 / 768 / 3072).
 *   - `embed()` asserts every adapter output against the adapter's DECLARED
 *     dim — a model/adapter disagreement throws instead of persisting
 *     corrupt vectors.
 *   - The storage boundary re-enforces dim-correctness: the PGLite vector
 *     column is sized from the ACTIVE embedder (not the 384 constant), and
 *     `upsertEmbedding` rejects wrong-shape vectors with a targeted error on
 *     BOTH the pgvector and BYTEA paths (BYTEA previously persisted any
 *     length silently — the exact #290-style silent drift #335 forbids).
 *
 * Cross-shape equivalence (ADR-0001): YAML stays the source of truth and the
 * index is rebuildable at ANY supported shape — the same store roundtrips
 * identically whether the vector column is 384 (bge-small, default),
 * 768 (EmbeddingGemma / bge-base) or 3072 (openai-3-large).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import { Plur } from '../src/index.js'
import {
  EMBED_DIM,
  activeEmbedderDim,
  embed,
  resetEmbedder,
  _setCachedEmbedder,
} from '../src/embeddings.js'
import { getEmbedder, DEFAULT_EMBEDDER, _resetEmbedderCache } from '../src/embedders/index.js'
import type { Engram } from '../src/schemas/engram.js'

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
  } as unknown as Engram
}

function seedYaml(path: string, engrams: Engram[]): void {
  writeFileSync(path, yaml.dump({ engrams }), 'utf8')
}

/** Deterministic unit vector of a given dim (varies by seed so cosine ranks are stable). */
function vec(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed * 997 + i)
  let norm = 0
  for (let i = 0; i < dim; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm)
  for (let i = 0; i < dim; i++) v[i] /= norm
  return v
}

const PGLITE_TIMEOUT = 60_000

// ─── The exported constant: default-only, factory-derived reality ────

describe('EMBED_DIM constant vs factory dims (#335)', () => {
  it('EMBED_DIM equals the DEFAULT embedder dim (bge-small, 384) — and nothing else', () => {
    expect(EMBED_DIM).toBe(384)
    expect(getEmbedder(DEFAULT_EMBEDDER).dim).toBe(EMBED_DIM)
    expect(DEFAULT_EMBEDDER).toBe('bge-small')
  })

  it('the three contract shapes: bge-small 384, embedding-gemma 768, openai-3-large 3072', () => {
    expect(getEmbedder('bge-small').dim).toBe(384)
    expect(getEmbedder('embedding-gemma').dim).toBe(768)
    expect(getEmbedder('openai-3-large').dim).toBe(3072)
  })
})

// ─── embed() output assertion + activeEmbedderDim ────────────────────

describe('embed() asserts declared vs produced dim (#335 / #290)', () => {
  afterEach(() => {
    resetEmbedder()
    _resetEmbedderCache()
  })

  it('returns the vector when the adapter honors its declared dim', async () => {
    _setCachedEmbedder({
      name: 'stub-768',
      dim: 768,
      modelId: 'stub',
      embed: async () => vec(768, 1),
      embedBatch: async (texts: string[]) => texts.map((_, i) => vec(768, i)),
    })
    const out = await embed('hello')
    expect(out).not.toBeNull()
    expect(out!.length).toBe(768)
    expect(await activeEmbedderDim()).toBe(768)
  })

  it('THROWS (not null) when the adapter produces a different dim than declared', async () => {
    _setCachedEmbedder({
      name: 'stub-liar',
      dim: 768,
      modelId: 'stub',
      embed: async () => vec(384, 1), // model disagrees with declaration
      embedBatch: async (texts: string[]) => texts.map((_, i) => vec(384, i)),
    })
    await expect(embed('hello')).rejects.toThrow(/dimension mismatch/i)
  })
})

// ─── Storage boundary: PGLite column sized + writes enforced ─────────

describe.each([
  { embedderName: 'bge-small', dim: 384 },
  { embedderName: 'embedding-gemma', dim: 768 },
  { embedderName: 'openai-3-large', dim: 3072 },
])('PGLite cross-shape roundtrip at $dim d ($embedderName) — ADR-0001 (#335)', ({ dim }) => {
  let dir: string
  let yamlPath: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-dim-contract-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it(`sizes the column to ${dim}, roundtrips vectors, rejects wrong shapes, and rebuilds from YAML`, async () => {
    seedYaml(yamlPath, [mkEngram('ENG-A', 'alpha statement'), mkEngram('ENG-B', 'beta statement')])
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: dim })
    try {
      await adapter.reindex()

      // Column is sized to the active shape (pgvector path only — BYTEA has no column dim).
      const colDim = await adapter.getVectorColumnDim()
      if (colDim !== null) expect(colDim).toBe(dim)

      // Correct-shape writes roundtrip: nearest neighbor of A's vector is A.
      await adapter.upsertEmbedding('ENG-A', vec(dim, 1))
      await adapter.upsertEmbedding('ENG-B', vec(dim, 2))
      const hits = await adapter.searchVector(vec(dim, 1), 2)
      expect(hits.length).toBe(2)
      expect(hits[0].engram.id).toBe('ENG-A')
      expect(hits[0].score).toBeGreaterThan(0.99)

      // Wrong-shape writes are REJECTED with a targeted error — on the
      // pgvector path (clear message instead of a cryptic pgvector error)
      // and on the BYTEA path (previously silently persisted). Assert OUR
      // guard's message, not pgvector's, so the BYTEA-shared code path is
      // what's proven.
      await expect(adapter.upsertEmbedding('ENG-B', vec(dim + 8, 3)))
        .rejects.toThrow(new RegExp(`Refusing to persist a ${dim + 8}-dim embedding.*${dim}-dim`, 's'))

      // The rejected write must not have clobbered the good vector.
      const stillGood = await adapter.searchVector(vec(dim, 2), 1)
      expect(stillGood[0].engram.id).toBe('ENG-B')

      // ADR-0001 rebuildability: reindex() drops + rebuilds rows from YAML
      // at the same shape; engram rows survive, embeddings are rebuildable.
      await adapter.reindex()
      const all = await adapter.loadFiltered({})
      expect(all.map(e => e.id).sort()).toEqual(['ENG-A', 'ENG-B'])
      await adapter.upsertEmbedding('ENG-A', vec(dim, 1))
      const postRebuild = await adapter.searchVector(vec(dim, 1), 1)
      expect(postRebuild[0].engram.id).toBe('ENG-A')
    } finally {
      await adapter.close()
    }
  }, PGLITE_TIMEOUT)
})

// ─── Plur wires the ACTIVE embedder dim into the column ──────────────

describe('Plur constructor sizes the PGLite column from the active embedder (#335)', () => {
  let dir: string
  const savedBackend = process.env.PLUR_BACKEND
  const savedEmbedder = process.env.PLUR_EMBEDDER

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-dim-plur-'))
    process.env.PLUR_BACKEND = 'pglite'
  })

  afterEach(() => {
    if (savedBackend === undefined) delete process.env.PLUR_BACKEND
    else process.env.PLUR_BACKEND = savedBackend
    if (savedEmbedder === undefined) delete process.env.PLUR_EMBEDDER
    else process.env.PLUR_EMBEDDER = savedEmbedder
    _resetEmbedderCache()
    rmSync(dir, { recursive: true, force: true })
  })

  it('default install → 384 column (EMBED_DIM back-compat holds)', async () => {
    delete process.env.PLUR_EMBEDDER
    const plur = new Plur({ path: dir })
    const adapter = (plur as any).pgliteAdapter as PGLiteAdapter
    expect(adapter).toBeTruthy()
    try {
      await plur.waitForIndex()
      const colDim = await adapter.getVectorColumnDim()
      if (colDim !== null) expect(colDim).toBe(EMBED_DIM)
    } finally {
      await adapter.close()
    }
  }, PGLITE_TIMEOUT)

  it('PLUR_EMBEDDER=bge-base → 768 column, NOT the 384 constant', async () => {
    process.env.PLUR_EMBEDDER = 'bge-base'
    const plur = new Plur({ path: dir })
    const adapter = (plur as any).pgliteAdapter as PGLiteAdapter
    expect(adapter).toBeTruthy()
    try {
      await plur.waitForIndex()
      const colDim = await adapter.getVectorColumnDim()
      if (colDim !== null) expect(colDim).toBe(768)
    } finally {
      await adapter.close()
    }
  }, PGLITE_TIMEOUT)
})
