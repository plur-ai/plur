import { describe, it, expect } from 'vitest'
import { RenderPath } from '../src/capability.js'

describe('RenderPath', () => {
  it('does not fall back before any turn has run', () => {
    expect(new RenderPath().shouldFallback()).toBe(false)
  })

  it('does not fall back while system.transform is rendering', () => {
    const p = new RenderPath()
    p.markTurn(); p.markRendered()
    expect(p.shouldFallback()).toBe(false)
  })

  it('falls back after a turn completes with no render', () => {
    const p = new RenderPath()
    p.markTurn()
    expect(p.shouldFallback()).toBe(true)
  })

  it('stays in fallback once it has decided', () => {
    const p = new RenderPath()
    p.markTurn()
    expect(p.shouldFallback()).toBe(true)
    p.markRendered()
    expect(p.shouldFallback()).toBe(true)
  })
})
