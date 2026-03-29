import { describe, it, expect } from 'vitest'
import { generateGuardrails } from '../src/guardrails.js'

describe('generateGuardrails', () => {
  it('generates markdown with all three sections', () => {
    const md = generateGuardrails()
    expect(md).toContain('## PLUR Memory Guardrails')
    expect(md).toContain('### Verification Protocol')
    expect(md).toContain('### Over-engineering Check')
    expect(md).toContain('### Tool Selection Discipline')
  })

  it('returns valid markdown starting with heading', () => {
    const md = generateGuardrails()
    expect(md.startsWith('## PLUR')).toBe(true)
    expect(md.length).toBeGreaterThan(200)
  })

  it('includes meta-engram hypothesis warning', () => {
    const md = generateGuardrails()
    expect(md).toContain('hypotheses, not rules')
  })
})
