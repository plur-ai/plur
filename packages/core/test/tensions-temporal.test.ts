import { describe, it, expect, vi } from 'vitest'
import {
  engramDate,
  daysApart,
  inTemporalDomain,
  temporalDiscountFactor,
  getCandidatePairs,
  buildContradictionPrompt,
  buildBatchContradictionPrompt,
  scanForTensions,
} from '../src/tensions.js'
import type { Engram } from '../src/schemas/engram.js'
import { PlurConfigSchema } from '../src/schemas/config.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEngram(overrides: Partial<Engram> & { id: string; statement: string }): Engram {
  return {
    version: 2,
    status: 'active',
    consolidated: false,
    type: 'behavioral',
    scope: 'global',
    visibility: 'private',
    activation: {
      retrieval_strength: 0.7,
      storage_strength: 1,
      frequency: 0,
      last_accessed: '2026-05-16',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    knowledge_anchors: [],
    associations: [],
    derivation_count: 1,
    tags: [],
    content_hash: overrides.id,
    commitment: 'leaning',
    engram_version: 1,
    episode_ids: [],
    polarity: null,
    ...overrides,
  } as Engram
}

const NO_VERDICT = 'CONTRADICTS: no | CONFIDENCE: 0.1 | REASON: Fine.'
const batchNoLlm = vi.fn(async (prompt: string) => {
  const n = (prompt.match(/PAIR \d+/g) ?? []).length
  if (n === 0) return 'CONTRADICTS: no\nCONFIDENCE: 0.1\nREASON: Fine.'
  return Array.from({ length: n }, (_, i) => `PAIR_${i + 1}: ${NO_VERDICT}`).join('\n')
})

// ---------------------------------------------------------------------------
// engramDate (#240 Layer 3 prompt half)
// ---------------------------------------------------------------------------

