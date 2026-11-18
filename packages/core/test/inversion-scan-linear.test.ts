/**
 * Security audit 2026-11-06 (hardening): inversion-scan's lastWord() matched
 * /[.!?,;:]+$/ and /([A-Za-z']+)$/ against the whole statement; both
 * backtrack quadratically on a long run that does not reach the end (40k
 * characters took about 1.6 s). Only the last 256 characters are matched now.
 */
import { describe, it, expect } from 'vitest'
import { scanForInversions } from '../src/inversion-scan.js'

describe('inversion-scan stays linear (security audit 2026-11-06)', () => {
  it('a 200k-char punctuation run finishes in under 200 ms', () => {
    const t0 = performance.now()
    scanForInversions([{ id: 'ENG-1', statement: 'x' + '.'.repeat(200_000) + 'x' }])
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('a 200k-char letter run ending in a non-letter finishes in under 200 ms', () => {
    const t0 = performance.now()
    scanForInversions([{ id: 'ENG-2', statement: 'a'.repeat(200_000) + '1' }])
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('still flags a statement cut off on a function word', () => {
    const long = 'Always run the dummy migration step before deploying to staging because the'
    const out = scanForInversions([{ id: 'ENG-3', statement: 'filler '.repeat(100) + long }])
    expect(out.map(s => s.shapes).flat()).toContain('truncated-tail')
  })
})
