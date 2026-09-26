/**
 * Apply phase of the formal-verification run (owner decisions I3, I5).
 * Model: spec/formal/PlurSpec/ScopeInject.lean §6.
 *
 * I3 move: the default miss floor sits strictly between 1/61 and 2/61, so a
 *    recall whose top hit came from ONE retrieval leg (RRF score 1/61) counts as
 *    `low_score`, while a top hit both legs ranked first (2/61) is a hit.
 * I5 first: the miss-signal `domain` is sent as its first dotted segment only.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyMiss,
  buildMissSignalPayload,
  DEFAULT_MISS_SCORE_THRESHOLD,
} from '../src/telemetry-miss-signal.js'

describe('I3 — default miss floor between 1/61 and 2/61', () => {
  it('the default floor is strictly between a single-leg and a both-leg top hit', () => {
    expect(DEFAULT_MISS_SCORE_THRESHOLD).toBeGreaterThan(1 / 61)
    expect(DEFAULT_MISS_SCORE_THRESHOLD).toBeLessThan(2 / 61)
  })

  it('a single-leg top hit (1/61) classifies as low_score at the default floor', () => {
    expect(classifyMiss({ resultCount: 1, topScore: 1 / 61 })).toBe('low_score')
  })

  it('good case: a top hit both legs ranked first (2/61) is a hit', () => {
    expect(classifyMiss({ resultCount: 1, topScore: 2 / 61 })).toBeNull()
  })

  // RRF (hybrid-search.ts rrfMerge, k = 60): rank r in one list scores 1/(61 + r).
  it('a document both legs found counts as a hit while its second-leg rank is ≤ 55', () => {
    const both = (r: number) => 1 / 61 + 1 / (61 + r)
    expect(classifyMiss({ resultCount: 2, topScore: both(0) })).toBeNull()
    expect(classifyMiss({ resultCount: 2, topScore: both(55) })).toBeNull()
    expect(classifyMiss({ resultCount: 2, topScore: both(56) })).toBe('low_score')
  })
})

describe('I5 — domain is sent as its first dotted segment only', () => {
  const now = new Date('2026-06-14T10:00:00Z')
  const mk = (domain: string | undefined) =>
    buildMissSignalPayload({ query: 'q', domain, resultCount: 0, topScore: null }, 'no_results', 'id', now).domain

  it('a dotted domain is reduced to its first segment', () => {
    expect(mk('acme-secret.clients.bigbank')).toBe('acme-secret')
    expect(mk('plur.engineering.search')).toBe('plur')
  })

  it('the rest of the domain path never reaches the wire', () => {
    const payload = buildMissSignalPayload(
      { query: 'q', domain: 'trading.client-foo.deal-42', resultCount: 0, topScore: null }, 'no_results', 'id', now)
    expect(JSON.stringify(payload)).not.toContain('client-foo')
    expect(JSON.stringify(payload)).not.toContain('deal-42')
  })

  it('good case: a single-segment domain is sent as is; absent or empty is null', () => {
    expect(mk('trading')).toBe('trading')
    expect(mk(undefined)).toBeNull()
    expect(mk('')).toBeNull()
    expect(mk('.x')).toBeNull()
  })
})
