/**
 * Shortening a statement must not destroy a character (#995).
 *
 * `list` sliced by code unit, so any astral character landing on the boundary
 * was cut in half and printed as a replacement character. A tester found it
 * with an emoji at position 59.
 *
 * Counting characters fixes that but leaves the column misaligned: a Chinese,
 * Japanese or Korean character occupies two terminal cells while a Latin letter
 * occupies one. The same tester measured a Latin row at 60 cells and a Japanese
 * one at 85.
 */
import { describe, it, expect } from 'vitest'
import { clipToWidth } from '../src/commands/list.js'

/** Terminal cells a string occupies, by the same rule the code uses. */
const widthOf = (s: string) => Array.from(s).reduce((w, ch) => {
  const cp = ch.codePointAt(0) ?? 0
  const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  return w + (wide ? 2 : 1)
}, 0)

describe('clipping a statement for a fixed-width column', () => {
  it('never produces a replacement character', () => {
    // An emoji sitting exactly on the boundary is the case that broke.
    for (let pad = 55; pad <= 62; pad++) {
      const text = 'a'.repeat(pad) + '🌟' + 'b'.repeat(20)
      expect(clipToWidth(text, 60), `pad=${pad}`).not.toContain('�')
    }
  })

  it('keeps a wide-character row inside the same column width as a Latin one', () => {
    const latin = clipToWidth('a'.repeat(200), 60)
    const cjk = clipToWidth('東京'.repeat(100), 60)
    expect(widthOf(latin)).toBeLessThanOrEqual(60)
    expect(widthOf(cjk)).toBeLessThanOrEqual(60)
  })

  it('leaves a short statement exactly as it was', () => {
    expect(clipToWidth('short', 60)).toBe('short')
    expect(clipToWidth('東京は大きい', 60)).toBe('東京は大きい')
  })

  it('marks a statement that was shortened', () => {
    expect(clipToWidth('a'.repeat(200), 60)).toMatch(/…$/)
  })

  it('does not mark one that was not', () => {
    expect(clipToWidth('short', 60)).not.toContain('…')
  })

  it('handles an emoji built from several code points', () => {
    const family = '👩‍💻'.repeat(30)
    const out = clipToWidth(family, 60)
    expect(out).not.toContain('�')
    expect(widthOf(out)).toBeLessThanOrEqual(60)
  })
})
