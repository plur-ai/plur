import { describe, it, expect } from 'vitest'
import { formatLayer1, formatLayer2, formatLayer3, formatWithLayer, assignLayer } from '../src/inject.js'

describe('progressive disclosure', () => {
  const makeWire = (overrides: Partial<any> = {}) => ({
    id: 'ENG-001', statement: 'Use port 3000 for dev. Configure via PORT env var.',
    type: 'behavioral', scope: 'global', status: 'active',
    rationale: 'Avoids conflicts with system services.',
    domain: 'infrastructure', summary: 'Port 3000 for dev',
    confidence_score: 0.85,
    activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 3, last_accessed: '2026-03-15' },
    consolidated: false, version: 2, visibility: 'private',
    derivation_count: 1, tags: [], pack: null, abstract: null,
    derived_from: null, polarity: null,
    feedback_signals: { positive: 2, negative: 0, neutral: 0 },
    knowledge_anchors: [], associations: [],
    ...overrides,
  })

  it('formatLayer1 uses summary', () => {
    expect(formatLayer1(makeWire())).toBe('[ENG-001] Port 3000 for dev')
  })

  it('formatLayer2 uses full statement', () => {
    expect(formatLayer2(makeWire())).toContain('Use port 3000')
  })

  it('formatLayer3 includes rationale and metadata', () => {
    const f = formatLayer3(makeWire())
    expect(f).toContain('Rationale:')
    expect(f).toContain('Domain:')
    expect(f).toContain('Confidence:')
  })

  it('assignLayer maps correctly (F20)', () => {
    expect(assignLayer('directives')).toBe(3)
    expect(assignLayer('constraints')).toBe(2)
    expect(assignLayer('consider')).toBe(1)
  })

  it('formatWithLayer Layer 1 is pipe-separated', () => {
    const f = formatWithLayer([makeWire({ id: 'E1' }), makeWire({ id: 'E2' })], 1)
    expect(f).toContain(' | ')
  })

  it('formatWithLayer returns empty for empty array', () => {
    expect(formatWithLayer([], 1)).toBe('')
    expect(formatWithLayer([], 2)).toBe('')
    expect(formatWithLayer([], 3)).toBe('')
  })
})
