import { describe, it, expect } from 'vitest'
import { decayedStrength, daysSince, shouldInject, reactivate } from '../src/decay.js'

describe('decay as deprioritization', () => {
  it('decays retrieval strength over time', () => {
    const fresh = decayedStrength(1.0, 1)
    const old = decayedStrength(1.0, 180)
    expect(fresh).toBeGreaterThan(old)
    expect(old).toBeGreaterThan(0)
  })

  it('has a floor — never decays below 0.05', () => {
    const veryOld = decayedStrength(1.0, 365 * 10)
    expect(veryOld).toBeGreaterThanOrEqual(0.05)
  })

  it('daysSince calculates correctly', () => {
    const now = new Date('2026-03-19')
    expect(daysSince('2026-03-18', now)).toBe(1)
    expect(daysSince('2026-03-19', now)).toBe(0)
    expect(daysSince('2025-09-19', now)).toBe(181)
  })

  it('scope-matched engrams always inject regardless of decay', () => {
    const result = shouldInject(
      { retrieval_strength: 0.01, scope: 'project:myapp', last_accessed: '2025-01-01' },
      { scope: 'project:myapp' }
    )
    expect(result).toBe(true)
  })

  it('global low-strength engrams are deprioritized', () => {
    const result = shouldInject(
      { retrieval_strength: 0.1, scope: 'global', last_accessed: '2025-01-01' },
      { task: 'fix myapp bug' }
    )
    expect(result).toBe(false)
  })

  // Was 'reactivate bumps strength'. That bump is the defect (#846): passive
  // retrieval added +0.10 while a deliberate ★ added +0.05 and a ✗ subtracted
  // 0.10 — so a rating was worth half of being incidentally fetched, and a
  // "this is wrong" was exactly cancelled by the next recall that returned the
  // engram. Traffic and quality now live in different fields.
  it('reactivate leaves strength untouched — retrieval is not a quality signal', () => {
    expect(reactivate(0.3)).toBe(0.3)
    expect(reactivate(0.95)).toBe(0.95)
    expect(reactivate(1.0)).toBe(1.0)
    expect(reactivate(0)).toBe(0)
  })
})
