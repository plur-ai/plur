/**
 * Atomic reembedAll({ full: true }) — Sprint 0 iter-2 audit M-6
 * (CTO F-CTO-007, Data F-DATA-001).
 *
 * Before this fix: reembedAll dropped the embedding column FIRST then
 * iterated embedding-and-upsert. If the embedder threw mid-loop (network
 * blip on openai-3-large, ONNX runtime crash, process kill), the user was
 * left with: column at the new dim, partial vectors, no marker — and no
 * indication that the index was half-built.
 *
 * After this fix: a scratch table `engram_embeddings_new` is built and
 * populated first; the live `engram_embeddings` is swapped via DROP + RENAME
 * inside a transaction. Embedder failure during populate leaves the live
 * table untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { PGLiteAdapter, _setEmbedderForTests } from '../src/storage-pglite.js'
import type { EmbedderAdapter } from '../src/embedders/types.js'

const PGLITE_TIMEOUT = 30_000

function makeEngramYaml(statements: string[]): string {
  const engrams = statements.map((s, i) => ({
    id: `ENG-2026-0530-${String(i + 1).padStart(3, '0')}`,
    version: 2,
    status: 'active',
    consolidated: false,
    type: 'behavioral',
    scope: 'global',
    visibility: 'private',
    statement: s,
    activation: {
      retrieval_strength: 0.7,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2026-05-30',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    knowledge_anchors: [],
    associations: [],
    derivation_count: 1,
    tags: [],
    pack: null,
    abstract: null,
    derived_from: null,
    polarity: null,
    content_hash: 'h',
    commitment: 'leaning',
    reference_count: 1,
    sources: [],
    recurrence_count: 0,
    summary: '',
    engram_version: 1,
    episode_ids: [],
  }))
  return yaml.dump({ engrams })
}

function fakeEmbedder(dim: number, fillFn = (i: number, txt: string) => 0.001 * (i + txt.length)): EmbedderAdapter {
  return {
    name: 'fake-fixed',
    modelId: 'fake-fixed',
    dim,
    async embed(text: string) {
      const v = new Float32Array(dim)
      for (let i = 0; i < dim; i++) v[i] = fillFn(i, text)
      return v
    },
    async embedBatch(texts: string[]) {
      return Promise.all(texts.map(t => this.embed(t)))
    },
  }
}

function failingEmbedder(dim: number, failOnIndex: number): EmbedderAdapter {
  let calls = 0
  return {
    name: 'fake-failing',
    modelId: 'fake-failing',
    dim,
    async embed(text: string) {
      if (calls === failOnIndex) {
        calls++
        throw new Error('simulated embedder failure')
      }
      calls++
      const v = new Float32Array(dim)
      for (let i = 0; i < dim; i++) v[i] = 0.001 * (i + text.length)
      return v
    },
    async embedBatch(texts: string[]) {
      return Promise.all(texts.map(t => this.embed(t)))
    },
  }
}

describe('reembedAll atomic swap (iter-2 audit M-6)', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-reembed-atomic-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'store.pglite')
    writeFileSync(yamlPath, makeEngramYaml(['cats', 'dogs', 'fish', 'rabbits', 'horses']))
  })

  afterEach(() => {
    _setEmbedderForTests(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('successful full reembed swaps the table and returns the count', async () => {
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 384 })
    await adapter.reindex()
    const embedder = fakeEmbedder(384)

    const result = await adapter.reembedAll({ full: true, embedder })
    expect(result.skipped).toBe(false)
    expect(result.reembedded).toBe(5)
    expect(await adapter.countEmbeddings()).toBe(5)
    await adapter.close()
  }, PGLITE_TIMEOUT)

  it('embedder failure mid-loop leaves the live table untouched (atomicity)', async () => {
    // Seed the live table with a pre-existing row at the old dim.
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 384 })
    await adapter.reindex()
    const seed = fakeEmbedder(384)
    await adapter.upsertEmbedding('SEED-EXISTING', await seed.embed('seed-row'))
    expect(await adapter.countEmbeddings()).toBe(1)

    // Now run a full reembed that fails on the 3rd engram (index 2).
    const failing = failingEmbedder(768, 2)
    await expect(adapter.reembedAll({ full: true, embedder: failing }))
      .rejects.toThrow(/simulated embedder failure/)

    // Live table must still contain the seed row, and the dim must NOT have
    // changed to 768. The atomic-swap pattern guarantees no partial rebuild.
    const liveCount = await adapter.countEmbeddings()
    expect(liveCount).toBe(1)
    const dim = await adapter.getVectorColumnDim()
    expect(dim).toBe(384)
    await adapter.close()
  }, PGLITE_TIMEOUT)

  it('changes column dim atomically when reembed succeeds', async () => {
    const adapter = new PGLiteAdapter(yamlPath, dbPath, { vectorDim: 384 })
    await adapter.reindex()
    await adapter.upsertEmbedding('OLD-1', new Float32Array(384).fill(0.1))
    expect(await adapter.getVectorColumnDim()).toBe(384)

    const embedder = fakeEmbedder(768)
    const result = await adapter.reembedAll({ full: true, embedder })
    expect(result.skipped).toBe(false)
    // Old row is gone (full=true rebuilds from YAML), new dim is 768.
    expect(await adapter.getVectorColumnDim()).toBe(768)
    // 5 engrams in YAML, 5 new embeddings — OLD-1 is not in YAML.
    expect(await adapter.countEmbeddings()).toBe(5)
    await adapter.close()
  }, PGLITE_TIMEOUT)
})
