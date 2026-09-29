/**
 * #1310 — automatic rating of injected engrams from the assistant's reply.
 *
 * One TypeScript implementation of the heuristic plur-hermes has run in
 * Python since #1086, so every editor hook rates the same way. The negative
 * rule is deliberately tighter than the Python one: the old ±100–200 character
 * window around a correction word marked unrelated engrams negative whenever
 * the reply corrected ANYTHING near a shared word. Here the correction word
 * and the engram's distinctive words must sit in the same sentence.
 */
import { describe, it, expect } from 'vitest'
import {
  detectInjectionSignal,
  rateInjectedEngrams,
  AUTO_FEEDBACK_MIN_CONFIDENCE,
} from '../src/injection-signal.js'

const STATEMENT = 'Run the migration script before deploying the billing service'

describe('detectInjectionSignal — positive rules', () => {
  it('exact statement in the reply is positive with high confidence', () => {
    const reply = `Per your notes: ${STATEMENT}. I did that first.`
    const r = detectInjectionSignal(STATEMENT, reply)
    expect(r.signal).toBe('positive')
    expect(r.confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('exact match ignores case and whitespace differences', () => {
    const reply = 'Reminder:  run the migration script\nbefore deploying the billing service.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBe('positive')
  })

  it('high trigram overlap (paraphrase with most phrases intact) is positive', () => {
    // One word changed at the end: most trigrams survive, the exact match fails.
    const reply = 'I will run the migration script before deploying the billing services today.'
    const r = detectInjectionSignal(STATEMENT, reply)
    expect(r.signal).toBe('positive')
    expect(r.confidence).toBeGreaterThanOrEqual(AUTO_FEEDBACK_MIN_CONFIDENCE)
    expect(r.confidence).toBeLessThan(0.95)
  })

  it('low trigram overlap is not positive', () => {
    const reply = 'The billing service deployed fine, and the migration can wait.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBeNull()
  })

  it('an empty statement or reply yields nothing', () => {
    expect(detectInjectionSignal('', 'anything').signal).toBeNull()
    expect(detectInjectionSignal(STATEMENT, '').signal).toBeNull()
  })
})

describe('detectInjectionSignal — negative rule (same sentence)', () => {
  it('a correction word in the same sentence as the engram words is negative', () => {
    const reply = 'Actually, the migration script is not needed before deploying billing anymore.'
    const r = detectInjectionSignal(STATEMENT, reply)
    expect(r.signal).toBe('negative')
    expect(r.confidence).toBeGreaterThanOrEqual(AUTO_FEEDBACK_MIN_CONFIDENCE)
  })

  it('a correction in a DIFFERENT sentence does not mark the engram negative', () => {
    // Within 100 characters of the engram words — the old window rule fired here.
    const reply =
      'I ran the migration script and deployed billing. ' +
      'Actually, the CSS bug you mentioned was in the header.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBeNull()
  })

  it('one shared common word next to a correction is not enough', () => {
    // "service" is the only overlap; one word does not make it about this engram.
    const reply = 'No, the email service was down, not the queue.'
    expect(detectInjectionSignal(STATEMENT, reply).signal).toBeNull()
  })

  it('a correction word alone, with none of the engram words, is nothing', () => {
    expect(detectInjectionSignal(STATEMENT, 'That is wrong, sorry.').signal).toBeNull()
  })
})

describe('rateInjectedEngrams', () => {
  it('returns only signals at or above the 0.6 threshold', () => {
    expect(AUTO_FEEDBACK_MIN_CONFIDENCE).toBe(0.6)
    const out = rateInjectedEngrams(
      [
        { id: 'ENG-A', statement: STATEMENT },
        { id: 'ENG-B', statement: 'Prefer tabs over spaces in the legacy parser' },
      ],
      `Following memory: ${STATEMENT}.`,
    )
    expect(out).toEqual([{ id: 'ENG-A', signal: 'positive', confidence: 0.95 }])
  })

  it('skips engrams with no statement', () => {
    expect(rateInjectedEngrams([{ id: 'ENG-A', statement: '' }], 'text')).toEqual([])
  })
})
