import { describe, it, expect } from 'vitest'
import { CapabilityCanary } from '../src/capability-canary.js'

describe('CapabilityCanary', () => {
  it('reports healthy before threshold is reached', () => {
    const canary = new CapabilityCanary({ threshold: 3 })
    canary.expect({ id: 'learn', description: 'Learning from conversations' })
    canary.tick()
    canary.tick()
    const statuses = canary.status()
    expect(statuses).toHaveLength(1)
    expect(statuses[0].healthy).toBe(true)
    expect(statuses[0].firedCount).toBe(0)
    expect(statuses[0].tickCount).toBe(2)
  })

  it('reports unhealthy after threshold with zero signals', () => {
    const canary = new CapabilityCanary({ threshold: 3 })
    canary.expect({ id: 'learn', description: 'Learning from conversations', fix: 'run fix cmd' })
    canary.tick()
    canary.tick()
    canary.tick()
    const statuses = canary.status()
    expect(statuses[0].healthy).toBe(false)
    expect(statuses[0].warning).toContain('Learning from conversations')
    expect(statuses[0].warning).toContain('3 turns')
    expect(statuses[0].warning).toContain('run fix cmd')
  })

  it('reports healthy when capability has fired', () => {
    const canary = new CapabilityCanary({ threshold: 3 })
    canary.expect({ id: 'learn', description: 'Learning' })
    canary.tick()
    canary.signal('learn')
    canary.tick()
    canary.tick()
    canary.tick()
    const statuses = canary.status()
    expect(statuses[0].healthy).toBe(true)
    expect(statuses[0].firedCount).toBe(1)
  })

  it('warnings() returns empty string when all healthy', () => {
    const canary = new CapabilityCanary({ threshold: 3 })
    canary.expect({ id: 'learn', description: 'Learning' })
    canary.tick()
    canary.signal('learn')
    expect(canary.warnings()).toBe('')
  })

  it('warnings() returns concatenated warnings for multiple unhealthy capabilities', () => {
    const canary = new CapabilityCanary({ threshold: 2 })
    canary.expect({ id: 'learn', description: 'Learning', fix: 'fix-learn' })
    canary.expect({ id: 'capture', description: 'Capturing', fix: 'fix-capture' })
    canary.tick()
    canary.tick()
    const w = canary.warnings()
    expect(w).toContain('Learning')
    expect(w).toContain('Capturing')
    expect(w).toContain('fix-learn')
    expect(w).toContain('fix-capture')
  })

  it('mixed healthy and unhealthy capabilities', () => {
    const canary = new CapabilityCanary({ threshold: 2 })
    canary.expect({ id: 'inject', description: 'Injection' })
    canary.expect({ id: 'learn', description: 'Learning', fix: 'fix it' })
    canary.tick()
    canary.signal('inject')
    canary.tick()
    const statuses = canary.status()
    const inject = statuses.find(s => s.capability === 'inject')!
    const learn = statuses.find(s => s.capability === 'learn')!
    expect(inject.healthy).toBe(true)
    expect(learn.healthy).toBe(false)
  })

  it('reset() clears counters', () => {
    const canary = new CapabilityCanary({ threshold: 2 })
    canary.expect({ id: 'learn', description: 'Learning' })
    canary.tick()
    canary.tick()
    expect(canary.status()[0].healthy).toBe(false)
    canary.reset()
    expect(canary.status()[0].healthy).toBe(true)
    expect(canary.status()[0].tickCount).toBe(0)
    expect(canary.status()[0].firedCount).toBe(0)
  })

  it('defaults to threshold of 3', () => {
    const canary = new CapabilityCanary()
    canary.expect({ id: 'x', description: 'X' })
    canary.tick()
    canary.tick()
    expect(canary.status()[0].healthy).toBe(true)
    canary.tick()
    expect(canary.status()[0].healthy).toBe(false)
  })

  it('signal for unregistered capability does not throw', () => {
    const canary = new CapabilityCanary()
    expect(() => canary.signal('nonexistent')).not.toThrow()
  })

  it('warning omits fix line when fix is not provided', () => {
    const canary = new CapabilityCanary({ threshold: 1 })
    canary.expect({ id: 'learn', description: 'Learning' })
    canary.tick()
    expect(canary.status()[0].warning).not.toContain('Fix:')
  })
})
