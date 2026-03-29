// packages/core/test/meta/structural-analysis.test.ts
import { describe, it, expect } from 'vitest'
import { analyzeStructure, type RelationalAnalysis } from '../../src/meta/structural-analysis.js'
import type { Engram } from '../../src/schemas/engram.js'
import type { LlmFunction } from '../../src/types.js'

function makeEngram(overrides: Partial<Engram>): Engram {
  return {
    id: 'ENG-TEST-001', version: 2, status: 'active', consolidated: false,
    type: 'behavioral', scope: 'global', statement: 'Test', tags: [],
    activation: { retrieval_strength: 0.7, storage_strength: 0.5, frequency: 1, last_accessed: '2026-03-29' },
    pack: null, abstract: null, derived_from: null, polarity: null,
    knowledge_anchors: [], associations: [],
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    derivation_count: 1,
    visibility: 'private',
    ...overrides,
  } as Engram
}

// Mock LLM that returns structured JSON
const mockLlm: LlmFunction = async (prompt: string) => {
  if (prompt.includes('liquidation prices assume collateral stays constant')) {
    return JSON.stringify([{
      engram_id: 'ENG-TRADE-001',
      goal_context: 'assess trading risk accurately',
      triples: [{
        subject: { role: 'safety-metric', domain_instance: 'liquidation-price' },
        predicate: 'assumes-independence-of',
        object: { role: 'correlated-variables', domain_instance: 'collateral-and-market' },
        outcome: 'underestimated-risk',
      }],
    }])
  }
  if (prompt.includes('Engrams have four type values')) {
    return JSON.stringify([{
      engram_id: 'ENG-TEST-001',
      goal_context: '',
      triples: [],
    }])
  }
  return '[]'
}

describe('analyzeStructure', () => {
  it('extracts relational triples from a transferable engram', async () => {
    const engram = makeEngram({
      id: 'ENG-TRADE-001',
      statement: 'Exchange-quoted liquidation prices assume collateral stays constant — when correlated, real liquidation is 2-3x higher',
      domain: 'trading.liquidation',
    })
    const results = await analyzeStructure([engram], mockLlm)
    expect(results).toHaveLength(1)
    expect(results[0].triples).toHaveLength(1)
    expect(results[0].triples[0].predicate).toBe('assumes-independence-of')
    expect(results[0].goal_context).toBeDefined()
  })

  it('returns empty for engrams with no transferable structure', async () => {
    const engram = makeEngram({
      statement: 'Engrams have four type values',
      domain: 'datacore',
    })
    const results = await analyzeStructure([engram], mockLlm)
    expect(results).toHaveLength(0)
  })

  it('prioritizes correction-tagged engrams', async () => {
    const normal = makeEngram({ id: 'ENG-1', statement: 'Test', tags: ['test'] })
    const correction = makeEngram({
      id: 'ENG-2',
      statement: 'Exchange-quoted liquidation prices assume collateral stays constant — when correlated, real liquidation is 2-3x higher',
      tags: ['correction'],
      feedback_signals: { positive: 0, negative: 2, neutral: 0 },
    })
    const results = await analyzeStructure([normal, correction], mockLlm)
    // Correction should be processed (has transferable structure)
    expect(results.some(r => r.engram_id === 'ENG-2')).toBe(true)
  })
})
