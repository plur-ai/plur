/**
 * Unit coverage for the render-boundary sanitizer.
 *
 * The integration-level guarantee lives in injection-render-boundary.test.ts;
 * this file pins the primitive itself, including the property that makes it
 * safe to share with dsh: the line-break SET must match dsh's LINE_BREAKS.
 */
import { describe, it, expect } from 'vitest'
import { sanitizeInline, sanitizeInlineOptional, LINE_BREAK_CODE_POINTS } from '../src/sanitize-inline.js'

const C = (n: number): string => String.fromCharCode(n)

/**
 * LF, CR, LS, PS, NEL, VT, FF, FS, GS, RS, US -- written out independently of
 * the module so the test asserts the intended set rather than echoing whatever
 * the module happens to define.
 */
const LINE_BREAK_CODES = [0x0a, 0x0d, 0x2028, 0x2029, 0x85, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x1f]

describe('sanitizeInline', () => {
  it.each(LINE_BREAK_CODES)('collapses code point %i', code => {
    expect(sanitizeInline('a' + C(code) + 'b')).toBe('a b')
  })

  it('collapses a run of mixed line breaks to a single space', () => {
    expect(sanitizeInline('a' + C(0x0d) + C(0x0a) + C(0x2028) + 'b')).toBe('a b')
  })

  it('collapses to a space, never welding words together', () => {
    expect(sanitizeInline('alpha' + C(0x0a) + 'beta')).toBe('alpha beta')
  })

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeInline('  padded  ')).toBe('padded')
    expect(sanitizeInline(C(0x0a) + 'x' + C(0x0a))).toBe('x')
  })

  it('is idempotent', () => {
    const once = sanitizeInline('a' + C(0x0a) + C(0x0a) + 'b')
    expect(sanitizeInline(once)).toBe(once)
  })

  it('returns empty string for input that is entirely line breaks', () => {
    expect(sanitizeInline(C(0x0a) + C(0x0d) + C(0x2028))).toBe('')
  })

  it('preserves non-Latin text, emoji and surrogate pairs', () => {
    const jp = C(0x65e5) + C(0x672c) + C(0x8a9e)
    const rocket = String.fromCodePoint(0x1f680)
    expect(sanitizeInline(jp + ' ' + rocket)).toBe(jp + ' ' + rocket)
  })

  it('preserves tabs, brackets and hashes -- they forge nothing on one line', () => {
    expect(sanitizeInline('use arr[0]')).toBe('use arr[0]')
    expect(sanitizeInline('channel #ops')).toBe('channel #ops')
  })

  it('deliberately preserves zero-width and bidi marks', () => {
    // Stripping U+200E/U+200F would corrupt right-to-left text, and once every
    // line break is gone a zero-width space cannot start a line, so it cannot
    // open a heading. Documented choice, pinned here so it is not "fixed".
    expect(sanitizeInline('a' + C(0x200b) + 'b')).toBe('a' + C(0x200b) + 'b')
    expect(sanitizeInline('a' + C(0x200f) + 'b')).toBe('a' + C(0x200f) + 'b')
  })
})

describe('sanitizeInlineOptional', () => {
  it('passes undefined and null through as undefined', () => {
    expect(sanitizeInlineOptional(undefined)).toBeUndefined()
    expect(sanitizeInlineOptional(null)).toBeUndefined()
  })

  it('coerces non-strings rather than throwing at injection time', () => {
    expect(sanitizeInlineOptional(42)).toBe('42')
    expect(sanitizeInlineOptional(true)).toBe('true')
  })

  it('sanitizes a coerced value too', () => {
    expect(sanitizeInlineOptional({ toString: () => 'a' + C(0x0a) + 'b' })).toBe('a b')
  })
})

describe('the line-break set matches dsh flatten()', () => {
  it('covers exactly the characters dsh treats as line breaks', () => {
    // A character one layer collapses and the other splits on is the gap this
    // whole module exists to close, so the two sets are asserted equal -- as
    // SETS, not as a regex, so neither side can drift silently.
    expect([...LINE_BREAK_CODE_POINTS].sort((a, b) => a - b))
      .toEqual([...LINE_BREAK_CODES].sort((a, b) => a - b))
  })

  it('leaves ordinary whitespace and content characters alone', () => {
    for (const ch of [' ', C(0x09), 'a', '[', '#', C(0x200b)]) {
      expect(sanitizeInline('x' + ch + 'y'), 'code point ' + ch.charCodeAt(0)).toContain(ch)
    }
  })
})
