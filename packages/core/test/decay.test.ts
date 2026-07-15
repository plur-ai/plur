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

  it('reactivate bumps strength', () => {
    expect(reactivate(0.3)).toBe(0.4)
    expect(reactivate(0.95)).toBe(1.0)
  })
})
