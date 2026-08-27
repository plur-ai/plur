/**
 * #1046 migration path: vectors leave the orphaned PGLite store and land in
 * the JSON embeddings cache — but ONLY the ones still valid.
 *
 * The two stores key vectors incompatibly (md5 vs sha256-16 of the search
 * text), so the export re-verifies freshness against the engram's CURRENT
 * text and re-keys under the cache's own discipline. A stale vector must
 * never port: it would silently poison ranking, and the background embed
 * pass regenerates it anyway.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import { exportPgliteEmbeddingsToCache } from '../src/pglite-embeddings-export.js'
import { embeddingContentHash } from '../src/fts.js'
import type { Engram } from '../src/schemas/engram.js'

const PGLITE_TIMEOUT = 60_000
const DIM = 384 // the default embedder's (bge-small) dimension — metadata only, no model load

function mkEngram(id: string, statement: string): Engram {
  return {
    id,
    statement,
    type: 'behavioral',
    scope: 'project:plur',
    domain: 'plur.test',
    status: 'active',
    tags: [],
    activation: { retrieval_strength: 1.0, storage_strength: 1.0, frequency: 0, last_accessed: '2026-08-27' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  } as Engram
}

function vec(seed: number): Float32Array {
  const v = new Float32Array(DIM)
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed + i)
  return v
}

describe('exportPgliteEmbeddingsToCache (#1046)', () => {
  let dir: string
  let adapter: PGLiteAdapter

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-emb-export-')) })
  afterEach(async () => {
    await adapter?.close?.()
    rmSync(dir, { recursive: true, force: true })
  })

  it('ports fresh vectors, skips stale and orphaned ones, and re-keys for the cache', async () => {
    const yamlPath = join(dir, 'engrams.yaml')
    const fresh = mkEngram('ENG-FRESH', 'unchanged since the vector was computed')
    const edited = mkEngram('ENG-EDITED', 'text as it is NOW, after an edit')
    writeFileSync(yamlPath, yaml.dump({ engrams: [fresh, edited] }), 'utf8')

    adapter = new PGLiteAdapter(yamlPath, join(dir, 'store.pglite'), { vectorDim: DIM })
    await adapter.syncFromYaml()
    // Fresh: hash matches the current text. Stale: hash of some OLDER text.
    await adapter.upsertEmbedding('ENG-FRESH', vec(1), embeddingContentHash(fresh))
    await adapter.upsertEmbedding('ENG-EDITED', vec(2), 'md5-of-text-that-no-longer-exists')
    // Orphaned: an id no longer present in YAML at all.
    await adapter.upsertEmbedding('ENG-FRESH', vec(1), embeddingContentHash(fresh)) // idempotent re-upsert
    const db = await (adapter as unknown as { getDb: () => Promise<{ query: (q: string, p?: unknown[]) => Promise<unknown> }> }).getDb()
    await db.query(
      "INSERT INTO engrams (id, status, scope, domain, last_accessed, data, source) VALUES ('ENG-GONE','active','global',NULL,NULL,'{}'::jsonb,'primary')",
    )
    await adapter.upsertEmbedding('ENG-GONE', vec(3), 'whatever')
    await adapter.close()

    const report = await exportPgliteEmbeddingsToCache(dir, yamlPath, join(dir, 'store.pglite'))

    expect(report.status).toBe('done')
    expect(report.ported).toBe(1)
    expect(report.stale).toBe(1)
    expect(report.orphaned).toBe(1)

    const cache = JSON.parse(readFileSync(join(dir, '.embeddings-cache.json'), 'utf8')) as {
      meta: { embedder_dim: number }
      entries: Record<string, { hash: string; embedding: number[] }>
    }
    expect(Object.keys(cache.entries)).toEqual(['ENG-FRESH'])
    expect(cache.entries['ENG-FRESH'].embedding).toHaveLength(DIM)
    // Re-keyed: the cache hash is sha256-16, NOT the md5 PGLite stored.
    expect(cache.entries['ENG-FRESH'].hash).toHaveLength(16)
    expect(cache.entries['ENG-FRESH'].hash).not.toBe(embeddingContentHash(fresh))
    expect(cache.meta.embedder_dim).toBe(DIM)
  }, PGLITE_TIMEOUT)

  it('is a no-op without a store, and safe to re-run without clobbering newer cache entries', async () => {
    expect((await exportPgliteEmbeddingsToCache(dir)).status).toBe('no-store')

    const yamlPath = join(dir, 'engrams.yaml')
    const e = mkEngram('ENG-A', 'some statement')
    writeFileSync(yamlPath, yaml.dump({ engrams: [e] }), 'utf8')
    adapter = new PGLiteAdapter(yamlPath, join(dir, 'store.pglite'), { vectorDim: DIM })
    await adapter.syncFromYaml()
    await adapter.upsertEmbedding('ENG-A', vec(7), embeddingContentHash(e))
    await adapter.close()

    const first = await exportPgliteEmbeddingsToCache(dir, yamlPath, join(dir, 'store.pglite'))
    expect(first.ported).toBe(1)
    const before = readFileSync(join(dir, '.embeddings-cache.json'), 'utf8')

    // Re-run: existing entries win, nothing rewritten.
    const second = await exportPgliteEmbeddingsToCache(dir, yamlPath, join(dir, 'store.pglite'))
    expect(second.ported).toBe(0)
    expect(readFileSync(join(dir, '.embeddings-cache.json'), 'utf8')).toBe(before)
    expect(existsSync(join(dir, 'store.pglite'))).toBe(true) // export never deletes
  }, PGLITE_TIMEOUT)
})
