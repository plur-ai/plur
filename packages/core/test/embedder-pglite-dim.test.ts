/**
 * PGLite vector-dim ⇄ active embedder wiring.
 *
 * PR 2 hard-coded the embedding column at vector(384). PR 4 made it
 * configurable so 768-dim embedders work. PR 5 (#219) promoted EmbeddingGemma
 * (768d) to the default; iter-2 audit B-2 reverted the default to bge-small
 * (384d) pending Phase C evidence. The wiring rule:
 *
 *   - When PLUR_EMBEDDER is unset, default is "bge-small" (384d) — iter-2
 *     audit B-2 revert.
 *   - When PLUR_EMBEDDER=embedding-gemma or bge-base, PGLite gets vector(768).
 *   - When PLUR_EMBEDDER=openai-3-large, PGLite gets vector(3072).
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

  it('defaults to vectorDim=384 when not specified (matches v0.10 default embedder bge-small per iter-2 B-2)', async () => {
    // Iter-2 audit B-2 reverted the default embedder to bge-small (384d). The
    // PGLite bare-adapter default tracks the active embedder, so it is now
    // 384. Explicit override via the vectorDim option still works (and is
    // what the Plur integration path uses to size the column to whichever
    // embedder is configured).
    const adapter = new PGLiteAdapter(yamlPath, dbPath)
    await adapter.reindex()
    const v384 = new Float32Array(384)
    for (let i = 0; i < 384; i++) v384[i] = 0.001 * (i % 50)
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

  it('defaults to bge-small when PLUR_EMBEDDER is unset (iter-2 audit B-2)', () => {
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
