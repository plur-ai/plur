/**
 * D3 (overhaul): a pin over its share is never dropped invisibly — the
 * session-start context carries one line naming what did not fit.
 */
import { describe, it, expect } from 'vitest'
import { pinOverflowNotice } from '../src/commands/hook-inject.js'

describe('pin overflow notice', () => {
  it('is absent when every pin fit', () => {
    expect(pinOverflowNotice({})).toBeNull()
    expect(pinOverflowNotice({ omitted_pinned: [] })).toBeNull()
  })
  it('is one line naming count, cost, share and the first five ids', () => {
    const omitted = Array.from({ length: 7 }, (_, i) => ({ id: `ENG-2026-0101-00${i}`, cost: 10 }))
    const line = pinOverflowNotice({ omitted_pinned: omitted, pinned_share_tokens: 1000 })!
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('7 pinned engrams (70 tokens)')
    expect(line).toContain('of 1000 tokens')
    expect(line).toContain('ENG-2026-0101-004')
    expect(line).not.toContain('ENG-2026-0101-005')
    expect(line).toContain('and 2 more')
  })
})
