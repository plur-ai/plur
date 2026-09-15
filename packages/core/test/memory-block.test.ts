import { describe, it, expect } from 'vitest'
import { renderMemoryBlock } from '../src/memory-block.js'

describe('renderMemoryBlock', () => {
  it('returns the instructions block when there is no injection', () => {
    const out = renderMemoryBlock({ injection: null })
    expect(out).toContain('[PLUR Memory System]')
    expect(out).not.toContain('## Your Memories')
  })

  it('appends directives under a Your Memories heading', () => {
    const out = renderMemoryBlock({
      injection: { count: 1, directives: '[ENG-1] Always use pnpm.', constraints: '', text: '' } as any,
    })
    expect(out).toContain('## Your Memories')
    expect(out).toContain('[ENG-1] Always use pnpm.')
  })

  it('omits directives when the token budget cannot fit them', () => {
    const out = renderMemoryBlock({
      injection: { count: 1, directives: '[ENG-1] Always use pnpm.', constraints: '', text: '' } as any,
      tokenBudget: 10,
      usedTokens: 10,
    })
    expect(out).not.toContain('[ENG-1] Always use pnpm.')
  })
})
