/**
 * Vector precision tiers on the PGLite embedding column — issue #223.
 *
 * Contract:
 * - `precision: 'halfvec'` stores embeddings in a pgvector `halfvec(N)`
 *   (float16) column — ~50% the storage of the float32 `vector(N)` default.
 * - The knob is a DB-only concern. YAML stays the source of truth (ADR-0001);
 *   the column can be migrated in place or rebuilt from YAML at any time.
 * - Backward compatible both ways:
 *     - An EXISTING float32 store opened with `precision: 'halfvec'` is
 *       migrated lazily on init via an atomic
 *       `ALTER TABLE ... TYPE halfvec(N) USING embedding::halfvec(N)`.
 *       Embeddings are preserved (cast, not re-embedded).
 *     - An existing halfvec store opened WITHOUT a precision option keeps its
 *       halfvec column — omitting the option means "keep what's there",
 *       never "migrate back to float32".
 * - Search behavior is unchanged: same SQL shape, same score orientation
 *   (cosine similarity, higher = closer), fp16 rounding on the stored side.
 *
 * Feasibility (verified 2026-07-02 against the runtime this repo ships):
 * PGLite 0.4.6 bundles PostgreSQL 17.5 + pgvector 0.8.1 (halfvec landed in
 * pgvector 0.7.0). halfvec columns, `<=>` cosine, the vector→halfvec ALTER
 * cast, and hnsw halfvec_cosine_ops all work in the WASM build.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import { PlurConfigSchema } from '../src/schemas/config.js'
import type { Engram } from '../src/schemas/engram.js'

function mkEngram(id: string, statement: string, opts: Partial<Engram> = {}): Engram {
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
      last_accessed: '2026-07-02',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    ...(opts as any),
  } as Engram
}

function seedYaml(path: string, engrams: Engram[]): void {
  writeFileSync(path, yaml.dump({ engrams }), 'utf8')
}

/** Deterministic 8-dim unit-ish vectors with well-separated directions. */
function vec(values: number[]): Float32Array {
  return new Float32Array(values)
}

const PGLITE_TIMEOUT = 30_000

