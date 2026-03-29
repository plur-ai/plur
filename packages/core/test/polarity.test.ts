import { describe, it, expect } from 'vitest'
import { EngramSchema } from '../src/schemas/engram.js'
import { classifyPolarity } from '../src/polarity.js'

describe('EngramSchema polarity field', () => {
  const base = {
    id: 'ENG-2026-0328-001',
    version: 1,
    status: 'active',
    type: 'behavioral',
    scope: 'global',
    statement: 'Test statement',
    activation: { retrieval_strength: 0.5, storage_strength: 0.5, frequency: 1, last_accessed: '2026-03-28' },
    tags: [],
  }

  it('accepts polarity: "do" or "dont"', () => {
    expect(EngramSchema.parse({ ...base, polarity: 'do' }).polarity).toBe('do')
    expect(EngramSchema.parse({ ...base, polarity: 'dont' }).polarity).toBe('dont')
  })

  it('defaults polarity to null when omitted', () => {
    expect(EngramSchema.parse(base).polarity).toBeNull()
  })

  it('rejects invalid polarity values', () => {
    expect(() => EngramSchema.parse({ ...base, polarity: 'maybe' })).toThrow()
  })
})

describe('classifyPolarity', () => {
  it('classifies "never" statements as dont', () => {
    expect(classifyPolarity('Never run concurrent apt/dpkg operations')).toBe('dont')
  })

  it('classifies "do not" statements as dont', () => {
    expect(classifyPolarity('Do not use MCP tools when local knowledge suffices')).toBe('dont')
  })

  it('classifies "avoid" statements as dont', () => {
    expect(classifyPolarity('Avoid backwards-compatibility hacks like renaming unused vars')).toBe('dont')
  })

  it('classifies "NOT" with action verb as dont', () => {
    expect(classifyPolarity('Do NOT include Fairnode in Verity epics or roadmaps')).toBe('dont')
  })

  it('classifies "must not" as dont', () => {
    expect(classifyPolarity('Agents must not modify existing contacts without approval')).toBe('dont')
  })

  it('returns null for positive/imperative statements', () => {
    expect(classifyPolarity('Always verify features exist before including in plans')).toBeNull()
    expect(classifyPolarity('Use BM25 + embedding hybrid search for retrieval')).toBeNull()
  })

  it('returns null for descriptive statements', () => {
    expect(classifyPolarity('Engrams have four type values')).toBeNull()
    expect(classifyPolarity('The API uses snake_case')).toBeNull()
  })

  it('handles empty or very short statements', () => {
    expect(classifyPolarity('')).toBeNull()
    expect(classifyPolarity('Hi')).toBeNull()
  })
})
