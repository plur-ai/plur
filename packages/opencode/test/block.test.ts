import { describe, it, expect } from 'vitest'
import { BlockCache } from '../src/block.js'

describe('BlockCache', () => {
  it('returns undefined for an unknown session', () => {
    expect(new BlockCache().get('ses_x')).toBeUndefined()
  })

  it('round-trips a block per session', () => {
    const c = new BlockCache()
    c.set('ses_a', 'A')
    c.set('ses_b', 'B')
    expect(c.get('ses_a')).toBe('A')
    expect(c.get('ses_b')).toBe('B')
  })

  it('overwrites on a later turn rather than appending', () => {
    const c = new BlockCache()
    c.set('ses_a', 'turn1')
    c.set('ses_a', 'turn2')
    expect(c.get('ses_a')).toBe('turn2')
  })

  it('clears one session without touching others', () => {
    const c = new BlockCache()
    c.set('ses_a', 'A'); c.set('ses_b', 'B')
    c.clear('ses_a')
    expect(c.get('ses_a')).toBeUndefined()
    expect(c.get('ses_b')).toBe('B')
  })
})
