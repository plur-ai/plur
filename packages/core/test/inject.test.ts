import { describe, it, expect } from 'vitest'
import { scoreEngram, selectAndSpread, estimateTokens } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'
import { daysSince } from '../src/decay.js'

describe('injection engine', () => {
  const makeEngram = (overrides: Partial<any> = {}) => EngramSchema.parse({
    id: 'ENG-2026-0319-001',
    statement: 'API uses snake_case',
    type: 'behavioral',
    scope: 'global',
    status: 'active',
    ...overrides,
  })

  it('scores engrams by keyword relevance', () => {
    const engram = makeEngram({ statement: 'Always deploy using blue-green strategy' })
    const promptLower = 'deploy the app'
    const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 2))
    const score = scoreEngram(engram, promptLower, promptWords, [], undefined, false)
    expect(score).toBeGreaterThan(0)
  })

  it('filters by scope', () => {
    const engram = makeEngram({ scope: 'project:other' })
    const promptLower = 'fix myapp'
    const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 2))
    const score = scoreEngram(engram, promptLower, promptWords, [], 'project:myapp', false)
    expect(score).toBe(0)
  })

  it('global engrams pass any scope filter', () => {
    const engram = makeEngram({ scope: 'global', statement: 'always test before deploy' })
    const promptLower = 'deploy test'
    const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 2))
    const score = scoreEngram(engram, promptLower, promptWords, [], 'project:myapp', false)
    expect(score).toBeGreaterThan(0)
  })

  it('selectAndSpread produces directives within budget', () => {
    const engrams = Array.from({ length: 20 }, (_, i) => makeEngram({
      id: `ENG-2026-0319-${String(i + 1).padStart(3, '0')}`,
      statement: `Rule ${i}: always deploy carefully`,
    }))
    const result = selectAndSpread(
      { prompt: 'deploy the app', maxTokens: 500 },
      engrams, []
    )
    expect(result.tokens_used.directives).toBeLessThanOrEqual(500)
    expect(result.directives.length).toBeGreaterThan(0)
    expect(result.constraints).toBeDefined()
  })

  it('splits dont-pattern engrams into constraints', () => {
    const engrams = [
      makeEngram({ id: 'ENG-2026-0319-001', statement: 'Always deploy using blue-green strategy' }),
      makeEngram({ id: 'ENG-2026-0319-002', statement: 'Never deploy directly to production' }),
      makeEngram({ id: 'ENG-2026-0319-003', statement: 'Avoid deploy on Fridays at all costs' }),
    ]
    const result = selectAndSpread(
      { prompt: 'deploy the app', maxTokens: 5000 },
      engrams, []
    )
    // dont-patterns go to constraints, rest to directives
    expect(result.constraints.length).toBe(2)
    expect(result.directives.length).toBe(1)
    expect(result.constraints.every(c => c.confidence_score >= 0)).toBe(true)
    expect(result.directives.every(d => d.confidence_score >= 0)).toBe(true)
  })

  it('adds confidence_score to all wire engrams', () => {
    const engrams = [
      makeEngram({
        id: 'ENG-2026-0319-001',
        statement: 'Always deploy using blue-green strategy',
        feedback_signals: { positive: 5, negative: 0, neutral: 1 },
      }),
    ]
    const result = selectAndSpread(
      { prompt: 'deploy the app', maxTokens: 5000 },
      engrams, []
    )
    const all = [...result.directives, ...result.constraints, ...result.consider]
    expect(all.length).toBeGreaterThan(0)
    for (const wire of all) {
      expect(typeof wire.confidence_score).toBe('number')
      expect(wire.confidence_score).toBeGreaterThanOrEqual(0)
      expect(wire.confidence_score).toBeLessThanOrEqual(1)
    }
    // Engram with positive feedback should have confidence > 0.5
    expect(result.directives[0].confidence_score).toBeGreaterThan(0.5)
  })
})
