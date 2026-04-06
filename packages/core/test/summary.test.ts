import { describe, it, expect } from 'vitest'
import { needsSummary, generateSummary, autoSummary } from '../src/summary.js'

describe('needsSummary', () => {
  it('returns false for short statements', () => { expect(needsSummary('Short')).toBe(false) })
  it('returns true for long statements', () => { expect(needsSummary('A'.repeat(201))).toBe(true) })
  it('returns true for remember level', () => { expect(needsSummary('A'.repeat(201), 'remember')).toBe(true) })
  it('returns false for evaluate level', () => { expect(needsSummary('A'.repeat(201), 'evaluate')).toBe(false) })
})

describe('generateSummary', () => {
  it('uses first sentence if short', () => {
    expect(generateSummary('Use port 3000. Configure via PORT.')).toBe('Use port 3000.')
  })
  it('truncates long text', () => {
    const long = 'This is a very long statement that should be truncated at a word boundary not in the middle'
    const summary = generateSummary(long)
    expect(summary.length).toBeLessThanOrEqual(63)
    expect(summary).toMatch(/\.\.\.$/)
  })
})

describe('autoSummary', () => {
  it('returns undefined for short', () => { expect(autoSummary('Short')).toBeUndefined() })
  it('returns summary for long', () => {
    const summary = autoSummary('Word '.repeat(50))
    expect(summary).toBeDefined()
    expect(summary!.length).toBeLessThanOrEqual(63)
  })
})
