import { describe, it, expect } from 'vitest'
import { scoreEngram, selectAndSpread, estimateTokens, estimateEngramTokens, fillTokenBudget, formatWithLayer, PINNED_HARD_TOKEN_CAP } from '../src/inject.js'
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

  // #347 — soft-expiry mode: recently-expired engrams inject with a loud
  // marker for a grace window instead of being hard-skipped. Hard remains
  // the default.
  describe('soft-expiry mode (#347)', () => {
    const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)

    const recentlyExpired = () => makeEngram({
      id: 'ENG-2026-0347-001',
      statement: 'Deploy to staging server first',
      temporal: { learned_at: '2026-01-01', valid_until: isoDaysAgo(5) },
    })

    it('hard mode (default) skips recently-expired engrams', () => {
      const result = selectAndSpread(
        { prompt: 'deploy the app', maxTokens: 5000 },
        [recentlyExpired()], [],
      )
      const allIds = [...result.directives, ...result.constraints, ...result.consider].map(e => e.id)
      expect(allIds).not.toContain('ENG-2026-0347-001')
    })

    it('soft mode injects a recently-expired engram (within grace window)', () => {
      const result = selectAndSpread(
        { prompt: 'deploy the app', maxTokens: 5000 },
        [recentlyExpired()], [],
        { expiry: { mode: 'soft', grace_days: 30 } },
      )
      const allIds = [...result.directives, ...result.constraints, ...result.consider].map(e => e.id)
      expect(allIds).toContain('ENG-2026-0347-001')
    })

    it('soft mode still skips engrams expired beyond the grace window', () => {
      const longExpired = makeEngram({
        id: 'ENG-2026-0347-002',
        statement: 'Deploy to staging server first',
        temporal: { learned_at: '2026-01-01', valid_until: isoDaysAgo(60) },
      })
      const result = selectAndSpread(
        { prompt: 'deploy the app', maxTokens: 5000 },
        [longExpired], [],
        { expiry: { mode: 'soft', grace_days: 30 } },
      )
      const allIds = [...result.directives, ...result.constraints, ...result.consider].map(e => e.id)
      expect(allIds).not.toContain('ENG-2026-0347-002')
    })

    it('soft mode still skips not-yet-valid engrams (valid_from in the future)', () => {
      const notYet = makeEngram({
        id: 'ENG-2026-0347-003',
        statement: 'Deploy to staging server first',
        temporal: { learned_at: '2026-01-01', valid_from: '2099-01-01' },
      })
      const result = selectAndSpread(
        { prompt: 'deploy the app', maxTokens: 5000 },
        [notYet], [],
        { expiry: { mode: 'soft', grace_days: 30 } },
      )
      const allIds = [...result.directives, ...result.constraints, ...result.consider].map(e => e.id)
      expect(allIds).not.toContain('ENG-2026-0347-003')
    })

    it('formats an expired engram with the ⚠ EXPIRED marker at every layer', () => {
      const until = isoDaysAgo(5)
      const result = selectAndSpread(
        { prompt: 'deploy the app', maxTokens: 5000 },
        [recentlyExpired()], [],
        { expiry: { mode: 'soft', grace_days: 30 } },
      )
      const wire = [...result.directives, ...result.constraints, ...result.consider]
        .find(e => e.id === 'ENG-2026-0347-001')!
      for (const layer of [1, 2, 3] as const) {
        const text = formatWithLayer([wire], layer)
        expect(text).toContain(`⚠ EXPIRED ${until} — verify before use`)
      }
    })

    it('does not mark non-expired engrams', () => {
      const valid = makeEngram({
        id: 'ENG-2026-0347-004',
        statement: 'Deploy using blue-green strategy',
        temporal: { learned_at: '2026-01-01', valid_until: '2099-12-31' },
      })
      const result = selectAndSpread(
        { prompt: 'deploy the app', maxTokens: 5000 },
        [valid], [],
        { expiry: { mode: 'soft', grace_days: 30 } },
      )
      const wire = [...result.directives, ...result.constraints, ...result.consider]
        .find(e => e.id === 'ENG-2026-0347-004')!
      expect(formatWithLayer([wire], 3)).not.toContain('EXPIRED')
    })
  })

  // === formatLayer3 commitment tier rendering (SP1 Idea 6) ===

  describe('formatLayer3 commitment rendering', () => {
    const makeWire = (overrides: Partial<any> = {}): any => ({
      id: 'ENG-2026-0704-001',
      statement: 'Always deploy using blue-green strategy',
      confidence_score: 0.73,
      ...overrides,
    })

    // #348: commitment and confidence are distinct fields. These used to assert
    // `Confidence: <commitment>` with the numeric score HIDDEN — encoding the bug
    // where a low-confidence engram read as maximally certain. Now both show.
    for (const level of ['exploring', 'leaning', 'decided', 'locked', 'draft'] as const) {
      it(`renders "Commitment: ${level}" ALONGSIDE the confidence float`, () => {
        const wire = makeWire({ commitment: level })
        const text = formatWithLayer([wire], 3)
        expect(text).toContain(`Commitment: ${level}`)
        expect(text).toContain('Confidence: 0.73') // the number is NOT discarded
        expect(text).not.toContain(`Confidence: ${level}`) // commitment never masquerades as confidence
      })
    }

    it('renders only the float when commitment is not set', () => {
      const wire = makeWire()
      const text = formatWithLayer([wire], 3)
      expect(text).toContain('Confidence: 0.73')
      expect(text).not.toContain('Confidence: exploring')
      expect(text).not.toContain('Confidence: leaning')
      expect(text).not.toContain('Confidence: decided')
      expect(text).not.toContain('Confidence: locked')
    })
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

  // === Pinned engram budget cap (two-tier) ===

  it('soft-tier pinned engrams cannot consume more than 30% of the token budget', () => {
    // Engrams without pinned_tier default to 'soft'. With maxTokens=600,
    // the soft budget = floor(600 * 0.3) = 180. 30 engrams at ~50 tokens each
    // → only 3-4 fit under 180, leaving plenty of headroom under maxTokens (600)
    // proving the soft sub-cap is the binding constraint.
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
      keyword_match: 1.0,
      raw_score: 1.0,
      score: 1.0,
    }))
    const maxTokens = 600
    const { selected, tokens_used, evicted_soft_pinned } = fillTokenBudget(pinned, maxTokens)
    // Soft sub-cap binds: tokens_used must not exceed 30% of maxTokens.
    expect(tokens_used).toBeLessThanOrEqual(Math.floor(maxTokens * 0.3))
    // Headroom under maxTokens — outer guard is not the binding constraint.
    expect(tokens_used).toBeLessThan(maxTokens)
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThan(30)
    // Evicted soft-pinned list must be non-empty.
    expect(evicted_soft_pinned.length).toBeGreaterThan(0)
  })

  // === Two-tier pinned model tests ===

  describe('two-tier pinned model', () => {
    const makePinnedScoredEngram = (overrides: Record<string, any> = {}) => ({
      ...EngramSchema.parse({
        id: overrides.id ?? 'ENG-PIN-001',
        statement: overrides.statement ?? 'Always test before deploy',
        type: 'behavioral',
        scope: 'global',
        status: 'active',
        pinned: true,
        pinned_tier: overrides.pinned_tier,
        pinned_priority: overrides.pinned_priority,
        temporal: overrides.temporal,
      }),
      pinned: true,
      pinned_tier: overrides.pinned_tier,
      pinned_priority: overrides.pinned_priority,
      temporal: overrides.temporal,
      keyword_match: 1.0,
      raw_score: 1.0,
      score: 1.0,
    })

    it('hard-tier engrams inject before soft-tier engrams', () => {
      const hardEngram = makePinnedScoredEngram({ id: 'ENG-HARD-001', pinned_tier: 'hard', statement: 'Always test before deploy' })
      const softEngram = makePinnedScoredEngram({ id: 'ENG-SOFT-001', pinned_tier: 'soft', statement: 'Always use blue-green deploy' })
      const { selected } = fillTokenBudget([softEngram, hardEngram], 8000)
      const ids = selected.map(e => e.id)
      // Hard engram must be present; both should fit in 8000 tokens
      expect(ids).toContain('ENG-HARD-001')
      expect(ids).toContain('ENG-SOFT-001')
      // Hard engram must appear first (lower index) — it is always injected first
      expect(ids.indexOf('ENG-HARD-001')).toBeLessThan(ids.indexOf('ENG-SOFT-001'))
    })

    it('hard-tier engrams are capped at PINNED_HARD_TOKEN_CAP', () => {
      const shortStatement = 'X'.repeat(80)
      // Manufacture many hard-tier engrams that together exceed the 2000-token cap
      const hardEngrams = Array.from({ length: 40 }, (_, i) => makePinnedScoredEngram({
        id: `ENG-HARD-${String(i).padStart(3, '0')}`,
        pinned_tier: 'hard',
        statement: shortStatement,
      }))
      const { selected, tokens_used } = fillTokenBudget(hardEngrams, 8000)
      // Hard-tier tokens must not exceed the absolute cap
      expect(tokens_used).toBeLessThanOrEqual(PINNED_HARD_TOKEN_CAP)
      expect(selected.length).toBeGreaterThan(0)
      expect(selected.length).toBeLessThan(40)
    })

    it('soft-tier engrams are sorted by pinned_priority DESC', () => {
      const low = makePinnedScoredEngram({ id: 'ENG-LOW-001', pinned_tier: 'soft', pinned_priority: 10 })
      const high = makePinnedScoredEngram({ id: 'ENG-HIGH-001', pinned_tier: 'soft', pinned_priority: 90 })
      const mid = makePinnedScoredEngram({ id: 'ENG-MID-001', pinned_tier: 'soft', pinned_priority: 50 })
      const { selected } = fillTokenBudget([low, mid, high], 8000)
      const ids = selected.map(e => e.id)
      // Higher priority must appear before lower priority
      expect(ids.indexOf('ENG-HIGH-001')).toBeLessThan(ids.indexOf('ENG-MID-001'))
      expect(ids.indexOf('ENG-MID-001')).toBeLessThan(ids.indexOf('ENG-LOW-001'))
    })

    it('soft-tier tie-break by learned_at ASC (FIFO — oldest survives first)', () => {
      // Use a medium-length statement so token cost can be estimated reliably.
      // Each engram costs roughly (statement_len + fixed_overhead) / 4 tokens.
      // With statement='Y'.repeat(200), rough cost ≈ ceil(800/4) = 200 tokens.
      // softBudget = floor(maxTokens * 0.3). For maxTokens = 1200: softBudget = 360.
      // One engram (~200 tokens) fits; two (~400 tokens) do not.
      const medStatement = 'Y'.repeat(200)
      const oldTight = makePinnedScoredEngram({ id: 'ENG-OLD-001', pinned_tier: 'soft', pinned_priority: 50, statement: medStatement, temporal: { learned_at: '2026-01-01' } })
      const newTight = makePinnedScoredEngram({ id: 'ENG-NEW-001', pinned_tier: 'soft', pinned_priority: 50, statement: medStatement, temporal: { learned_at: '2026-08-01' } })
      // Compute actual cost so we pick a reliable budget
      const oneCost = estimateTokens(oldTight as any)
      // Set maxTokens so softBudget fits one engram but not two
      const maxTokens = Math.ceil(oneCost / 0.3) + 1  // softBudget just above oneCost
      const { selected, evicted_soft_pinned } = fillTokenBudget([newTight, oldTight], maxTokens)
      // Older engram (learned_at='2026-01-01') must survive; newer is evicted
      expect(selected.map((e: any) => e.id)).toContain('ENG-OLD-001')
      expect(evicted_soft_pinned.map(e => e.id)).toContain('ENG-NEW-001')
    })

    it('eviction warning is included when soft-tier engrams are evicted', () => {
      // Use fillTokenBudget directly (not selectAndSpread) so we can control costs precisely.
      // Two soft-pinned engrams with same short statement. Compute cost of one,
      // then set maxTokens so softBudget fits only one.
      const e1 = makePinnedScoredEngram({ id: 'ENG-EVICT-001', pinned_tier: 'soft', pinned_priority: 80 })
      const e2 = makePinnedScoredEngram({ id: 'ENG-EVICT-002', pinned_tier: 'soft', pinned_priority: 20 })
      const oneCost = estimateTokens(e1 as any)
      // softBudget = floor(maxTokens * 0.3) must fit e1 but not both e1+e2.
      // Set maxTokens = ceil(oneCost / 0.3) + 1 → softBudget = oneCost+1 (fits one, not two).
      // Also need maxTokens > oneCost so the outer guard doesn't evict e1 too.
      const maxTokens = Math.max(Math.ceil(oneCost / 0.3) + 10, oneCost + 100)
      const { selected, evicted_soft_pinned } = fillTokenBudget([e1, e2] as any, maxTokens)
      // e1 (higher priority) must be selected; e2 must be evicted
      expect(selected.map((e: any) => e.id)).toContain('ENG-EVICT-001')
      expect(evicted_soft_pinned.map(e => e.id)).toContain('ENG-EVICT-002')
      // Build eviction warnings manually to verify the format
      const result = selectAndSpread(
        { prompt: 'deploy the app', maxTokens },
        [e1, e2] as any, [],
      )
      expect(result.eviction_warnings).toBeDefined()
      expect(result.eviction_warnings![0]).toContain('SOFT-TIER EVICTION')
    })

    it('no eviction warning when all soft-tier engrams fit', () => {
      const e1 = makePinnedScoredEngram({ id: 'ENG-FIT-001', pinned_tier: 'soft', pinned_priority: 80 })
      const result = selectAndSpread(
        { prompt: 'deploy the app', maxTokens: 8000 },
        [e1] as any, [],
      )
      expect(result.eviction_warnings).toBeUndefined()
    })

    it('engram without pinned_tier defaults to soft tier', () => {
      const engram = makePinnedScoredEngram({ id: 'ENG-DEFAULT-001' /* no pinned_tier */ })
      const { selected } = fillTokenBudget([engram], 8000)
      // Should be selected (fits in soft budget)
      expect(selected.map(e => e.id)).toContain('ENG-DEFAULT-001')
    })

    it('PINNED_HARD_TOKEN_CAP is exported and equals 2000', () => {
      expect(PINNED_HARD_TOKEN_CAP).toBe(2000)
    })

    it('estimateEngramTokens returns a positive integer for a minimal engram', () => {
      const engram = EngramSchema.parse({
        id: 'ENG-EST-001',
        statement: 'Always verify before deploying',
        type: 'behavioral',
        scope: 'global',
        status: 'active',
      })
      const cost = estimateEngramTokens(engram)
      expect(cost).toBeGreaterThan(0)
      expect(Number.isInteger(cost)).toBe(true)
    })
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
        await plur.learn(`The deployment script is at scripts/deploy-${i}.sh and runs deploy daily`, { type: 'procedural' })
      }
      const pinned = await plur.learn('Never type a day-of-week from memory', {
        type: 'behavioral',
        pinned: true,
      })
      const result = await plur.inject('deploy', { budget: 8000 })
      expect(result.injected_ids).toContain(pinned.id)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
