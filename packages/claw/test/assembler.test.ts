import { describe, it, expect } from 'vitest'
import { assembleContext, estimateTokens } from '../src/assembler.js'

describe('assembler', () => {
  it('returns messages unchanged when no injection', () => {
    const result = assembleContext({
      messages: [{ role: 'user', content: 'hello' }],
      injection: null,
    })
    expect(result.messages).toHaveLength(1)
    expect(result.systemPromptAddition).toBeUndefined()
  })

  it('adds engrams to system prompt when injection provided', () => {
    const result = assembleContext({
      messages: [{ role: 'user', content: 'deploy the app' }],
      injection: {
        directives: '- Always use blue-green deployments',
        consider: '- Production DB is on port 5433',
        count: 2,
        tokens_used: 50,
      },
    })
    expect(result.systemPromptAddition).toContain('blue-green')
    expect(result.systemPromptAddition).toContain('5433')
    expect(result.systemPromptAddition).toContain('PLUR Memory')
  })

  it('includes both directives and consider sections', () => {
    const result = assembleContext({
      messages: [],
      injection: {
        directives: '- Rule 1',
        consider: '- Suggestion 1',
        count: 2,
        tokens_used: 30,
      },
    })
    expect(result.systemPromptAddition).toContain('Directives')
    expect(result.systemPromptAddition).toContain('Also Consider')
  })

  it('estimates tokens correctly', () => {
    const result = assembleContext({
      messages: [{ role: 'user', content: 'x'.repeat(400) }],
      injection: {
        directives: '- test',
        consider: '',
        count: 1,
        tokens_used: 10,
      },
    })
    expect(result.estimatedTokens).toBeGreaterThan(100) // 400/4 = 100 for message alone
  })

  it('handles empty directives gracefully', () => {
    const result = assembleContext({
      messages: [],
      injection: { directives: '', consider: '', count: 0, tokens_used: 0 },
    })
    expect(result.systemPromptAddition).toBeUndefined()
  })
})
