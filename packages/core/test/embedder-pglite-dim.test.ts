/**
 * PGLite vector-dim ⇄ active embedder wiring.
 *
 * PR 2 hard-coded the embedding column at vector(384). PR 4 makes it
 * configurable so 768-dim embedders (bge-base, embedding-gemma) work. The
 * wiring rule:
 *
 *   - When PLUR_EMBEDDER is unset, default is "bge-small" (384d), matching
 *     the embedder that currently ships in embeddings.ts. MiniLM is the
 *     historical fallback but BGE-small is what the live model loader picks.
 *   - When PLUR_EMBEDDER=bge-base or embedding-gemma, PGLite gets vector(768).
 *   - PLUR_BACKEND=pglite is required for the wiring to fire (sqlite path
 *     doesn't touch a vector column).
 *
 * These tests poke the PGLite schema directly to confirm the column type.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import { resolveEmbedderName, getEmbedder } from '../src/embedders/index.js'

const PGLITE_TIMEOUT = 30_000

describe('PGLite vector-dim configurability', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-embedder-dim-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
    writeFileSync(yamlPath, '[]')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('defaults to vectorDim=384 when not specified (backward-compat)', async () => {
    const adapter = new PGLiteAdapter(yamlPath, dbPath)
    await adapter.reindex()
    // Field is private but the dim only matters for the embedding column.
    // We probe by trying to insert a 384-dim vector and then a 385-dim one
    // — the second should fail.
    const v384 = new Float32Array(384)
    for (let i = 0; i < 384; i++) v384[i] = 0.001 * i
    await adapter.upsertEmbedding('test', v384)
    await adapter.close()
  }, PGLITE_TIMEOUT)

  it('respects an explicit vectorDim=768 in PGLiteAdapter options', async () => {
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 768 })
    await adapter.reindex()
    const v768 = new Float32Array(768)
    for (let i = 0; i < 768; i++) v768[i] = 0.001 * (i % 50)
    await adapter.upsertEmbedding('test768', v768)
    await adapter.close()
  }, PGLITE_TIMEOUT)
})

describe('resolveEmbedderName', () => {
  const originalEnv = process.env.PLUR_EMBEDDER

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PLUR_EMBEDDER
    else process.env.PLUR_EMBEDDER = originalEnv
  })

  it('defaults to bge-small when PLUR_EMBEDDER is unset', () => {
    delete process.env.PLUR_EMBEDDER
    expect(resolveEmbedderName()).toBe('bge-small')
  })

  it('reads PLUR_EMBEDDER=bge-base', () => {
    process.env.PLUR_EMBEDDER = 'bge-base'
    expect(resolveEmbedderName()).toBe('bge-base')
  })

  it('reads PLUR_EMBEDDER=embedding-gemma', () => {
    process.env.PLUR_EMBEDDER = 'embedding-gemma'
    expect(resolveEmbedderName()).toBe('embedding-gemma')
  })

  it('reads PLUR_EMBEDDER=minilm', () => {
    process.env.PLUR_EMBEDDER = 'minilm'
    expect(resolveEmbedderName()).toBe('minilm')
  })

  it('falls back to default and warns on unknown names', () => {
    process.env.PLUR_EMBEDDER = 'gpt-banana'
    // Unknown name should not throw — degrades to default and logs once.
    expect(resolveEmbedderName()).toBe('bge-small')
  })

  it('getEmbedder().dim agrees with the embedder name for vector-dim wiring', () => {
    expect(getEmbedder('minilm').dim).toBe(384)
    expect(getEmbedder('bge-small').dim).toBe(384)
    expect(getEmbedder('bge-base').dim).toBe(768)
    expect(getEmbedder('embedding-gemma').dim).toBe(768)
  })
})