describe('PGLite vector precision (#223)', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-pglite-prec-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('column type selection', () => {
    it('defaults to float32 vector(N) when precision is omitted (existing behavior)', async () => {
      seedYaml(yamlPath, [mkEngram('ENG-2026-0702-001', 'alpha')])
      const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8 })
      await adapter.reindex()
      expect(await adapter.getVectorColumnType()).toBe('vector')
      expect(await adapter.getVectorColumnDim()).toBe(8)
      await adapter.close()
    }, PGLITE_TIMEOUT)

    it("creates a halfvec(N) column when precision is 'halfvec'", async () => {
      seedYaml(yamlPath, [mkEngram('ENG-2026-0702-001', 'alpha')])
      const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8, precision: 'halfvec' })
      await adapter.reindex()
      expect(await adapter.getVectorColumnType()).toBe('halfvec')
      // getVectorColumnDim must parse halfvec(N) too — the auto-embed
      // dim-check depends on it.
      expect(await adapter.getVectorColumnDim()).toBe(8)
      await adapter.close()
    }, PGLITE_TIMEOUT)
  })

  describe('search at halfvec precision', () => {
    it('upsert + searchVector work on a halfvec column with correct ordering', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0702-001', 'north'),
        mkEngram('ENG-2026-0702-002', 'east'),
        mkEngram('ENG-2026-0702-003', 'diagonal'),
      ])
      const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8, precision: 'halfvec' })
      await adapter.reindex()
      await adapter.upsertEmbedding('ENG-2026-0702-001', vec([1, 0, 0, 0, 0, 0, 0, 0]))
      await adapter.upsertEmbedding('ENG-2026-0702-002', vec([0, 1, 0, 0, 0, 0, 0, 0]))
      await adapter.upsertEmbedding('ENG-2026-0702-003', vec([0.9, 0.1, 0, 0, 0, 0, 0, 0]))

      const hits = await adapter.searchVector(vec([1, 0, 0, 0, 0, 0, 0, 0]), 3)
      expect(hits.map(h => h.engram.id)).toEqual([
        'ENG-2026-0702-001',
        'ENG-2026-0702-003',
        'ENG-2026-0702-002',
      ])
      // Cosine similarity orientation preserved: exact match ≈ 1 (fp16 rounding).
      expect(hits[0].score).toBeGreaterThan(0.999)
      expect(hits[2].score).toBeLessThan(0.01)
      await adapter.close()
    }, PGLITE_TIMEOUT)

    it('halfvec ranking matches float32 ranking on the same data (recall parity)', async () => {
      const ids = ['ENG-2026-0702-001', 'ENG-2026-0702-002', 'ENG-2026-0702-003', 'ENG-2026-0702-004']
      seedYaml(yamlPath, ids.map((id, i) => mkEngram(id, `engram ${i}`)))
      // Deterministic pseudo-random vectors, same for both stores.
      const vectors = ids.map((_, i) =>
        vec(Array.from({ length: 8 }, (_, j) => Math.sin(i * 8 + j + 1))),
      )
      const query = vec(Array.from({ length: 8 }, (_, j) => Math.cos(j * 0.7)))

      const dbFull = join(dir, 'full.pglite')
      const dbHalf = join(dir, 'half.pglite')
      const full = new PGLiteAdapter(yamlPath, dbFull, { vectorDim: 8 })
      const half = new PGLiteAdapter(yamlPath, dbHalf, { vectorDim: 8, precision: 'halfvec' })
      await full.reindex()
      await half.reindex()
      for (let i = 0; i < ids.length; i++) {
        await full.upsertEmbedding(ids[i], vectors[i])
        await half.upsertEmbedding(ids[i], vectors[i])
      }
      const fullHits = await full.searchVector(query, 4)
      const halfHits = await half.searchVector(query, 4)
      expect(halfHits.map(h => h.engram.id)).toEqual(fullHits.map(h => h.engram.id))
      for (let i = 0; i < fullHits.length; i++) {
        expect(halfHits[i].score).toBeCloseTo(fullHits[i].score, 2)
      }
      await full.close()
      await half.close()
    }, PGLITE_TIMEOUT)
  })

  describe('lazy migration on init', () => {
    it('migrates an existing float32 store to halfvec, preserving embeddings', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0702-001', 'north'),
        mkEngram('ENG-2026-0702-002', 'east'),
      ])
      const v1 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8 })
      await v1.reindex()
      await v1.upsertEmbedding('ENG-2026-0702-001', vec([1, 0, 0, 0, 0, 0, 0, 0]))
      await v1.upsertEmbedding('ENG-2026-0702-002', vec([0, 1, 0, 0, 0, 0, 0, 0]))
      expect(await v1.getVectorColumnType()).toBe('vector')
      await v1.close()

      // Reopen at halfvec precision — lazy ALTER, no re-embed.
      const v2 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8, precision: 'halfvec' })
      expect(await v2.getVectorColumnType()).toBe('halfvec')
      expect(await v2.countEmbeddings()).toBe(2) // embeddings preserved via cast
      const hits = await v2.searchVector(vec([1, 0, 0, 0, 0, 0, 0, 0]), 2)
      expect(hits[0].engram.id).toBe('ENG-2026-0702-001')
      expect(hits[0].score).toBeGreaterThan(0.999)
      await v2.close()
    }, PGLITE_TIMEOUT)

    it('migrates a halfvec store back to float32 when precision is explicitly float32', async () => {
      seedYaml(yamlPath, [mkEngram('ENG-2026-0702-001', 'north')])
      const v1 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8, precision: 'halfvec' })
      await v1.reindex()
      await v1.upsertEmbedding('ENG-2026-0702-001', vec([1, 0, 0, 0, 0, 0, 0, 0]))
      await v1.close()

      const v2 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8, precision: 'float32' })
      expect(await v2.getVectorColumnType()).toBe('vector')
      expect(await v2.countEmbeddings()).toBe(1)
      const hits = await v2.searchVector(vec([1, 0, 0, 0, 0, 0, 0, 0]), 1)
      expect(hits[0].engram.id).toBe('ENG-2026-0702-001')
      await v2.close()
    }, PGLITE_TIMEOUT)

    it('keeps a halfvec column when reopened WITHOUT a precision option (no silent down-migration)', async () => {
      seedYaml(yamlPath, [mkEngram('ENG-2026-0702-001', 'north')])
      const v1 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8, precision: 'halfvec' })
      await v1.reindex()
      await v1.upsertEmbedding('ENG-2026-0702-001', vec([1, 0, 0, 0, 0, 0, 0, 0]))
      await v1.close()

      // Option-less open — the shape used by dim-check and older callers.
      const v2 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8 })
      expect(await v2.getVectorColumnType()).toBe('halfvec')
      // Reads AND writes still work against the existing halfvec column.
      const hits = await v2.searchVector(vec([1, 0, 0, 0, 0, 0, 0, 0]), 1)
      expect(hits[0].engram.id).toBe('ENG-2026-0702-001')
      await v2.upsertEmbedding('ENG-2026-0702-001', vec([0, 1, 0, 0, 0, 0, 0, 0]))
      await v2.close()
    }, PGLITE_TIMEOUT)

    it('migration preserves the EXISTING column dim, not the configured one', async () => {
      seedYaml(yamlPath, [mkEngram('ENG-2026-0702-001', 'north')])
      // Store created at 8d.
      const v1 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8 })
      await v1.reindex()
      await v1.upsertEmbedding('ENG-2026-0702-001', vec([1, 0, 0, 0, 0, 0, 0, 0]))
      await v1.close()

      // Reopened with a DIFFERENT configured dim (the dim-mismatch scenario,
      // #219) + halfvec. Precision migrates; dim must stay 8 so the
      // auto-embed dim-check keeps flagging the mismatch honestly.
      const v2 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 384, precision: 'halfvec' })
      expect(await v2.getVectorColumnType()).toBe('halfvec')
      expect(await v2.getVectorColumnDim()).toBe(8)
      await v2.close()
    }, PGLITE_TIMEOUT)
  })

  describe('index recreation during migration (gbrain pattern)', () => {
    it('drops and recreates an out-of-band HNSW index with the matching opclass, atomically', async () => {
      seedYaml(yamlPath, [
        mkEngram('ENG-2026-0702-001', 'north'),
        mkEngram('ENG-2026-0702-002', 'east'),
      ])
      const v1 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8 })
      await v1.reindex()
      await v1.upsertEmbedding('ENG-2026-0702-001', vec([1, 0, 0, 0, 0, 0, 0, 0]))
      await v1.upsertEmbedding('ENG-2026-0702-002', vec([0, 1, 0, 0, 0, 0, 0, 0]))
      // Simulate a store where an HNSW index was added out-of-band. Its
      // vector_cosine_ops opclass is type-specific and would block the ALTER.
      const db1 = await (v1 as any).getDb()
      await db1.exec(
        'CREATE INDEX engram_embeddings_hnsw ON engram_embeddings USING hnsw (embedding vector_cosine_ops)',
      )
      await v1.close()

      const v2 = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 8, precision: 'halfvec' })
      expect(await v2.getVectorColumnType()).toBe('halfvec') // migration succeeded despite the index
      const db2 = await (v2 as any).getDb()
      const idx = await db2.query(
        `SELECT am.amname AS method, opc.opcname AS opclass
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_am am ON am.oid = i.relam
         JOIN pg_opclass opc ON opc.oid = x.indclass[0]
         WHERE i.relname = 'engram_embeddings_hnsw'`,
      )
      expect(idx.rows).toHaveLength(1) // index survived the migration...
      expect(idx.rows[0].method).toBe('hnsw')
      expect(idx.rows[0].opclass).toBe('halfvec_cosine_ops') // ...with the swapped opclass
      // Search still works and still ranks correctly through the new column.
      const hits = await v2.searchVector(vec([1, 0, 0, 0, 0, 0, 0, 0]), 2)
      expect(hits[0].engram.id).toBe('ENG-2026-0702-001')
      await v2.close()
    }, PGLITE_TIMEOUT)
  })

  describe('config knob', () => {
    it('parses vector.precision from config', () => {
      const cfg = PlurConfigSchema.parse({ vector: { precision: 'halfvec' } })
      expect(cfg.vector?.precision).toBe('halfvec')
    })

    it('leaves precision undefined when absent (keep-existing semantics)', () => {
      const cfg = PlurConfigSchema.parse({})
      expect(cfg.vector?.precision).toBeUndefined()
    })

    it('rejects unknown precision values', () => {
      expect(() => PlurConfigSchema.parse({ vector: { precision: 'int4' } })).toThrow()
    })
  })
})
