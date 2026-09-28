/**
 * Apply phase of the formal-verification run (owner decisions I6, I7).
 * Model: spec/formal/PlurSpec/ScopeInject.lean §7.
 *
 * I6 above-floor: decay moves a strength toward FLOOR only from above; a
 *    strength at or below the floor never rises with time (feedback can floor a
 *    strength at 0.0, below decay's 0.05).
 * I7 delete: the exported, unused `shouldInject` is gone.
 */
import { describe, it, expect } from 'vitest'
import * as decay from '../src/decay.js'
import { decayedStrength } from '../src/decay.js'

describe('I6 — decay applies only above the floor', () => {
  it('a strength of 0 does not rise with time', () => {
    expect(decayedStrength(0, 0)).toBe(0)
    expect(decayedStrength(0, 30)).toBe(0)
    expect(decayedStrength(0, 3650)).toBe(0)
  })

  it('a sub-floor strength stays where it is', () => {
    expect(decayedStrength(0.02, 60)).toBe(0.02)
  })

  it('a strength exactly at the floor stays at the floor', () => {
    expect(decayedStrength(0.05, 100)).toBe(0.05)
  })

  it('good case: a strength above the floor still decays toward it, never below', () => {
    const d = decayedStrength(0.8, 30)
    expect(d).toBeLessThan(0.8)
    expect(d).toBeGreaterThan(0.05)
    expect(decayedStrength(0.8, 0)).toBeCloseTo(0.8, 12)
    expect(decayedStrength(1.0, 365 * 20)).toBeGreaterThanOrEqual(0.05)
  })
})

describe('I7 — shouldInject is deleted', () => {
  it('decay.ts no longer exports shouldInject', () => {
    expect('shouldInject' in decay).toBe(false)
  })
})
