import { describe, it, expect, beforeEach } from 'vitest'
import { CapabilityCanary } from '../src/capability-canary.js'

describe('CapabilityCanary', () => {
  let canary: CapabilityCanary

  beforeEach(() => {
    canary = new CapabilityCanary({ threshold: 3 })
    canary.expect({ id: 'learn', description: 'learning hook', fix: 'check allowConversationAccess' })
    canary.expect({ id: 'inject', description: 'injection hook' })
  })

  it('is healthy before threshold is reached', async () => {
    canary.tick()
    canary.tick()
    const statuses = await canary.status()
    expect(statuses.every((s) => s.healthy)).toBe(true)
    expect(await canary.warnings()).toBe('')
  })

  it('stays healthy when capabilities fire', async () => {
    canary.signal('learn')
    canary.signal('inject')
    canary.tick()
    canary.tick()
    canary.tick()
    expect((await canary.status()).every((s) => s.healthy)).toBe(true)
    expect(await canary.warnings()).toBe('')
  })

  it('flags unhealthy after threshold ticks with no firing', async () => {
    canary.tick()
    canary.tick()
    canary.tick()
    const statuses = await canary.status()
    expect(statuses.every((s) => !s.healthy)).toBe(true)
    expect(await canary.warnings()).toContain('learn')
    expect(await canary.warnings()).toContain('inject')
  })

  it('only flags capabilities that have not fired', async () => {
    canary.signal('inject')
    canary.tick()
    canary.tick()
    canary.tick()
    const statuses = await canary.status()
    const learn = statuses.find((s) => s.capability === 'learn')!
    const inject = statuses.find((s) => s.capability === 'inject')!
    expect(learn.healthy).toBe(false)
    expect(inject.healthy).toBe(true)
    expect(await canary.warnings()).toContain('learn')
    expect(await canary.warnings()).not.toContain('inject')
  })

  it('includes fix hint in warning when provided', async () => {
    canary.tick()
    canary.tick()
    canary.tick()
    const warnings = await canary.warnings()
    expect(warnings).toContain('allowConversationAccess')
  })

  it('does not include fix hint when not provided', async () => {
    canary.tick()
    canary.tick()
    canary.tick()
    const injectStatus = (await canary.status()).find((s) => s.capability === 'inject')!
    expect(injectStatus.warning).not.toContain('Fix:')
  })

  it('reset clears tick count and fire counts', async () => {
    canary.signal('learn')
    canary.tick()
    canary.tick()
    canary.tick()
    canary.reset()
    // after reset, threshold not reached — healthy again
    expect((await canary.status()).every((s) => s.healthy)).toBe(true)
    // firedCount reset to 0
    expect((await canary.status()).every((s) => s.firedCount === 0)).toBe(true)
  })

  it('ignores signal for unknown capability id', async () => {
    canary.signal('unknown')
    canary.tick()
    canary.tick()
    canary.tick()
    // known capabilities still unhealthy
    expect((await canary.status()).every((s) => !s.healthy)).toBe(true)
  })

  it('uses default threshold of 3 when not specified', async () => {
    const c = new CapabilityCanary()
    c.expect({ id: 'x', description: 'test' })
    c.tick()
    c.tick()
    expect((await c.status())[0]?.healthy).toBe(true)
    c.tick()
    expect((await c.status())[0]?.healthy).toBe(false)
  })

  it('all statuses have registered: true for expected capabilities', async () => {
    expect((await canary.status()).every((s) => s.registered)).toBe(true)
  })
})
