import { describe, expect, it } from 'vitest'
import { createCounters } from '../src/counters.js'

describe('createCounters', () => {
  it('starts every counter at zero', () => {
    expect(createCounters().snapshot()).toEqual({
      refresh_attempted: 0,
      blocks_written: 0,
      blocks_unchanged: 0,
      engrams_rendered: 0,
      learn_captured: 0,
      compaction_learned: 0,
      errors_swallowed: 0,
    })
  })

  it('bump increments', () => {
    const c = createCounters()
    c.bump('blocks_written')
    c.bump('blocks_written')
    expect(c.snapshot().blocks_written).toBe(2)
  })

  it('snapshot is a copy, not a live view', () => {
    const c = createCounters()
    const first = c.snapshot()
    c.bump('errors_swallowed')
    expect(first.errors_swallowed).toBe(0)
    expect(c.snapshot().errors_swallowed).toBe(1)
  })
})
