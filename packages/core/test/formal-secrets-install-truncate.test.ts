/**
 * Cutting text to the scan limit never throws and always yields valid text
 * (a split character becomes one U+FFFD), including when the cut splits a multi-byte character.
 */
import { describe, it, expect } from 'vitest'
import { truncateToScanLimit, detectSensitive, SCAN_TRUNCATED } from '../src/secrets.js'

const CAP = 1024 * 1024
const wellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

describe('truncateToScanLimit', () => {
  it('returns text at or under the limit unchanged', () => {
    const s = 'é'.repeat(CAP / 2)
    expect(truncateToScanLimit(s)).toBe(s)
  })

  it.each([
    ['a 2-byte character', 'é', 1],
    ['a 3-byte character', '€', 1],
    ['a 3-byte character', '€', 2],
    ['a 4-byte character (surrogate pair)', '😀', 1],
    ['a 4-byte character (surrogate pair)', '😀', 3],
  ])('splitting %s at the limit yields valid text, never throwing (offset %i)', (_l, ch, off) => {
    const text = 'x'.repeat(CAP - off) + ch.repeat(4)
    let out = ''
    expect(() => { out = truncateToScanLimit(text) }).not.toThrow()
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(CAP + 2)
    expect(wellFormed(out)).toBe(true)
    expect(out.startsWith('x'.repeat(CAP - off))).toBe(true)
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out)
  })

  it('detectSensitive scans the cut text and still reports the input as truncated', () => {
    const text = 'x'.repeat(CAP - 1) + '😀'
    const hits = detectSensitive(text)
    expect(hits.map(h => h.pattern)).toContain(SCAN_TRUNCATED)
  })
})
