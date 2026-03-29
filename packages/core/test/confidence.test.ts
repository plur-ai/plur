import { describe, it, expect } from 'vitest'
import { computeConfidence, computeMetaConfidence, confidenceBand } from '../src/confidence.js'

describe('computeConfidence', () => {
  it('returns 0.5 for engram with no feedback', () => {
    expect(computeConfidence({
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      consolidated: false,
    })).toBeCloseTo(0.5, 1)
  })

  it('increases with positive feedback', () => {
    expect(computeConfidence({
      feedback_signals: { positive: 5, negative: 0, neutral: 0 },
      consolidated: false,
    })).toBeGreaterThan(0.7)
  })

  it('decreases with negative feedback', () => {
    expect(computeConfidence({
      feedback_signals: { positive: 0, negative: 3, neutral: 0 },
      consolidated: false,
    })).toBeLessThan(0.4)
  })

  it('is bounded between 0 and 1', () => {
    const high = computeConfidence({ feedback_signals: { positive: 100, negative: 0, neutral: 0 }, consolidated: false })
    const low = computeConfidence({ feedback_signals: { positive: 0, negative: 100, neutral: 0 }, consolidated: false })
    expect(high).toBeLessThanOrEqual(1.0)
    expect(low).toBeGreaterThanOrEqual(0.0)
  })

  it('boosts consolidated engrams', () => {
    const base = { feedback_signals: { positive: 2, negative: 0, neutral: 0 } }
    const unconsolidated = computeConfidence({ ...base, consolidated: false })
    const consolidated = computeConfidence({ ...base, consolidated: true })
    expect(consolidated).toBeGreaterThan(unconsolidated)
  })

  it('dampens confidence when sample size is small', () => {
    const oneVote = computeConfidence({ feedback_signals: { positive: 1, negative: 0, neutral: 0 }, consolidated: false })
    const tenVotes = computeConfidence({ feedback_signals: { positive: 10, negative: 0, neutral: 0 }, consolidated: false })
    expect(tenVotes).toBeGreaterThan(oneVote)
  })

  it('handles undefined feedback_signals gracefully', () => {
    expect(computeConfidence({ consolidated: false })).toBeCloseTo(0.5, 1)
  })
})

describe('computeMetaConfidence', () => {
  it('computes composite from weighted signals (3,3,3,0)', () => {
    // evidenceSignal: min(3/5,1)*0.25 = 0.6*0.25 = 0.15
    // domainSignal:   min(3/3,1)*0.35 = 1.0*0.35 = 0.35
    // depthSignal:    min(3/3,1)*0.20 = 1.0*0.20 = 0.20
    // validationSignal: 0*0.20 = 0.0
    // total: 0.70
    expect(computeMetaConfidence(3, 3, 3, 0)).toBeCloseTo(0.70, 5)
  })

  it('caps evidence signal at 5 engrams', () => {
    const atFive = computeMetaConfidence(5, 0, 0, 0)
    const atTen = computeMetaConfidence(10, 0, 0, 0)
    // Both should yield the same evidence signal (capped at 1.0 * 0.25 = 0.25)
    expect(atFive).toBeCloseTo(0.25, 5)
    expect(atTen).toBeCloseTo(0.25, 5)
  })

  it('returns small but non-zero when all inputs are minimal (1,1,1,0.1)', () => {
    // evidenceSignal: min(1/5,1)*0.25 = 0.2*0.25 = 0.05
    // domainSignal:   min(1/3,1)*0.35 ≈ 0.333*0.35 ≈ 0.1167
    // depthSignal:    min(1/3,1)*0.20 ≈ 0.333*0.20 ≈ 0.0667
    // validationSignal: 0.1*0.20 = 0.02
    // total ≈ 0.2533
    const result = computeMetaConfidence(1, 1, 1, 0.1)
    expect(result).toBeGreaterThan(0)
    expect(result).toBeLessThan(0.5)
  })
})

describe('confidenceBand', () => {
  it('returns high for scores >= 0.7', () => {
    expect(confidenceBand(0.7)).toBe('high')
    expect(confidenceBand(0.95)).toBe('high')
    expect(confidenceBand(1.0)).toBe('high')
  })

  it('returns medium for scores >= 0.4 and < 0.7', () => {
    expect(confidenceBand(0.4)).toBe('medium')
    expect(confidenceBand(0.5)).toBe('medium')
    expect(confidenceBand(0.69)).toBe('medium')
  })

  it('returns low for scores < 0.4', () => {
    expect(confidenceBand(0.0)).toBe('low')
    expect(confidenceBand(0.25)).toBe('low')
    expect(confidenceBand(0.39)).toBe('low')
  })
})
