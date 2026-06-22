import { describe, it, expect, vi } from 'vitest'
import { learnAsync } from '../src/learn-async.js'
import type { LearnAsyncDeps } from '../src/learn-async.js'
import type { Engram } from '../src/schemas/engram.js'

/**
 * Issue #359: LLM-dedup candidates were not scope-filtered, so a global engram
 * could absorb an explicitly-scoped write via NOOP/UPDATE/MERGE, silently dropping
 * the requested scope and leaving the team store empty.
 *
 * Fix: filter LLM-dedup candidates to context.scope before the LLM sees them,
 * mirroring the scope-awareness already present in hashDedup.
 */

const globalCandidate: Engram = {
  id: 'ENG-2026-0101-001',
  statement: 'PLUR positions Datafund as the data economy infrastructure layer',
  type: 'behavioral',
  domain: 'test',
  status: 'active',
  scope: 'global',
  version: 2,
  consolidated: false,
  visibility: 'private',
  tags: [],
  activation: { retrieval_strength: 0.8, storage_strength: 1.0, frequency: 3, last_accessed: '2026-06-01' },
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

function makeDeps(candidates: Engram[]): LearnAsyncDeps {
  return {
    hashDedup: () => null,
    recallHybrid: async () => candidates,
    recall: () => candidates,
    learn: (statement: string, context?: any) =>
      ({ id: 'ENG-2026-0619-001', statement, scope: context?.scope ?? 'global' } as unknown as Engram),
    getById: (id: string) => candidates.find(c => c.id === id) ?? null,
    engramsPath: '/tmp/plur-test-engrams.yaml',
    rootPath: '/tmp/plur-test',
    dedupConfig: { enabled: true, mode: 'llm' },
    isLlmAvailable: () => true,
    recordLlmSuccess: () => {},
    recordLlmFailure: () => {},
    syncIndex: () => {},
    offendingHitsForScope: () => [],
  }
}

describe('learnAsync scope-aware LLM dedup (issue #359)', () => {
  it('does not dedup an explicitly-scoped write against a global engram', async () => {
    const llm = vi.fn().mockResolvedValue('NOOP')
    const deps = makeDeps([globalCandidate])

    const result = await learnAsync(
      deps,
      'PLUR positions Datafund as the data economy backbone',
      { scope: 'group:datafund/datafund', llm },
    )

    // The global candidate must be filtered out before the LLM is called.
    expect(llm).not.toHaveBeenCalled()
    // With no candidates, learnAsync falls through to ADD at the requested scope.
    expect(result.decision).toBe('ADD')
    expect(result.engram.scope).toBe('group:datafund/datafund')
  })

  it('still deduplicates same-scope candidates', async () => {
    const sameScope = { ...globalCandidate, id: 'ENG-2026-0101-002', scope: 'group:datafund/datafund' }
    const llm = vi.fn().mockResolvedValue('DECISION: NOOP\nTARGET: ENG-2026-0101-002\nREASON: identical content')
    const deps = makeDeps([sameScope as unknown as Engram])

    const result = await learnAsync(
      deps,
      'PLUR positions Datafund as the data economy backbone',
      { scope: 'group:datafund/datafund', llm },
    )

    // Same-scope candidate passes the filter; LLM is consulted.
    expect(llm).toHaveBeenCalled()
    expect(result.decision).toBe('NOOP')
    expect(result.existing_id).toBe('ENG-2026-0101-002')
  })

  it('does not filter candidates when no scope is requested', async () => {
    const llm = vi.fn().mockResolvedValue('DECISION: NOOP\nTARGET: ENG-2026-0101-001\nREASON: identical content')
    const deps = makeDeps([globalCandidate])

    const result = await learnAsync(
      deps,
      'PLUR positions Datafund as the data economy backbone',
      { llm },
    )

    // Without a requested scope the filter is skipped; global candidate is a valid target.
    expect(llm).toHaveBeenCalled()
    expect(result.decision).toBe('NOOP')
  })
})
