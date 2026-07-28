import { describe, it, expect } from 'vitest'
import { assembleContext, estimateTokens } from '../src/assembler.js'

describe('assembler', () => {
  it('includes PLUR memory instructions even with no injection', () => {
    const result = assembleContext({
      messages: [{ role: 'user', content: 'hello' }],
      injection: null,
    })
    expect(result.messages).toHaveLength(1)
    expect(result.systemPromptAddition).toContain('PLUR Memory System')
    expect(result.systemPromptAddition).toContain('🧠 I learned')
  })

  it('adds engrams to system prompt when injection provided', () => {
    const result = assembleContext({
      messages: [{ role: 'user', content: 'deploy the app' }],
      injection: {
        directives: '- Always use blue-green deployments',
        constraints: '',
        consider: '- Production DB is on port 5433',
        count: 2,
        tokens_used: 50,
        injected_ids: ['ENG-2026-0101-001', 'ENG-2026-0101-002'],
      },
    })
    expect(result.systemPromptAddition).toContain('blue-green')
    expect(result.systemPromptAddition).toContain('5433')
    expect(result.systemPromptAddition).toContain('PLUR Memory System')
    expect(result.systemPromptAddition).toContain('Your Memories')
  })

  it('includes both directives and consider sections', () => {
    const result = assembleContext({
      messages: [],
      injection: {
        directives: '- Rule 1',
        constraints: '',
        consider: '- Suggestion 1',
        count: 2,
        tokens_used: 30,
        injected_ids: ['ENG-2026-0101-003', 'ENG-2026-0101-004'],
      },
    })
    expect(result.systemPromptAddition).toContain('things you have learned')
    expect(result.systemPromptAddition).toContain('may also be relevant')
  })

  it('estimates tokens correctly', () => {
    const result = assembleContext({
      messages: [{ role: 'user', content: 'x'.repeat(400) }],
      injection: {
        directives: '- test',
        constraints: '',
        consider: '',
        count: 1,
        tokens_used: 10,
        injected_ids: ['ENG-2026-0101-005'],
      },
    })
    expect(result.estimatedTokens).toBeGreaterThan(100)
  })

  it('still includes instructions with empty engrams', () => {
    const result = assembleContext({
      messages: [],
      injection: {
        directives: '',
        constraints: '',
        consider: '',
        count: 0,
        tokens_used: 0,
        injected_ids: [],
      },
    })
    // Instructions always present, but no "Your Memories" section
    expect(result.systemPromptAddition).toContain('PLUR Memory System')
    expect(result.systemPromptAddition).not.toContain('Your Memories')
  })
})
