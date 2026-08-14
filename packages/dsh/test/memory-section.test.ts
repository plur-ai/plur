import { describe, expect, it } from 'vitest'
import { blockHash, createMemoryCache, renderBlock } from '../src/memory-section.ts'

const e = (id: string, statement: string, confidence = 0.9, domain?: string) =>
  ({ id, statement, confidence, domain })

describe('renderBlock', () => {
  it('renders nothing for an empty set, so the prompt section stays absent', () => {
    expect(renderBlock([], 2000)).toBe('')
  })

  it('renders high-confidence engrams under a DIRECTIVES heading', () => {
    const out = renderBlock([e('ENG-1', 'Always pin dsh deps.')], 2000)
    expect(out).toContain('## DIRECTIVES')
    expect(out).toContain('[ENG-1]')
    expect(out).toContain('Always pin dsh deps.')
  })

  it('separates low-confidence engrams into ALSO CONSIDER', () => {
    const out = renderBlock([e('ENG-1', 'High.', 0.9), e('ENG-2', 'Low.', 0.3)], 2000)
    expect(out.indexOf('## DIRECTIVES')).toBeLessThan(out.indexOf('## ALSO CONSIDER'))
    expect(out).toContain('[ENG-2]')
  })

  it('omits the DIRECTIVES heading when nothing qualifies', () => {
    const out = renderBlock([e('ENG-2', 'Low.', 0.1)], 2000)
    expect(out).not.toContain('## DIRECTIVES')
    expect(out).toContain('## ALSO CONSIDER')
  })

  it('trims to the token budget rather than emitting an oversized block', () => {
    const many = Array.from({ length: 500 }, (_, i) => e(`ENG-${i}`, 'x'.repeat(200)))
    const out = renderBlock(many, 100)
    expect(out.length).toBeLessThan(1200)
  })

  it('emits nothing at all for a zero budget', () => {
    expect(renderBlock([e('ENG-1', 'Anything.')], 0)).toBe('')
  })

  it('is deterministic for the same input', () => {
    const set = [e('ENG-1', 'One.'), e('ENG-2', 'Two.')]
    expect(renderBlock(set, 2000)).toBe(renderBlock(set, 2000))
  })

  it('tolerates a missing confidence by treating it as low', () => {
    const out = renderBlock([{ id: 'ENG-1', statement: 'No confidence field.' }], 2000)
    expect(out).toContain('## ALSO CONSIDER')
  })
})

describe('blockHash', () => {
  it('matches for identical content and differs otherwise', () => {
    expect(blockHash('a')).toBe(blockHash('a'))
    expect(blockHash('a')).not.toBe(blockHash('b'))
  })
})

describe('createMemoryCache', () => {
  it('reads empty string for an unknown agent', () => {
    expect(createMemoryCache().read('nope')).toBe('')
  })

  it('write returns true on change and false when unchanged', () => {
    const cache = createMemoryCache()
    expect(cache.write('a1', 'block one')).toBe(true)
    expect(cache.write('a1', 'block one')).toBe(false)
    expect(cache.write('a1', 'block two')).toBe(true)
  })

  it('keeps agents isolated', () => {
    const cache = createMemoryCache()
    cache.write('a1', 'one')
    cache.write('a2', 'two')
    expect(cache.read('a1')).toBe('one')
    expect(cache.read('a2')).toBe('two')
  })

  it('clear drops an agent so a disposed session leaks nothing', () => {
    const cache = createMemoryCache()
    cache.write('a1', 'one')
    cache.clear('a1')
    expect(cache.read('a1')).toBe('')
  })

  it('a cleared agent accepts the same block again as a change', () => {
    const cache = createMemoryCache()
    cache.write('a1', 'one')
    cache.clear('a1')
    expect(cache.write('a1', 'one')).toBe(true)
  })
})
