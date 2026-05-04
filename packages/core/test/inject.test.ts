import { describe, it, expect } from 'vitest'
import { scoreEngram, selectAndSpread, estimateTokens, fillTokenBudget } from '../src/inject.js'
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

  it('selectAndSpread excludes expired engrams', () => {
    const expired = makeEngram({
      id: 'ENG-2026-0330-001',
      statement: 'Deploy to staging server first',
      temporal: { learned_at: '2026-01-01', valid_until: '2026-01-31' },
    })
    const valid = makeEngram({
      id: 'ENG-2026-0330-002',
      statement: 'Deploy using blue-green strategy',
    })
    const result = selectAndSpread(
      { prompt: 'deploy the app', maxTokens: 5000 },
      [expired, valid], []
    )
    const allIds = [
      ...result.directives.map(d => d.id),
      ...result.constraints.map(c => c.id),
      ...result.consider.map(c => c.id),
    ]
    expect(allIds).not.toContain('ENG-2026-0330-001')
  })

  it('emotional weight boosts scoring for high-weight engrams', () => {
    const neutral = makeEngram({
      id: 'ENG-2026-0330-001',
      statement: 'Always deploy using blue-green strategy',
    })
    const highEmotion = makeEngram({
      id: 'ENG-2026-0330-002',
      statement: 'Always deploy using blue-green strategy',
      episodic: { emotional_weight: 10, confidence: 5 },
    })
    const promptLower = 'deploy the app'
    const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 2))
    const scoreNeutral = scoreEngram(neutral, promptLower, promptWords, [], undefined, false)
    const scoreHigh = scoreEngram(highEmotion, promptLower, promptWords, [], undefined, false)
    expect(scoreHigh).toBeGreaterThan(scoreNeutral)
    expect(scoreHigh).toBeCloseTo(scoreNeutral * 1.2, 5)
  })

  it('low emotional weight reduces score', () => {
    const neutral = makeEngram({
      id: 'ENG-2026-0330-001',
      statement: 'Always deploy using blue-green strategy',
    })
    const lowEmotion = makeEngram({
      id: 'ENG-2026-0330-002',
      statement: 'Always deploy using blue-green strategy',
      episodic: { emotional_weight: 1, confidence: 5 },
    })
    const promptLower = 'deploy the app'
    const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 2))
    const scoreNeutral = scoreEngram(neutral, promptLower, promptWords, [], undefined, false)
    const scoreLow = scoreEngram(lowEmotion, promptLower, promptWords, [], undefined, false)
    expect(scoreLow).toBeLessThan(scoreNeutral)
    expect(scoreLow).toBeCloseTo(scoreNeutral * 0.84, 5)
  })

  // === Pinned engram tests ===

  it('pinned engram with zero keyword overlap still scores > 0', () => {
    const pinned = makeEngram({
      id: 'ENG-PIN-001',
      pinned: true,
      statement: 'For coding tasks, verify the artifact, not the narrative',
      tags: ['verification', 'artifact-first'],
    })
    const promptLower = 'help me write a poem about clouds'
    const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 2))
    const score = scoreEngram(pinned, promptLower, promptWords, [], undefined, false)
    expect(score).toBeGreaterThan(0)
  })

  it('non-pinned engram with zero keyword overlap returns 0', () => {
    const unpinned = makeEngram({
      id: 'ENG-NOPIN-001',
      statement: 'For coding tasks, verify the artifact, not the narrative',
      tags: ['verification', 'artifact-first'],
    })
    const promptLower = 'help me write a poem about clouds'
    const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 2))
    const score = scoreEngram(unpinned, promptLower, promptWords, [], undefined, false)
    expect(score).toBe(0)
  })

  it('pinned engram with keyword overlap is boosted over non-pinned', () => {
    const pinned = makeEngram({
      id: 'ENG-PIN-002',
      pinned: true,
      statement: 'Always deploy using blue-green strategy',
    })
    const unpinned = makeEngram({
      id: 'ENG-NOPIN-002',
      statement: 'Always deploy using blue-green strategy',
    })
    const promptLower = 'deploy the app'
    const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 2))
    const scorePinned = scoreEngram(pinned, promptLower, promptWords, [], undefined, false)
    const scoreUnpinned = scoreEngram(unpinned, promptLower, promptWords, [], undefined, false)
    expect(scorePinned).toBeCloseTo(scoreUnpinned * 2.0, 5)
  })

  // === Pinned engram budget cap (0.9.4) ===

  it('pinned engrams cannot consume more than 50% of the token budget', () => {
    // Carefully sized so that the OUTER maxTokens guard cannot be the binding
    // constraint — the pinned sub-cap (50% of maxTokens) must do the work.
    // Each engram is short (~50-token JSON serialization). With maxTokens=10000,
    // the outer guard would let all 30 pinned engrams through (30*50=1500 < 10000).
    // The pinnedBudget=5000 lets in ~100 engrams worth — but we have 30, so all 30
    // would fit IF the cap were broken. Instead, we expect the cap to bind under
    // a tighter budget. So: maxTokens=600 → pinnedBudget=300. 30 short engrams
    // with cost ~50 each → only 6 fit under the 300-token sub-cap, with the
    // outer maxTokens (600) leaving headroom that proves the sub-cap is binding.
    const shortStatement = 'X'.repeat(80)
    const pinned = Array.from({ length: 30 }, (_, i) => ({
      ...EngramSchema.parse({
        id: `ENG-PIN-${String(i).padStart(3, '0')}`,
        statement: shortStatement,
        type: 'behavioral',
        scope: 'global',
        status: 'active',
        pinned: true,
      }),
      pinned: true,
      score: 1.0,
    }))
    const maxTokens = 600
    const { selected, tokens_used } = fillTokenBudget(pinned, maxTokens)
    // Sub-cap binds: tokens_used must respect the 50%-of-budget sub-cap.
    expect(tokens_used).toBeLessThanOrEqual(maxTokens * 0.5)
    // And there must be headroom under maxTokens — i.e. the outer guard isn't
    // the reason we stopped. Without this we'd be testing the same thing twice.
    expect(tokens_used).toBeLessThan(maxTokens)
    // Some engrams must have been selected (proving the cap is "binding by
    // sub-budget", not "nothing fit at all").
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThan(30)
  })

  // === Pinned engram bypasses minRelevance (0.9.4) ===

  it('pinned engram with no keyword overlap survives the minRelevance filter', async () => {
    const { Plur } = await import('../src/index.js')
    const { mkdtempSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = mkdtempSync(join(tmpdir(), 'plur-pinned-relevance-'))
    try {
      const plur = new Plur({ path: dir })
      // High-relevance unpinned engrams to push the normalized score of the
      // pinned engram down toward zero — without the bypass at inject.ts:352,
      // its normalized score falls below DEFAULT_MIN_RELEVANCE (0.3) and the
      // pinned engram is silently dropped before fillTokenBudget sees it.
      for (let i = 0; i < 5; i++) {
        plur.learn(`The deployment script is at scripts/deploy-${i}.sh and runs deploy daily`, { type: 'procedural' })
      }
      const pinned = plur.learn('Never type a day-of-week from memory', {
        type: 'behavioral',
        pinned: true,
      })
      const result = plur.inject('deploy', { budget: 8000 })
      expect(result.injected_ids).toContain(pinned.id)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
