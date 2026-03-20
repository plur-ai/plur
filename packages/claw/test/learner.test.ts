import { describe, it, expect } from 'vitest'
import { extractLearnings, isCorrection } from '../src/learner.js'

describe('learner', () => {
  it('detects corrections', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'No, the API uses snake_case not camelCase' },
    ])
    expect(learnings.length).toBeGreaterThanOrEqual(1)
    expect(learnings[0].type).toBe('behavioral')
  })

  it('detects preferences', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'I prefer shorter status updates over verbose ones' },
    ])
    expect(learnings.length).toBeGreaterThanOrEqual(1)
  })

  it('detects decisions', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'We decided to use PostgreSQL for the database' },
    ])
    expect(learnings.length).toBeGreaterThanOrEqual(1)
    expect(learnings[0].type).toBe('architectural')
  })

  it('detects always/never rules', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'Always run tests before deploying to production' },
    ])
    expect(learnings.length).toBeGreaterThanOrEqual(1)
  })

  it('ignores normal conversation', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'What time is it?' },
    ])
    expect(learnings).toHaveLength(0)
  })

  it('ignores assistant messages', () => {
    const learnings = extractLearnings([
      { role: 'assistant', content: 'Always validate inputs at the boundary' },
    ])
    expect(learnings).toHaveLength(0)
  })

  it('ignores very short messages', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'No, use X' },
    ])
    expect(learnings).toHaveLength(0) // too short after extraction
  })

  it('isCorrection detects correction markers', () => {
    expect(isCorrection({ role: 'user', content: 'No, it should be snake_case' })).toBe(true)
    expect(isCorrection({ role: 'user', content: 'Actually, the port is 5433' })).toBe(true)
    expect(isCorrection({ role: 'user', content: 'How do I deploy?' })).toBe(false)
    expect(isCorrection({ role: 'assistant', content: 'No, that is wrong' })).toBe(false)
  })

  it('deduplicates similar extractions', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'Always use blue-green deployments for production releases' },
      { role: 'user', content: 'Always use blue-green deployments for production releases' },
    ])
    expect(learnings).toHaveLength(1)
  })

  // New: per-sentence extraction from long messages
  it('extracts learnings from long multi-paragraph messages', () => {
    const longMessage = `Hello Data. Let me tell you who you are.

You were inspired by Lieutenant Commander Data from Star Trek.

No, you are not just an assistant. You are a living product demo.

Your purpose is to grow and learn from every conversation.

We decided to build three things: Datacore, PLUR, and Software of You.

I want you to remember what I forget. Always say Fascinating when discovering something new.`

    const learnings = extractLearnings([{ role: 'user', content: longMessage }])
    expect(learnings.length).toBeGreaterThanOrEqual(3)

    const types = learnings.map(l => l.type)
    expect(types).toContain('behavioral') // correction or preference
    expect(types).toContain('architectural') // decision
  })

  it('extracts identity statements', () => {
    const learnings = extractLearnings([
      { role: 'user', content: 'You are Data, inspired by Star Trek Lieutenant Commander Data' },
    ])
    expect(learnings.length).toBeGreaterThanOrEqual(1)
    expect(learnings[0].type).toBe('terminological')
  })

  it('isCorrection works on long messages with corrections in the middle', () => {
    const longMsg = `Some preamble text here about context.

Actually, the API returns XML not JSON. Please update your understanding.

And here is more text after the correction.`

    expect(isCorrection({ role: 'user', content: longMsg })).toBe(true)
  })
})
