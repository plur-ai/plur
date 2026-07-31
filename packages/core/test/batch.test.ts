import { describe, it, expect } from 'vitest'
import { learnBatch } from '../src/learn-async.js'
import type { LearnAsyncDeps } from '../src/learn-async.js'
import type { Engram } from '../src/schemas/engram.js'
import type { LearnContext } from '../src/types.js'

/**
 * plur_learn_batch (plur-ai/plur#281): persist many engrams in one call.
 *
 * The MCP tool is a thin wrapper over core `learnBatch`, so these tests pin the
 * batch semantics the tool depends on:
 *   - batch write  — every statement is processed, one result per success
 *   - dedup ACROSS the batch — a statement written earlier in the SAME call is
 *     visible to a later identical statement (NOOP, not a second ADD)
 *   - partial-failure tolerance — one bad statement is recorded, not fatal; the
 *     rest of the batch still writes
 *
 * A stateful in-memory `deps` fake stands in for the real store so the tests are
 * deterministic and need no ONNX embeddings. `hashDedup` reads the same `store`
 * that `learn` writes — exactly how the real content-hash fast-path sees engrams
 * persisted earlier in the same batch.
 */
function makeStatefulDeps(): { deps: LearnAsyncDeps; store: Engram[] } {
  const store: Engram[] = []

  const learn = (statement: string, context?: LearnContext): Engram => {
    // Mirror the real learn() guard so an empty statement throws (see index.ts).
    if (typeof statement !== 'string' || statement.length === 0) {
      throw new TypeError('plur.learn: statement must be a non-empty string')
    }
    const engram = {
      id: `ENG-TEST-${store.length + 1}`,
      statement,
      scope: context?.scope ?? 'global',
      type: context?.type ?? 'behavioral',
      status: 'active',
      tags: context?.tags ?? [],
      activation: { retrieval_strength: 0.5, last_accessed: '2026-07-04' },
    } as unknown as Engram
    store.push(engram)
    return engram
  }

  const hashDedup = (statement: string, scope?: string): Engram | null =>
    store.find(e => e.statement === statement && (scope === undefined || e.scope === scope)) ?? null

  const deps: LearnAsyncDeps = {
    hashDedup,
    // Empty semantic recall → learnAsync short-circuits to ADD before any LLM.
    recallHybrid: async () => [],
    recall: () => [],
    learn,
    getById: (id: string) => store.find(e => e.id === id) ?? null,
    engramsPath: '/tmp/plur-batch-test-engrams.yaml',
    rootPath: '/tmp/plur-batch-test',
    dedupConfig: { enabled: true, mode: 'llm' },
    isLlmAvailable: () => false,
    recordLlmSuccess: () => {},
    recordLlmFailure: () => {},
    syncIndex: () => {},
    offendingHitsForScope: () => [],
  }
  return { deps, store }
}

describe('learnBatch — batch write', () => {
  it('writes every distinct statement and returns one result per success', async () => {
    const { deps, store } = makeStatefulDeps()
    const result = await learnBatch(deps, [
      { statement: 'alpha knowledge' },
      { statement: 'beta knowledge' },
      { statement: 'gamma knowledge' },
    ])

    expect(result.results).toHaveLength(3)
    expect(result.stats.added).toBe(3)
    expect(result.stats.failed).toBe(0)
    expect(result.failures).toEqual([])
    expect(store).toHaveLength(3)
    // Every success carries a persisted id — the tool surfaces these as ids[].
    expect(result.results.map(r => r.engram.id)).toEqual([
      'ENG-TEST-1',
      'ENG-TEST-2',
      'ENG-TEST-3',
    ])
  })
})

describe('learnBatch — dedup across the batch', () => {
  it('deduplicates a statement against an identical one written earlier in the SAME call', async () => {
    const { deps, store } = makeStatefulDeps()
    const result = await learnBatch(deps, [
      { statement: 'shared finding' },
      { statement: 'unique finding' },
      { statement: 'shared finding' }, // identical to item 0, written moments earlier
    ])

    expect(result.results).toHaveLength(3)
    expect(result.stats.added).toBe(2)
    expect(result.stats.noops).toBe(1)
    // Only two engrams actually landed in the store — the third deduped.
    expect(store).toHaveLength(2)
    // The NOOP points back at the engram added in item 0.
    const noop = result.results[2]
    expect(noop.decision).toBe('NOOP')
    expect(noop.existing_id).toBe('ENG-TEST-1')
  })

  it('respects scope when deduping across the batch (same text, different scope → two ADDs)', async () => {
    const { deps } = makeStatefulDeps()
    const result = await learnBatch(deps, [
      { statement: 'scoped finding', context: { scope: 'project:a' } },
      { statement: 'scoped finding', context: { scope: 'project:b' } },
    ])

    expect(result.stats.added).toBe(2)
    expect(result.stats.noops).toBe(0)
  })
})

describe('learnBatch — partial failure handling', () => {
  it('records a failed statement and still processes the rest of the batch', async () => {
    const { deps, store } = makeStatefulDeps()
    const result = await learnBatch(deps, [
      { statement: 'good one' },
      { statement: '' }, // empty → learn() throws
      { statement: 'good two' }, // must still be written despite the failure above
    ])

    // Two successes, one failure — the bad item did NOT abort the batch.
    expect(result.results).toHaveLength(2)
    expect(result.stats.added).toBe(2)
    expect(result.stats.failed).toBe(1)
    expect(store.map(e => e.statement)).toEqual(['good one', 'good two'])

    // The failure is reported with its original index and the error message.
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].index).toBe(1)
    expect(result.failures[0].statement).toBe('')
    expect(result.failures[0].error).toMatch(/non-empty string/)
  })

  it('surfaces multiple failures, each with its own index', async () => {
    const { deps } = makeStatefulDeps()
    const result = await learnBatch(deps, [
      { statement: '' },
      { statement: 'ok' },
      { statement: '' },
    ])

    expect(result.stats.added).toBe(1)
    expect(result.stats.failed).toBe(2)
    expect(result.failures.map(f => f.index)).toEqual([0, 2])
  })
})
