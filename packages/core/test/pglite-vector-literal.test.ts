/**
 * vectorLiteral throws on non-finite floats — Sprint 0 iter-2 audit M-4
 * (Dijkstra F-DIJK-001, Data F-DATA-008).
 *
 * Before this fix: NaN / +Infinity / -Infinity in an embedding silently
 * became "0" in the pgvector text literal. Search proceeded with a
 * corrupted query but no error, giving mediocre recall forever.
 *
 * After this fix: the substitution is gone; vectorLiteral throws a typed
 * error pointing at the offending index. The error surfaces at the storage
 * boundary where the bug is most actionable (embedder regression test
 * comes next to repro the upstream cause).
 *
 * Reached through upsertEmbedding / searchVector — both go through
 * vectorLiteral on the pgvector path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PGLiteAdapter } from '../src/storage-pglite.js'

const PGLITE_TIMEOUT = 30_000

describe('vectorLiteral non-finite handling (iter-2 audit M-4)', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-vector-literal-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
    writeFileSync(yamlPath, '[]')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('throws on NaN in upsertEmbedding (instead of silently substituting 0)', async () => {
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 4 })
    await adapter.reindex()
    const bad = new Float32Array([0.1, NaN, 0.3, 0.4])
    await expect(adapter.upsertEmbedding('bad-1', bad))
      .rejects.toThrow(/non-finite/)
    await adapter.close()
  }, PGLITE_TIMEOUT)

  it('throws on +Infinity in searchVector query', async () => {
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 4 })
    await adapter.reindex()
    // searchVector short-circuits on empty table — seed one good vector
    // first so the query path actually runs vectorLiteral on the bad query.
    await adapter.upsertEmbedding('seed', new Float32Array([0.5, 0.5, 0.5, 0.5]))
    const bad = new Float32Array([0.1, Infinity, 0.3, 0.4])
    await expect(adapter.searchVector(bad, 5))
      .rejects.toThrow(/non-finite/)
    await adapter.close()
  }, PGLITE_TIMEOUT)

  it('throws on -Infinity with a clear message including the index', async () => {
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 4 })
    await adapter.reindex()
    const bad = new Float32Array([0.1, 0.2, -Infinity, 0.4])
    await expect(adapter.upsertEmbedding('bad-2', bad))
      .rejects.toThrow(/index 2/)
    await adapter.close()
  }, PGLITE_TIMEOUT)

  it('accepts an all-finite vector without throwing', async () => {
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 4 })
    await adapter.reindex()
    const good = new Float32Array([0.1, 0.2, 0.3, 0.4])
    await adapter.upsertEmbedding('good-1', good)
    expect(await adapter.countEmbeddings()).toBe(1)
    await adapter.close()
  }, PGLITE_TIMEOUT)
})
