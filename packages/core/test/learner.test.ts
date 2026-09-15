import { describe, it, expect } from 'vitest'
import { extractLearnings, extractSelfReportedLearnings } from '../src/learner.js'

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

describe('extractSelfReportedLearnings', () => {
  it('extracts bullet points from a well-formed 🧠 I learned: block', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: 'Here is my response.\n\n---\n🧠 I learned:\n- The deploy script needs sudo access.\n- Tests must run before merging.',
    })
    expect(statements).toEqual([
      'The deploy script needs sudo access.',
      'Tests must run before merging.',
    ])
  })

  it('returns an empty array when there is no self-report marker', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: 'Just a normal response with no learning block.',
    })
    expect(statements).toEqual([])
  })

  it('strips -, •, and * bullet markers and trims whitespace', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: '---\n🧠 I learned:\n* First lesson learned here.\n• Second lesson learned here.\n-   Third lesson learned here.',
    })
    expect(statements).toEqual([
      'First lesson learned here.',
      'Second lesson learned here.',
      'Third lesson learned here.',
    ])
  })

  it('filters out lines under the 10-character floor', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: '---\n🧠 I learned:\n- ok\n- This one is definitely long enough to keep.',
    })
    expect(statements).toEqual(['This one is definitely long enough to keep.'])
  })

  it('handles array-of-blocks content the same as string content', () => {
    const statements = extractSelfReportedLearnings({
      role: 'assistant',
      content: [
        { type: 'text', text: '---\n🧠 I learned:\n- Something learned from array blocks.' },
      ],
    })
    expect(statements).toEqual(['Something learned from array blocks.'])
  })

  it('does not filter by role — the caller decides which message to pass', () => {
    const statements = extractSelfReportedLearnings({
      role: 'user',
      content: '---\n🧠 I learned:\n- Role filtering happens at the call site.',
    })
    expect(statements).toEqual(['Role filtering happens at the call site.'])
  })
})
