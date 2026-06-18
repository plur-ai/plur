/**
 * Embeddings cache dim safety — Sprint 0 iter-2 audit B-1 / B-3.
 *
 * Issue: `.embeddings-cache.json` was keyed only by `engramId + statementHash`
 * with no embedder identity. Switching embedders (bge-small 384d <-> gemma
 * 768d) silently poisoned recall — query vector at new dim, cached engram
 * vector at old dim, cosineSimilarity loops over min(a,b) and returns
 * meaningless scores.
 *
 * Fix: stamp the cache JSON with `{ embedder_name, embedder_dim, version }`
 * in a meta header. On load, if the active embedder name or dim differs from
 * the cache header, invalidate the cache and rebuild. Backward-compatible:
 * the old flat-object format gets invalidated as if dim had mismatched (no
 * data loss risk — cache is rebuildable from YAML on demand).
 *
 * Closes RC-3 from iter-1 evaluators (Data F-DATA-003, Critic concern #2).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { embeddingSearch } from '../src/embeddings.js'
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
  } as any
}

// These exercise real `embeddingSearch`, which loads the BGE-small model.
// Gated behind PLUR_EMBEDDER_NETWORK_TESTS=1 (same convention as
// embedders.test.ts) so the suite stays offline-safe — without the model,
// embed() returns null and no cache is written. Run with the env var set on a
// machine with HuggingFace access to verify the cache dim-stamping for real.
const NETWORK = process.env.PLUR_EMBEDDER_NETWORK_TESTS === '1'

describe.skipIf(!NETWORK)('embeddings cache dim safety (iter-2 audit B-1/B-3)', () => {
  let dir: string
  let cachePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-embed-cache-'))
    cachePath = join(dir, '.embeddings-cache.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a versioned meta header with embedder_name and embedder_dim', async () => {
    const engrams = [makeEngram('ENG-2026-0530-001', 'cats are not dogs')]
    await embeddingSearch(engrams, 'cats', 5, dir)

    expect(existsSync(cachePath)).toBe(true)
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    // New format: { meta: { embedder_name, embedder_dim, version }, entries: {...} }
    expect(parsed).toHaveProperty('meta')
    expect(parsed.meta).toHaveProperty('embedder_name')
    expect(parsed.meta).toHaveProperty('embedder_dim')
    expect(parsed.meta).toHaveProperty('version')
    expect(typeof parsed.meta.embedder_dim).toBe('number')
    expect(parsed.meta.embedder_dim).toBeGreaterThan(0)
    expect(parsed).toHaveProperty('entries')
    expect(parsed.entries).toHaveProperty('ENG-2026-0530-001')
  })

  it('invalidates cache when embedder_dim mismatches (silently rebuilds)', async () => {
    // Seed a cache with a 999-dim "old" vector under the new format
    const oldCache = {
      meta: { embedder_name: 'fake-old', embedder_dim: 999, version: 1 },
      entries: {
        'ENG-2026-0530-001': {
          hash: 'wrong-hash',
          embedding: new Array(999).fill(0.001),
        },
      },
    }
    writeFileSync(cachePath, JSON.stringify(oldCache))

    const engrams = [makeEngram('ENG-2026-0530-001', 'cats are not dogs')]
    await embeddingSearch(engrams, 'cats', 5, dir)

    // After the call, the cache must have been rewritten with the current
    // embedder's metadata, NOT the fake-old 999d header.
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(parsed.meta.embedder_name).not.toBe('fake-old')
    expect(parsed.meta.embedder_dim).not.toBe(999)
    // The entry must have been replaced (not the original 999d vector).
    const entry = parsed.entries['ENG-2026-0530-001']
    expect(entry.embedding.length).not.toBe(999)
    expect(entry.embedding.length).toBe(parsed.meta.embedder_dim)
  })

  it('invalidates cache when embedder_name mismatches even at same dim', async () => {
    // Same dim, different name — should still invalidate. Catches the case
    // where two embedder families produce 384d vectors but the vector spaces
    // are not comparable (e.g. minilm vs bge-small).
    const oldCache = {
      meta: { embedder_name: 'fake-different-family', embedder_dim: 384, version: 1 },
      entries: {
        'ENG-2026-0530-001': {
          hash: 'wrong-hash',
          embedding: new Array(384).fill(0.001),
        },
      },
    }
    writeFileSync(cachePath, JSON.stringify(oldCache))

    const engrams = [makeEngram('ENG-2026-0530-001', 'cats are not dogs')]
    await embeddingSearch(engrams, 'cats', 5, dir)

    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(parsed.meta.embedder_name).not.toBe('fake-different-family')
  })

  it('reads the legacy flat-object format and invalidates it (no data loss)', async () => {
    // Pre-iter-2 cache format: { [engramId]: { hash, embedding } }. No meta.
    // On load, we treat the missing meta as a mismatch and rebuild.
    const legacyCache = {
      'ENG-2026-0530-001': {
        hash: 'legacy-hash',
        embedding: new Array(384).fill(0.5),
      },
    }
    writeFileSync(cachePath, JSON.stringify(legacyCache))

    const engrams = [makeEngram('ENG-2026-0530-001', 'cats are not dogs')]
    await embeddingSearch(engrams, 'cats', 5, dir)

    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(parsed).toHaveProperty('meta')
    expect(parsed.meta.embedder_name).toBeTruthy()
    expect(parsed).toHaveProperty('entries')
    // The legacy entry got dropped — it had a hash that doesn't match the
    // current statement, so even if we'd preserved it the engram would have
    // been re-embedded. The point of the test is: no crash, no garbage scores.
    expect(parsed.entries['ENG-2026-0530-001']).toBeDefined()
  })
})
