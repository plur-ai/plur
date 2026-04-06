import { describe, it, expect } from 'vitest'
import { freshTailBoost } from '../src/fresh-tail.js'

describe('freshTailBoost', () => {
  const now = new Date('2026-04-06T00:00:00Z')

  it('gives +0.2 boost for engrams created today', () => {
    expect(freshTailBoost('2026-04-06T00:00:00Z', undefined, now)).toBeCloseTo(0.2, 2)
  })

  it('gives ~+0.1 boost for 3.5 days ago', () => {
    const boost = freshTailBoost('2026-04-03', undefined, now)
    expect(boost).toBeGreaterThan(0.05)
    expect(boost).toBeLessThan(0.15)
  })

  it('gives 0 for 7+ days ago', () => {
    expect(freshTailBoost('2026-03-30', undefined, now)).toBe(0)
  })

  it('applies to exploring commitment', () => {
    expect(freshTailBoost('2026-04-06T00:00:00Z', 'exploring', now)).toBeCloseTo(0.2, 2)
  })

  it('does NOT apply to decided commitment', () => {
    expect(freshTailBoost('2026-04-06T00:00:00Z', 'decided', now)).toBe(0)
  })

  it('does NOT apply to locked commitment', () => {
    expect(freshTailBoost('2026-04-06T00:00:00Z', 'locked', now)).toBe(0)
  })

  it('applies when no commitment set', () => {
    expect(freshTailBoost('2026-04-06T00:00:00Z', undefined, now)).toBeCloseTo(0.2, 2)
  })

  it('returns 0 for future dates', () => {
    expect(freshTailBoost('2026-04-10', undefined, now)).toBe(0)
  })

  it('decays linearly', () => {
    const day0 = freshTailBoost('2026-04-06T00:00:00Z', undefined, now)
    const day3 = freshTailBoost('2026-04-03', undefined, now)
    expect(day0).toBeGreaterThan(day3)
    expect(day3).toBeGreaterThan(0)
  })
})
