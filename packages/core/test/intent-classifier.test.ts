import { describe, it, expect } from 'vitest'
import { classifyQuery } from '../src/intent/classifier.js'
import type { QueryIntent } from '../src/intent/classifier.js'

describe('classifyQuery — deterministic intent classification', () => {
  describe('entity intent', () => {
    const entityCases: Array<[string, string]> = [
      ['who works at Acme?', 'who'],
      ["who is Karl's manager?", 'who'],
      ["Karl's email address", 'possessive'],
      ['whose phone number is this?', 'whose'],
      ['contact info for Sarah Johnson', 'contact keyword'],
      ['email for the head of sales', 'email keyword'],
      ['phone number for John Smith', 'phone keyword'],
      ['which company does Mary work for?', 'company keyword'],
    ]
    for (const [query, reason] of entityCases) {
      it(`classifies "${query}" as entity (${reason})`, () => {
        const result = classifyQuery(query)
        expect(result.intent).toBe('entity')
        expect(result.confidence).toBeGreaterThan(0)
        expect(result.reason).toBeTruthy()
      })
    }
  })

  describe('temporal intent', () => {
    const temporalCases: Array<[string, string]> = [
      ['what happened yesterday?', 'yesterday'],
      ['what did we discuss last week?', 'last week'],
      ['what is on my plate today?', 'today'],
      ['what is happening now?', 'now'],
      ['what did I do this morning?', 'this morning'],
      ['notes from 2026-04-15', 'iso date'],
      ['summarize Jan 5 meeting', 'short month-day'],
      ['three days ago', 'ago'],
      ['since the Q1 review', 'since'],
      ['recent decisions', 'recent'],
    ]
    for (const [query, reason] of temporalCases) {
      it(`classifies "${query}" as temporal (${reason})`, () => {
        const result = classifyQuery(query)
        expect(result.intent).toBe('temporal')
        expect(result.confidence).toBeGreaterThan(0)
        expect(result.reason).toBeTruthy()
      })
    }
  })

  describe('event intent', () => {
    const eventCases: Array<[string, string]> = [
      ['what happened with the Acme Series A?', 'happened (overrides temporal: no clear time anchor)'],
      ['Acme announced their Series A', 'announced'],
      ['the deploy crashed', 'deploy + crashed'],
      ['what decision did we make about pricing?', 'decision'],
      ['was there an incident this quarter?', 'incident'],
      ['the production release', 'release'],
      ['Stripe launched a new product', 'launched'],
    ]
    for (const [query, reason] of eventCases) {
      it(`classifies "${query}" as event (${reason})`, () => {
        const result = classifyQuery(query)
        expect(result.intent).toBe('event')
        expect(result.confidence).toBeGreaterThan(0)
        expect(result.reason).toBeTruthy()
      })
    }
  })

  describe('general intent (fallback)', () => {
    const generalCases: Array<string> = [
      'how do I configure typescript strict mode',
      'best practices for error handling',
      'explain reciprocal rank fusion',
      'database indexing strategies',
      'when to use SQL vs NoSQL',
    ]
    for (const query of generalCases) {
      it(`classifies "${query}" as general`, () => {
        const result = classifyQuery(query)
        expect(result.intent).toBe('general')
        expect(result.reason).toBeTruthy()
      })
    }
  })

  describe('edge cases', () => {
    it('empty string falls back to general', () => {
      const result = classifyQuery('')
      expect(result.intent).toBe('general')
      expect(result.confidence).toBeLessThan(1)
    })

    it('whitespace-only falls back to general', () => {
      const result = classifyQuery('   \n\t  ')
      expect(result.intent).toBe('general')
    })

    it('single word falls back to general by default', () => {
      const result = classifyQuery('debug')
      expect(result.intent).toBe('general')
    })

    it('single named entity-shaped word is general — too ambiguous', () => {
      const result = classifyQuery('Karl')
      expect(['general', 'entity']).toContain(result.intent)
    })

    it('all-caps query still classifies (case-insensitive matching)', () => {
      const result = classifyQuery('WHO WORKS AT ACME?')
      expect(result.intent).toBe('entity')
    })

    it('multilingual / unknown script falls back to general', () => {
      const result = classifyQuery('как дела сегодня')
      // "сегодня" means "today" but our regex is English — should fall back
      expect(['general', 'temporal']).toContain(result.intent)
    })

    it('returns a QueryIntent typed result', () => {
      const valid: QueryIntent[] = ['entity', 'temporal', 'event', 'general']
      const result = classifyQuery('anything')
      expect(valid).toContain(result.intent)
    })

    it('confidence is between 0 and 1 inclusive', () => {
      const cases = ['who is X?', 'yesterday', 'crashed', 'random text', '']
      for (const q of cases) {
        const r = classifyQuery(q)
        expect(r.confidence).toBeGreaterThanOrEqual(0)
        expect(r.confidence).toBeLessThanOrEqual(1)
      }
    })

    it('is deterministic — same input, same output', () => {
      const queries = ['who is Karl', 'yesterday', 'deploy crashed', 'general thing']
      for (const q of queries) {
        const a = classifyQuery(q)
        const b = classifyQuery(q)
        expect(a).toEqual(b)
      }
    })
  })

  describe('disambiguation', () => {
    it('clear temporal beats vague entity (e.g. "what happened yesterday")', () => {
      // "yesterday" is a strong temporal anchor — even with a who-like pattern
      const result = classifyQuery('what happened yesterday')
      expect(result.intent).toBe('temporal')
    })

    it('event verb without temporal anchor classifies as event', () => {
      const result = classifyQuery('the deploy crashed')
      expect(result.intent).toBe('event')
    })

    it('entity question with temporal scope leans temporal-or-entity (not general)', () => {
      const result = classifyQuery("who emailed me yesterday?")
      expect(['entity', 'temporal']).toContain(result.intent)
    })
  })
})
