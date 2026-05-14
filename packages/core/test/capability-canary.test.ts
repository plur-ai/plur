import { describe, it, expect, beforeEach } from 'vitest'
import { CapabilityCanary } from '../src/capability-canary.js'

describe('CapabilityCanary', () => {
  let canary: CapabilityCanary

  beforeEach(() => {
    canary = new CapabilityCanary({ threshold: 3 })
    canary.expect({ id: 'learn', description: 'learning hook', fix: 'check allowConversationAccess' })
    canary.expect({ id: 'inject', description: 'injection hook' })
  })

  it('is healthy before threshold is reached', () => {
    canary.tick()
    canary.tick()
    const statuses = canary.status()
    expect(statuses.every((s) => s.healthy)).toBe(true)
    expect(canary.warnings()).toBe('')
  })

  it('stays healthy when capabilities fire', () => {
    canary.signal('learn')
    canary.signal('inject')
    canary.tick()
    canary.tick()
    canary.tick()
    expect(canary.status().every((s) => s.healthy)).toBe(true)
    expect(canary.warnings()).toBe('')
  })

  it('flags unhealthy after threshold ticks with no firing', () => {
    canary.tick()
    canary.tick()
    canary.tick()
    const statuses = canary.status()
    expect(statuses.every((s) => !s.healthy)).toBe(true)
    expect(canary.warnings()).toContain('learn')
    expect(canary.warnings()).toContain('inject')
  })

  it('only flags capabilities that have not fired', () => {
    canary.signal('inject')
    canary.tick()
    canary.tick()
    canary.tick()
    const statuses = canary.status()
    const learn = statuses.find((s) => s.capability === 'learn')!
    const inject = statuses.find((s) => s.capability === 'inject')!
    expect(learn.healthy).toBe(false)
    expect(inject.healthy).toBe(true)
    expect(canary.warnings()).toContain('learn')
    expect(canary.warnings()).not.toContain('inject')
  })

  it('includes fix hint in warning when provided', () => {
    canary.tick()
    canary.tick()
    canary.tick()
    const warnings = canary.warnings()
    expect(warnings).toContain('allowConversationAccess')
  })

  it('does not include fix hint when not provided', () => {
    canary.tick()
    canary.tick()
    canary.tick()
    const injectStatus = canary.status().find((s) => s.capability === 'inject')!
    expect(injectStatus.warning).not.toContain('Fix:')
  })

  it('reset clears tick count and fire counts', () => {
    canary.signal('learn')
    canary.tick()
    canary.tick()
    canary.tick()
    canary.reset()
    // after reset, threshold not reached — healthy again
    expect(canary.status().every((s) => s.healthy)).toBe(true)
    // firedCount reset to 0
    expect(canary.status().every((s) => s.firedCount === 0)).toBe(true)
  })

  it('ignores signal for unknown capability id', () => {
    canary.signal('unknown')
    canary.tick()
    canary.tick()
    canary.tick()
    // known capabilities still unhealthy
    expect(canary.status().every((s) => !s.healthy)).toBe(true)
  })

  it('uses default threshold of 3 when not specified', () => {
    const c = new CapabilityCanary()
    c.expect({ id: 'x', description: 'test' })
    c.tick()
    c.tick()
    expect(c.status()[0]?.healthy).toBe(true)
    c.tick()
    expect(c.status()[0]?.healthy).toBe(false)
  })

  it('all statuses have registered: true for expected capabilities', () => {
    expect(canary.status().every((s) => s.registered)).toBe(true)
  })
})
