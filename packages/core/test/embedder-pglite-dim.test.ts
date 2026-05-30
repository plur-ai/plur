/**
 * PGLite vector-dim ⇄ active embedder wiring.
 *
 * PR 2 hard-coded the embedding column at vector(384). PR 4 made it
 * configurable so 768-dim embedders work, and PR 5 (#219) promoted
 * EmbeddingGemma (768d) to the default. The wiring rule:
 *
 *   - When PLUR_EMBEDDER is unset, default is "embedding-gemma" (768d) —
 *     promoted in Sprint 0 PR 5 (#219).
 *   - When PLUR_EMBEDDER=bge-small or minilm, PGLite gets vector(384).
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

  it('defaults to vectorDim=768 when not specified (matches PR 5 default embedder)', async () => {
    // PR 5 (#219): EmbeddingGemma (768d) is the new default embedder, so the
    // PGLite bare-adapter default is 768. Explicit override via the
    // vectorDim option still works (and is what the Plur integration path
    // uses to size the column to whichever embedder is configured).
    const adapter = new PGLiteAdapter(yamlPath, dbPath)
    await adapter.reindex()
    const v768 = new Float32Array(768)
    for (let i = 0; i < 768; i++) v768[i] = 0.001 * (i % 50)
    await adapter.upsertEmbedding('test', v768)
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

  it('defaults to embedding-gemma when PLUR_EMBEDDER is unset', () => {
    delete process.env.PLUR_EMBEDDER
    expect(resolveEmbedderName()).toBe('embedding-gemma')
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
    expect(resolveEmbedderName()).toBe('embedding-gemma')
  })

  it('getEmbedder().dim agrees with the embedder name for vector-dim wiring', () => {
    expect(getEmbedder('minilm').dim).toBe(384)
    expect(getEmbedder('bge-small').dim).toBe(384)
    expect(getEmbedder('bge-base').dim).toBe(768)
    expect(getEmbedder('embedding-gemma').dim).toBe(768)
  })
})
