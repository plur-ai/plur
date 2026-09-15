import { describe, it, expect } from 'vitest'
import { RenderPath } from '../src/capability.js'

describe('RenderPath', () => {
  it('does not fall back before any turn has run', () => {
    expect(new RenderPath().shouldFallback('s1')).toBe(false)
  })

  it('does not fall back while system.transform is rendering', () => {
    const p = new RenderPath()
    p.markTurn('s1'); p.markRendered('s1')
    expect(p.shouldFallback('s1')).toBe(false)
  })

  it('falls back after a turn completes with no render', () => {
    const p = new RenderPath()
    p.markTurn('s1')
    expect(p.shouldFallback('s1')).toBe(true)
  })

  // Self-healing (I4): a session that starts rendering again leaves the
  // fallback on its own — recovery no longer needs an opencode restart.
  it('recovers from fallback once rendering resumes', () => {
    const p = new RenderPath()
    p.markTurn('s1')
    expect(p.shouldFallback('s1')).toBe(true)
    p.markRendered('s1')
    expect(p.shouldFallback('s1')).toBe(false)
  })

  // Detection must survive the self-healing change: a session that never
  // renders again must stay latched forever, not just until the next read.
  it('stays latched across turns that never render', () => {
    const p = new RenderPath()
    p.markTurn('s1')
    expect(p.shouldFallback('s1')).toBe(true)
    p.markTurn('s1') // another turn passes, still no render
    expect(p.shouldFallback('s1')).toBe(true)
  })

  // Per-session isolation (I4): RenderPath used to be one instance per
  // plugin, shared across every session in the process. An unlucky
  // interleave — session A's session.idle consuming the render flag session
  // B's system.transform had just set — could latch the accreting fallback
  // for every session. Each session's state must be independent.
  it('isolates fallback state per session', () => {
    const p = new RenderPath()
    p.markTurn('a') // session a's turn ends with no render
    p.markRendered('b') // session b is rendering fine, unrelated to a
    expect(p.shouldFallback('a')).toBe(true)
    expect(p.shouldFallback('b')).toBe(false)
  })

  it('a session that renders is unaffected by another session latching', () => {
    const p = new RenderPath()
    p.markTurn('a')
    expect(p.shouldFallback('a')).toBe(true) // a latches
    p.markTurn('b'); p.markRendered('b')
    expect(p.shouldFallback('b')).toBe(false) // b never latches
    expect(p.shouldFallback('a')).toBe(true) // a is still latched, independently
  })

  it('clear() drops a session state without disturbing others', () => {
    const p = new RenderPath()
    p.markTurn('a')
    expect(p.shouldFallback('a')).toBe(true)
    p.markTurn('b'); p.markRendered('b')
    p.clear('a')
    // a's state is gone — treated as a brand-new session, no history of the latch.
    expect(p.shouldFallback('a')).toBe(false)
    expect(p.shouldFallback('b')).toBe(false)
  })
})
