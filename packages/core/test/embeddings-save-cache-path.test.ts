/**
 * Regression test for #641: saveCache used `cachePath.substring(0, cachePath.lastIndexOf('/'))`
 * to extract the directory. On Windows, paths use backslashes so lastIndexOf('/') returns -1,
 * and substring(0, -1) returns '' — causing mkdirSync('') to throw ENOENT even when storagePath
 * is a fully-valid directory. Fix: use path.dirname() instead of the manual slash scan.
 *
 * This test uses _setCachedEmbedder to inject a mock embedder so it runs offline, no model download.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { embeddingSearch, embeddingSearchWithScores, _setCachedEmbedder, resetEmbedder } from '../src/embeddings.js'
import type { Engram } from '../src/schemas/engram.js'

function makeEngram(id: string, statement: string): Engram {
  return {
    id,
    version: 2,
    status: 'active',
    consolidated: false,
    type: 'behavioral',
    scope: 'global',
    visibility: 'private',
    statement,
    activation: {
      retrieval_strength: 0.7,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2026-07-21',
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
  } as any
}

function makeUnitVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed + i) * 0.1
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map(x => x / norm)
}

describe('saveCache cross-platform path regression (#641)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-save-cache-'))
    _setCachedEmbedder({
      name: 'mock-bge',
      dim: 4,
      modelId: 'mock-bge-small',
      embed: async (text: string) => makeUnitVector(4, text.length),
      embedBatch: async (texts: string[]) => texts.map((t, i) => makeUnitVector(4, t.length + i)),
    })
  })

  afterEach(() => {
    resetEmbedder()
    rmSync(dir, { recursive: true, force: true })
  })

  it('embeddingSearch writes cache without ENOENT when storagePath is a temp dir', async () => {
    const engrams = [
      makeEngram('ENG-2026-0721-001', 'deploy script lives at scripts/deploy.sh'),
      makeEngram('ENG-2026-0721-002', 'production runs on Fly.io'),
    ]
    await expect(embeddingSearch(engrams, 'deploy', 5, dir)).resolves.not.toThrow()
    expect(existsSync(join(dir, '.embeddings-cache.json'))).toBe(true)
  })

  it('embeddingSearchWithScores writes cache without ENOENT when storagePath is a temp dir', async () => {
    const engrams = [
      makeEngram('ENG-2026-0721-003', 'headless CI run uses scheduled task'),
    ]
    await expect(embeddingSearchWithScores(engrams, 'headless', 5, dir)).resolves.not.toThrow()
    expect(existsSync(join(dir, '.embeddings-cache.json'))).toBe(true)
  })

  it('cache file is valid JSON with meta header after first write', async () => {
    const engrams = [makeEngram('ENG-2026-0721-004', 'test cache header')]
    await embeddingSearch(engrams, 'cache', 5, dir)
    const raw = readFileSync(join(dir, '.embeddings-cache.json'), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed).toHaveProperty('meta')
    expect(parsed.meta.embedder_name).toBe('mock-bge')
    expect(parsed.meta.embedder_dim).toBe(4)
    expect(parsed).toHaveProperty('entries')
    expect(parsed.entries['ENG-2026-0721-004']).toBeDefined()
  })

  it('second call hits cache and still writes without error', async () => {
    const engrams = [makeEngram('ENG-2026-0721-005', 'cache hit on second call')]
    await embeddingSearch(engrams, 'cache', 5, dir)
    await expect(embeddingSearch(engrams, 'cache', 5, dir)).resolves.not.toThrow()
  })
})
