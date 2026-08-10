import { describe, it, expect, vi } from 'vitest'
import { learnAsync } from '../src/learn-async.js'
import { MemoryPrimaryStore } from '../src/store/memory-primary-store.js'
import type { LearnAsyncDeps } from '../src/learn-async.js'
import type { Engram } from '../src/schemas/engram.js'

/**
 * #854 — semantic dedup never ran.
 *
 * `learnAsync` fetched candidates, then discarded them unless an LLM was
 * configured: `decision` stayed 'ADD' unconditionally. `dedupConfig.threshold`
 * was destructured and never read, and `cosineSimilarity` was never called from
 * this path — so on any install without an LLM key every near-duplicate was
 * written. Measured consequence: 131 near-duplicate engrams across 63 clusters,
 * accumulating continuously since the feature shipped 2026-04-06.
 *
 * These pin the local, zero-API-cost path: similarity decides, and either way
 * the caller is told what was found.
 */

const candidate = {
  id: 'ENG-2026-08-10-019',
  statement: 'Time Machine does not exclude node_modules or other reinstallable build artifacts',
  type: 'procedural',
  scope: 'global',
  status: 'active',
  domain: 'infrastructure.backup',
  visibility: 'private',
  tags: [],
  activation: { retrieval_strength: 0.8, storage_strength: 1.0, frequency: 3, last_accessed: '2026-08-10' },
  associations: [],
  knowledge_anchors: [],
  feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  pack: null,
  abstract: null,
  derived_from: null,
  derivation_count: 1,
  reference_count: 1,
  recurrence_count: 0,
  sources: [],
  engram_version: 1,
  episode_ids: [],
  polarity: null,
} as unknown as Engram

function makeDeps(
  scores: Array<{ id: string; score: number }>,
  overrides: Partial<LearnAsyncDeps> = {},
): LearnAsyncDeps {
  return {
    hashDedup: async () => null,
    recallHybrid: async () => [candidate],
    recall: async () => [candidate],
    learn: async (statement: string, context?: any) =>
      ({ id: 'ENG-NEW-001', statement, scope: context?.scope ?? 'global' } as unknown as Engram),
    getById: async (id: string) => (id === candidate.id ? candidate : null),
    store: new MemoryPrimaryStore(),
    engramsPath: '/tmp/plur-dedup-cosine.yaml',
    rootPath: '/tmp/plur-dedup-cosine',
    dedupConfig: { enabled: true, mode: 'llm' },
    // No LLM configured — the degraded path this issue is about.
    isLlmAvailable: () => false,
    recordLlmSuccess: () => {},
    recordLlmFailure: () => {},
    syncIndex: async () => {},
    offendingHitsForScope: () => [],
    similarityScores: async () => scores,
    ...overrides,
  } as LearnAsyncDeps
}

describe('cosine dedup without an LLM (#854)', () => {
  const restatement =
    'Time Machine does not exclude node_modules or reinstallable build artifacts; clean them first'

  it('NOOPs a near-duplicate instead of adding a second copy', async () => {
    const deps = makeDeps([{ id: candidate.id, score: 0.96 }])

    const result = await learnAsync(deps, restatement)

    expect(result.decision).toBe('NOOP')
    expect(result.existing_id).toBe(candidate.id)
  })

  it('still ADDs when nothing is close enough', async () => {
    const deps = makeDeps([{ id: candidate.id, score: 0.41 }])

    const result = await learnAsync(deps, 'systemd services have no $HOME by default')

    expect(result.decision).toBe('ADD')
  })

  it('reports what it found so an ADD is never silently un-deduped', async () => {
    const deps = makeDeps([{ id: candidate.id, score: 0.41 }])

    const result = await learnAsync(deps, 'systemd services have no $HOME by default')

    expect(result.dedup?.mode).toBe('cosine')
    expect(result.dedup?.near_duplicates?.[0]).toMatchObject({ id: candidate.id, score: 0.41 })
  })

  it('honours the configured threshold rather than a hardcoded one', async () => {
    // 0.90 would NOOP under the default bar; an explicit higher bar must not.
    const deps = makeDeps([{ id: candidate.id, score: 0.9 }], {
      dedupConfig: { enabled: true, mode: 'llm', threshold: 0.99 },
    })

    const result = await learnAsync(deps, restatement)

    expect(result.decision).toBe('ADD')
  })

  it('falls back to ADD and says so when similarity is unavailable', async () => {
    // No similarityScores dep at all — e.g. embedder disabled. Must behave as
    // before (ADD) and must not claim a cosine decision it did not make.
    const deps = makeDeps([], { similarityScores: undefined })

    const result = await learnAsync(deps, restatement)

    expect(result.decision).toBe('ADD')
    expect(result.dedup?.mode).toBe('hash-only')
  })

  // The comparison must be like-for-like. Stored engrams are embedded as
  // `engramSearchText` output — statement PLUS domain, tags, rationale and the
  // rest — so embedding a bare statement on the incoming side compares a
  // fragment against fully-contexted engrams. Measured, that is not a small
  // effect: a distinct pair (staging port 8080 vs 8081) scores 0.9749 bare and
  // 0.8512 enriched, while a real duplicate goes 0.9689 -> 0.9878. Context
  // separates the classes; dropping it from one side collapses them.
  it('compares enriched text, not the bare statement', async () => {
    let seen = ''
    const deps = makeDeps([{ id: candidate.id, score: 0.1 }], {
      similarityScores: async (text: string) => { seen = text; return [] },
    })

    await learnAsync(deps, 'Use port 8081 for staging', {
      domain: 'infrastructure.deploy',
      tags: ['staging', 'ports'],
      rationale: 'Moved off 8080 after the metrics sidecar claimed it',
    })

    expect(seen).toContain('Use port 8081 for staging')
    expect(seen).toContain('infrastructure deploy')
    expect(seen).toContain('staging ports')
    expect(seen).toContain('metrics sidecar')
  })

  it('an available LLM still decides — cosine does not pre-empt it', async () => {
    const llm = vi.fn().mockResolvedValue('ADD')
    const deps = makeDeps([{ id: candidate.id, score: 0.99 }], { isLlmAvailable: () => true })

    const result = await learnAsync(deps, restatement, { llm })

    expect(llm).toHaveBeenCalled()
    expect(result.decision).toBe('ADD')
  })
})
