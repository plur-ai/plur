import { describe, it, expect } from 'vitest'
import { extractLearnings } from '../src/learner.js'

describe('extractLearnings', () => {
  it('extracts a decision as an architectural candidate with confidence 0.8', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'We decided to use PostgreSQL for the database.' },
    ])
    expect(learnings).toHaveLength(1)
    expect(learnings[0].type).toBe('architectural')
    expect(learnings[0].confidence).toBe(0.8)
  })

  it('extracts an always/never rule as a behavioral candidate with confidence 0.7', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'Always run tests before deploying to production.' },
    ])
    expect(learnings).toHaveLength(1)
    expect(learnings[0].type).toBe('behavioral')
    expect(learnings[0].confidence).toBe(0.7)
  })

  it('extracts a correction phrased as "X, not Y" with confidence 0.8', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'The port is 5433, not 5432.' },
    ])
    expect(learnings).toHaveLength(1)
    expect(learnings[0].type).toBe('behavioral')
    expect(learnings[0].confidence).toBe(0.8)
  })

  it('extracts an identity statement as terminological', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'You are Data, inspired by Star Trek Lieutenant Commander Data' },
    ])
    expect(learnings.length).toBeGreaterThanOrEqual(1)
    expect(learnings[0].type).toBe('terminological')
    expect(learnings[0].confidence).toBe(0.7)
  })

  it('returns nothing for ordinary prose with no learning marker', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'What time is it?' },
    ])
    expect(learnings).toHaveLength(0)
  })

  it('ignores assistant messages even when they contain learning-shaped language', () => {
    const learnings = extractLearnings([
      { role: 'assistant', content: 'Always validate inputs at the boundary.' },
    ])
    expect(learnings).toHaveLength(0)
  })

  it('ignores messages under the 10-character floor', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'No, use X' },
    ])
    expect(learnings).toHaveLength(0)
  })

  it('deduplicates identical statements across messages', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'Always use blue-green deployments for production releases.' },
      { role: 'user', content: 'Always use blue-green deployments for production releases.' },
    ])
    expect(learnings).toHaveLength(1)
  })

  it('extracts learnings from a message that itself quotes a 🧠 I learned: block, without treating the marker line as a learning', () => {
    const learnings = extractLearnings([
      {
        role: 'user',
        content: '🧠 I learned:\n- The API uses snake_case, not camelCase.\n- Always run integration tests before merging.',
      },
    ])
    expect(learnings.length).toBeGreaterThanOrEqual(2)
    for (const l of learnings) {
      expect(l.statement.toLowerCase()).not.toContain('i learned')
      expect(l.type).toBe('behavioral')
    }
  })

  it('handles array-of-blocks content, stripping OpenClaw metadata prefixes', () => {
    const learnings = extractLearnings([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Conversation info (untrusted metadata):\n```\nsome meta\n```\nWe decided to always use pnpm for installs.' },
        ],
      },
    ])
    expect(learnings.length).toBeGreaterThanOrEqual(1)
    expect(learnings.some(l => l.statement.toLowerCase().includes('meta'))).toBe(false)
  })
})
