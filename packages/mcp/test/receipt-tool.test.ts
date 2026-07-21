import { describe, it, expect } from 'vitest'
import { getToolDefinitions, CURSOR_CORE_TOOL_NAMES } from '../src/tools.js'

describe('plur_receipt tool', () => {
  it('is registered in the full profile', () => {
    expect(getToolDefinitions().find(t => t.name === 'plur_receipt')).toBeDefined()
  })

  it('accepts an optional days parameter that is not required', () => {
    const tool = getToolDefinitions().find(t => t.name === 'plur_receipt')!
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
    expect(schema.properties?.days).toBeDefined()
    expect(schema.required ?? []).not.toContain('days')
  })

  it('is marked read-only', () => {
    const tool = getToolDefinitions().find(t => t.name === 'plur_receipt')!
    expect(tool.annotations?.readOnlyHint).toBe(true)
  })

  it('describes itself without promising savings or cost', () => {
    const tool = getToolDefinitions().find(t => t.name === 'plur_receipt')!
    const desc = tool.description.toLowerCase()
    for (const banned of ['saving', 'cost', 'dollar', '$']) {
      expect(desc).not.toContain(banned)
    }
  })

  it('is available directly on the Cursor profile (read-only, not admin-gated)', () => {
    expect(CURSOR_CORE_TOOL_NAMES.has('plur_receipt')).toBe(true)
    expect(getToolDefinitions('cursor').find(t => t.name === 'plur_receipt')).toBeDefined()
  })
})
