import { describe, it, expect } from 'vitest'
import { learnBatch } from '../src/learn-async.js'
import type { LearnAsyncDeps } from '../src/learn-async.js'
import type { Engram } from '../src/schemas/engram.js'

/**
 * Finding #4 (security audit 2026-06-10): learnBatch issued one unbounded
 * LLM dedup call per statement. These tests pin the maxLlmCalls budget:
 * once the cap is reached, remaining statements fall back to the cheap
 * (cosine/ADD) path and make no further LLM calls.
 */

// A candidate so learnAsync reaches Step 4 (the LLM-decision branch) for
// every statement — otherwise empty recall short-circuits to ADD with no
// LLM call and the cap would never bite.
const candidate = {
  id: 'ENG-2026-0101-001',
  statement: 'pre-existing similar knowledge',
  type: 'behavioral',
  domain: 'test',
  status: 'active',
  scope: 'global',
} as unknown as Engram

function makeDeps(llmCalls: { n: number }): { deps: LearnAsyncDeps; llm: (p: string) => Promise<string> } {
  const deps: LearnAsyncDeps = {
    hashDedup: () => null,
    recallHybrid: async () => [candidate],
    recall: () => [candidate],
    learn: (statement: string) => ({ id: 'ENG-2026-0101-999', statement } as unknown as Engram),
    getById: () => null,
    engramsPath: '/tmp/plur-test-engrams.yaml',
    rootPath: '/tmp/plur-test',
    dedupConfig: { enabled: true, mode: 'llm' },
    isLlmAvailable: () => true,
    recordLlmSuccess: () => {},
    recordLlmFailure: () => {},
    syncIndex: () => {},
  }
  const llm = async (_prompt: string): Promise<string> => {
    llmCalls.n++
    return 'ADD'
  }
  return { deps, llm }
}

describe('learnBatch maxLlmCalls cap (finding #4)', () => {
  it('caps LLM dedup calls at maxLlmCalls and still processes every statement', async () => {
    const llmCalls = { n: 0 }
    const { deps, llm } = makeDeps(llmCalls)
    const statements = Array.from({ length: 5 }, (_, i) => ({ statement: `novel statement ${i}` }))

    const result = await learnBatch(deps, statements, llm, { maxLlmCalls: 2 })

    expect(llmCalls.n).toBe(2)            // budget enforced
    expect(result.results).toHaveLength(5) // every statement still handled
  })

  it('defaults to a finite cap (50) when none is supplied', async () => {
    const llmCalls = { n: 0 }
    const { deps, llm } = makeDeps(llmCalls)
    const statements = Array.from({ length: 60 }, (_, i) => ({ statement: `novel statement ${i}` }))

    const result = await learnBatch(deps, statements, llm)

    expect(llmCalls.n).toBe(50)
    expect(result.results).toHaveLength(60)
  })

  it('maxLlmCalls: 0 disables LLM dedup entirely', async () => {
    const llmCalls = { n: 0 }
    const { deps, llm } = makeDeps(llmCalls)
    const statements = Array.from({ length: 3 }, (_, i) => ({ statement: `novel statement ${i}` }))

    await learnBatch(deps, statements, llm, { maxLlmCalls: 0 })

    expect(llmCalls.n).toBe(0)
  })
})
