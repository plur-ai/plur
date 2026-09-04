/**
 * plur_learn exposes pinned_priority (#1121) and the tool's argument
 * validator, not the engine, is the first gate: strings, floats and
 * out-of-range integers from the LLM are refused with the structured
 * error every tool uses, before any write path runs.
 */
import { describe, it, expect } from 'vitest'
import { getToolDefinitions, validateToolArgs } from '../src/tools.js'

const learn = getToolDefinitions('full').find(t => t.name === 'plur_learn')!

describe('plur_learn pinned_priority argument', () => {
  it('is declared with its bounds', () => {
    const prop = (learn.inputSchema.properties as Record<string, any>).pinned_priority
    expect(prop).toMatchObject({ type: 'number', minimum: 1, maximum: 100 })
  })

  it('rejects a string, a non-finite number and out-of-range values', () => {
    for (const bad of ['90', 'high', 0, 101, -1, 1e308, Number.POSITIVE_INFINITY]) {
      const v = validateToolArgs(learn, { statement: 'rule', pinned: true, pinned_priority: bad })
      expect(v.ok, String(bad)).toBe(false)
    }
  })

  it('accepts an integer in range', () => {
    const v = validateToolArgs(learn, { statement: 'rule', pinned: true, pinned_priority: 90 })
    expect(v.ok).toBe(true)
    expect((v as any).data.pinned_priority).toBe(90)
  })
})