describe('engramDate', () => {
  it('uses temporal.learned_at when present', () => {
    const e = makeEngram({
      id: 'ENG-2026-0101-001',
      statement: 'x',
      temporal: { learned_at: '2026-04-07T10:00:00Z' },
    })
    expect(engramDate(e)).toBe('2026-04-07')
  })

  it('falls back to the date embedded in a canonical ENG-YYYY-MMDD-NNN id', () => {
    const e = makeEngram({ id: 'ENG-2026-0519-052', statement: 'x' })
    expect(engramDate(e)).toBe('2026-05-19')
  })

  it('parses store-namespaced ids ENG-PREFIX-YYYY-MMDD-NNN', () => {
    const e = makeEngram({ id: 'ENG-TEAM-2026-0413-002', statement: 'x' })
    expect(engramDate(e)).toBe('2026-04-13')
  })

  it('parses server-assigned ids ENG-YYYY-MM-DD-NNN', () => {
    const e = makeEngram({ id: 'ENG-2026-05-06-007', statement: 'x' })
    expect(engramDate(e)).toBe('2026-05-06')
  })

  it('returns undefined when no date is derivable', () => {
    const e = makeEngram({ id: 'ENG-custom-id', statement: 'x' })
    expect(engramDate(e)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// daysApart
// ---------------------------------------------------------------------------

describe('daysApart', () => {
  it('returns 0 for the same day', () => {
    expect(daysApart('2026-04-07', '2026-04-07')).toBe(0)
  })

  it('returns the absolute difference in days', () => {
    expect(daysApart('2026-04-07', '2026-04-13')).toBe(6)
    expect(daysApart('2026-04-13', '2026-04-07')).toBe(6)
  })

  it('spans month boundaries', () => {
    expect(daysApart('2026-04-28', '2026-05-05')).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// inTemporalDomain (#240 Layer 2)
// ---------------------------------------------------------------------------

describe('inTemporalDomain', () => {
  it('matches an exact domain', () => {
    expect(inTemporalDomain('war-analysis', ['war-analysis'])).toBe(true)
  })

  it('matches dotted sub-domains of a configured domain', () => {
    expect(inTemporalDomain('war-analysis.hormuz', ['war-analysis'])).toBe(true)
  })

  it('does not match a different domain', () => {
    expect(inTemporalDomain('plur.core', ['war-analysis'])).toBe(false)
  })

  it('does not match a domain that merely shares a prefix string', () => {
    expect(inTemporalDomain('war-analysis-2', ['war-analysis'])).toBe(false)
  })

  it('returns false for missing domain or empty config', () => {
    expect(inTemporalDomain(undefined, ['war-analysis'])).toBe(false)
    expect(inTemporalDomain('war-analysis', [])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// temporalDiscountFactor (#240 Layer 3 multiplier — opt-in)
// ---------------------------------------------------------------------------

describe('temporalDiscountFactor', () => {
  it('same day → 1.0 (likely real contradiction)', () => {
    expect(temporalDiscountFactor(0)).toBe(1.0)
  })

  it('1-3 days apart → 0.8', () => {
    expect(temporalDiscountFactor(1)).toBe(0.8)
    expect(temporalDiscountFactor(3)).toBe(0.8)
  })

  it('4-14 days apart → 0.5', () => {
    expect(temporalDiscountFactor(4)).toBe(0.5)
    expect(temporalDiscountFactor(14)).toBe(0.5)
  })

  it('15+ days apart → 0.3', () => {
    expect(temporalDiscountFactor(15)).toBe(0.3)
    expect(temporalDiscountFactor(60)).toBe(0.3)
  })
})

// ---------------------------------------------------------------------------
// getCandidatePairs — snapshot-domain gate (#240 Layer 2)
// ---------------------------------------------------------------------------

describe('getCandidatePairs snapshot-domain gate (#240)', () => {
  const ceasefireA = () => makeEngram({
    id: 'ENG-2026-0407-001',
    statement: 'Iran ceasefire agreed April 7, Hormuz regulated passage',
    domain: 'war-analysis',
  })
  const ceasefireB = () => makeEngram({
    id: 'ENG-2026-0413-002',
    statement: 'Iran ceasefire collapsed, Hormuz passage closed again',
    domain: 'war-analysis',
  })

  it('skips snapshot-vs-snapshot pairs recorded on different days', () => {
    const pairs = getCandidatePairs([ceasefireA(), ceasefireB()], {
      temporal_domains: ['war-analysis'],
    })
    expect(pairs).toHaveLength(0)
  })

  it('keeps snapshot-vs-snapshot pairs recorded the same day (likely a correction)', () => {
    const a = ceasefireA()
    const b = ceasefireB()
    b.id = 'ENG-2026-0407-002' // same day as a
    const pairs = getCandidatePairs([a, b], { temporal_domains: ['war-analysis'] })
    expect(pairs).toHaveLength(1)
  })

  it('keeps mixed snapshot/standing pairs', () => {
    const a = ceasefireA()
    const b = ceasefireB()
    b.domain = undefined // standing engram with no domain — not a snapshot
    const pairs = getCandidatePairs([a, b], { temporal_domains: ['war-analysis'] })
    expect(pairs).toHaveLength(1)
  })

  it('is inert when no temporal domains are configured (default)', () => {
    const pairs = getCandidatePairs([ceasefireA(), ceasefireB()])
    expect(pairs).toHaveLength(1)
  })

  it('keeps snapshot pairs when snapshot_pairs=floor (judged, then confidence-capped)', () => {
    const pairs = getCandidatePairs([ceasefireA(), ceasefireB()], {
      temporal_domains: ['war-analysis'],
      snapshot_pairs: 'floor',
    })
    expect(pairs).toHaveLength(1)
  })

  it('does not skip when dates cannot be derived for both sides', () => {
    const a = ceasefireA()
    const b = ceasefireB()
    a.id = 'ENG-no-date-a'
    b.id = 'ENG-no-date-b'
    const pairs = getCandidatePairs([a, b], { temporal_domains: ['war-analysis'] })
    expect(pairs).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// getCandidatePairs — supersedes edge gate (#240 item 3)
// ---------------------------------------------------------------------------

describe('getCandidatePairs supersedes gate (#240)', () => {
  it('skips pairs linked by relations.supersedes', () => {
    const oldE = makeEngram({ id: 'E1', statement: 'plur cli version is 0.3.0' })
    const newE = makeEngram({
      id: 'E2',
      statement: 'plur cli version is 0.8.2',
      relations: { broader: [], narrower: [], related: [], conflicts: [], supersedes: ['E1'], superseded_by: [] },
    })
    expect(getCandidatePairs([oldE, newE])).toHaveLength(0)
  })

  it('skips pairs linked by relations.superseded_by', () => {
    const oldE = makeEngram({
      id: 'E1',
      statement: 'plur cli version is 0.3.0',
      relations: { broader: [], narrower: [], related: [], conflicts: [], supersedes: [], superseded_by: ['E2'] },
    })
    const newE = makeEngram({ id: 'E2', statement: 'plur cli version is 0.8.2' })
    expect(getCandidatePairs([oldE, newE])).toHaveLength(0)
  })

  it('keeps unlinked pairs', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur cli version is 0.3.0' })
    const b = makeEngram({ id: 'E2', statement: 'plur cli version is 0.8.2' })
    expect(getCandidatePairs([a, b])).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// getCandidatePairs — expired validity gate (#240 / #347 real fields)
// ---------------------------------------------------------------------------

describe('getCandidatePairs expired-validity gate (#240)', () => {
  it('skips pairs where one side has a closed valid_until in the past', () => {
    const expired = makeEngram({
      id: 'E1',
      statement: 'Iran ceasefire holds in the hormuz strait',
      temporal: { learned_at: '2026-04-07', valid_until: '2026-04-22' },
    })
    const current = makeEngram({
      id: 'E2',
      statement: 'Iran ceasefire collapsed in the hormuz strait',
      temporal: { learned_at: '2026-05-05' },
    })
    const pairs = getCandidatePairs([expired, current], { now: '2026-07-02' })
    expect(pairs).toHaveLength(0)
  })

  it('keeps pairs whose valid_until is still in the future', () => {
    const a = makeEngram({
      id: 'E1',
      statement: 'plur discount code CONF20 works',
      temporal: { learned_at: '2026-06-01', valid_until: '2099-12-31' },
    })
    const b = makeEngram({
      id: 'E2',
      statement: 'plur discount code CONF20 is invalid',
      temporal: { learned_at: '2026-06-02' },
    })
    const pairs = getCandidatePairs([a, b], { now: '2026-07-02' })
    expect(pairs).toHaveLength(1)
  })

  it('keeps pairs with no validity windows', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur uses yaml' })
    const b = makeEngram({ id: 'E2', statement: 'plur uses json' })
    expect(getCandidatePairs([a, b], { now: '2026-07-02' })).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Prompt dates (#240 Layer 3 prompt half)
// ---------------------------------------------------------------------------

describe('buildContradictionPrompt with dates', () => {
  it('includes both dates and the days-apart evolution nudge', () => {
    const prompt = buildContradictionPrompt(
      { id: 'E1', statement: 'Ceasefire agreed.', date: '2026-04-07' },
      { id: 'E2', statement: 'Ceasefire collapsed.', date: '2026-04-13' },
    )
    expect(prompt).toContain('2026-04-07')
    expect(prompt).toContain('2026-04-13')
    expect(prompt).toContain('6 days apart')
    expect(prompt).toMatch(/temporal evolution/i)
  })

  it('stays byte-identical to the legacy prompt when no dates are passed', () => {
    const prompt = buildContradictionPrompt(
      { id: 'E1', statement: 'A' },
      { id: 'E2', statement: 'B' },
    )
    expect(prompt).not.toMatch(/days apart/i)
    expect(prompt).not.toMatch(/recorded/i)
    expect(prompt).toContain('CONTRADICTS: yes|no')
  })

  it('omits the nudge when only one side has a date', () => {
    const prompt = buildContradictionPrompt(
      { id: 'E1', statement: 'A', date: '2026-04-07' },
      { id: 'E2', statement: 'B' },
    )
    expect(prompt).not.toMatch(/days apart/i)
  })
})

describe('buildBatchContradictionPrompt with dates', () => {
  it('annotates each dated pair and includes the evolution guidance', () => {
    const prompt = buildBatchContradictionPrompt([
      [
        { id: 'E1', statement: 'Ceasefire agreed.', date: '2026-04-07' },
        { id: 'E2', statement: 'Ceasefire collapsed.', date: '2026-04-13' },
      ],
      [
        { id: 'E3', statement: 'Y is red.' },
        { id: 'E4', statement: 'Y is blue.' },
      ],
    ])
    expect(prompt).toContain('2026-04-07')
    expect(prompt).toContain('2026-04-13')
    expect(prompt).toContain('6 days apart')
    expect(prompt).toMatch(/temporal evolution/i)
  })

  it('has no temporal guidance when no pair is dated', () => {
    const prompt = buildBatchContradictionPrompt([
      [{ id: 'E1', statement: 'A' }, { id: 'E2', statement: 'B' }],
    ])
    expect(prompt).not.toMatch(/days apart/i)
  })
})

// ---------------------------------------------------------------------------
// TensionsConfig schema (#240 Layer 2 config home)
// ---------------------------------------------------------------------------

describe('tensions config block (#240)', () => {
  it('parses temporal_domains and snapshot_pairs', () => {
    const parsed = PlurConfigSchema.parse({
      tensions: {
        temporal_domains: ['war-analysis', 'geopolitics', 'markets'],
        snapshot_pairs: 'floor',
        temporal_discount: true,
      },
    })
    expect(parsed.tensions?.temporal_domains).toEqual(['war-analysis', 'geopolitics', 'markets'])
    expect(parsed.tensions?.snapshot_pairs).toBe('floor')
    expect(parsed.tensions?.temporal_discount).toBe(true)
  })

  it('defaults: no temporal domains, skip behavior, discount off', () => {
    const parsed = PlurConfigSchema.parse({ tensions: {} })
    expect(parsed.tensions?.temporal_domains ?? []).toEqual([])
    expect(parsed.tensions?.snapshot_pairs ?? 'skip').toBe('skip')
    expect(parsed.tensions?.temporal_discount ?? false).toBe(false)
  })

  it('config without a tensions block still parses (backward compat)', () => {
    const parsed = PlurConfigSchema.parse({ auto_learn: true })
    expect(parsed.auto_learn).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// scanForTensions temporal integration (#240)
// ---------------------------------------------------------------------------

describe('scanForTensions temporal integration (#240)', () => {
  it('feeds engram dates into the judge prompt', async () => {
    const a = makeEngram({
      id: 'ENG-2026-0407-001',
      statement: 'plur ceasefire status is holding',
      temporal: { learned_at: '2026-04-07' },
    })
    const b = makeEngram({
      id: 'ENG-2026-0413-002',
      statement: 'plur ceasefire status is collapsed',
      temporal: { learned_at: '2026-04-13' },
    })
    const prompts: string[] = []
    const llm = vi.fn(async (p: string) => {
      prompts.push(p)
      return `PAIR_1: ${NO_VERDICT}`
    })
    await scanForTensions([a, b], llm)
    expect(prompts.join('\n')).toContain('2026-04-07')
    expect(prompts.join('\n')).toContain('2026-04-13')
  })

  it('skips snapshot-domain pairs entirely (no LLM call)', async () => {
    const a = makeEngram({ id: 'ENG-2026-0407-001', statement: 'hormuz strait passage regulated', domain: 'war-analysis' })
    const b = makeEngram({ id: 'ENG-2026-0505-001', statement: 'hormuz strait passage closed', domain: 'war-analysis' })
    const llm = vi.fn(async () => NO_VERDICT)
    const result = await scanForTensions([a, b], llm, { temporal_domains: ['war-analysis'] })
    expect(result.pairs_checked).toBe(0)
    expect(llm).not.toHaveBeenCalled()
  })

  it('floor mode caps snapshot-pair confidence at 0.1', async () => {
    const a = makeEngram({ id: 'ENG-2026-0407-001', statement: 'hormuz strait passage regulated', domain: 'war-analysis' })
    const b = makeEngram({ id: 'ENG-2026-0505-001', statement: 'hormuz strait passage closed', domain: 'war-analysis' })
    const llm = vi.fn(async () => 'PAIR_1: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Opposite.')
    const result = await scanForTensions([a, b], llm, {
      temporal_domains: ['war-analysis'],
      snapshot_pairs: 'floor',
      min_confidence: 0.05,
    })
    expect(result.pairs_checked).toBe(1)
    expect(result.new_tensions).toBe(1)
    expect(result.tensions[0].confidence).toBeCloseTo(0.1)
    // suppressed under the default 0.7 threshold
    const suppressed = await scanForTensions([a, b], llm, {
      temporal_domains: ['war-analysis'],
      snapshot_pairs: 'floor',
    })
    expect(suppressed.new_tensions).toBe(0)
  })

  it('temporal discount is OFF by default — far-apart standing contradictions surface at raw confidence', async () => {
    const a = makeEngram({ id: 'E1', statement: 'plur uses tabs for indentation', temporal: { learned_at: '2026-04-01' } })
    const b = makeEngram({ id: 'E2', statement: 'plur uses spaces for indentation', temporal: { learned_at: '2026-06-01' } })
    const llm = vi.fn(async () => 'PAIR_1: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Opposite.')
    const result = await scanForTensions([a, b], llm)
    expect(result.new_tensions).toBe(1)
    expect(result.tensions[0].confidence).toBeCloseTo(0.9)
  })

  it('temporal discount ON multiplies confidence by the ladder factor', async () => {
    const a = makeEngram({ id: 'E1', statement: 'plur uses tabs for indentation', temporal: { learned_at: '2026-04-01' } })
    const b = makeEngram({ id: 'E2', statement: 'plur uses spaces for indentation', temporal: { learned_at: '2026-06-01' } })
    const llm = vi.fn(async () => 'PAIR_1: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Opposite.')
    const result = await scanForTensions([a, b], llm, { temporal_discount: true, min_confidence: 0.2 })
    expect(result.new_tensions).toBe(1)
    // 61 days apart → 0.3 factor → 0.27
    expect(result.tensions[0].confidence).toBeCloseTo(0.27)
    expect(result.tensions[0].raw_confidence).toBeCloseTo(0.9)

    // Under the default 0.7 threshold the discounted pair is suppressed
    const suppressed = await scanForTensions([a, b], llm, { temporal_discount: true })
    expect(suppressed.new_tensions).toBe(0)
  })

  it('temporal discount leaves same-day pairs untouched', async () => {
    const a = makeEngram({ id: 'E1', statement: 'plur uses tabs for indentation', temporal: { learned_at: '2026-04-01' } })
    const b = makeEngram({ id: 'E2', statement: 'plur uses spaces for indentation', temporal: { learned_at: '2026-04-01' } })
    const llm = vi.fn(async () => 'PAIR_1: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Opposite.')
    const result = await scanForTensions([a, b], llm, { temporal_discount: true })
    expect(result.new_tensions).toBe(1)
    expect(result.tensions[0].confidence).toBeCloseTo(0.9)
  })

  it('reports days_apart on detected tensions when derivable', async () => {
    const a = makeEngram({ id: 'E1', statement: 'plur uses tabs for indentation', temporal: { learned_at: '2026-04-07' } })
    const b = makeEngram({ id: 'E2', statement: 'plur uses spaces for indentation', temporal: { learned_at: '2026-04-13' } })
    const llm = vi.fn(async () => 'PAIR_1: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Opposite.')
    const result = await scanForTensions([a, b], llm)
    expect(result.tensions[0].days_apart).toBe(6)
  })

  it('single-pair mode (batch_size 1) also gets dates', async () => {
    const a = makeEngram({ id: 'E1', statement: 'plur uses tabs for indentation', temporal: { learned_at: '2026-04-07' } })
    const b = makeEngram({ id: 'E2', statement: 'plur uses spaces for indentation', temporal: { learned_at: '2026-04-13' } })
    const prompts: string[] = []
    const llm = vi.fn(async (p: string) => {
      prompts.push(p)
      return 'CONTRADICTS: no\nCONFIDENCE: 0.1\nREASON: Fine.'
    })
    await scanForTensions([a, b], llm, { batch_size: 1 })
    expect(prompts[0]).toContain('2026-04-07')
    expect(prompts[0]).toContain('6 days apart')
  })
})
