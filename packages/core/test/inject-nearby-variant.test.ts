import { describe, it, expect } from 'vitest'
import { selectAndSpread } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

// Nearby-variant suppression (INJ-1) leaves out a candidate that is nearly the
// same statement as a clearly more relevant one. These pin both sides of that
// rule: a near-copy written for another situation goes, and a different rule
// about the same subject stays, even when it is far less relevant than the best
// match. Without the second test, raising the word-overlap threshold's reach
// (or dropping it) would silently thin out distinct memories on one topic.
describe('nearby-variant suppression (INJ-1)', () => {
  const make = (id: string, statement: string) => EngramSchema.parse({
    id, statement, type: 'behavioral', scope: 'global', status: 'active',
  })
  const best = make('ENG-2026-0101-001', 'review summaries for the deploy pipeline list every failing check first')
  const variant = make('ENG-2026-0101-002', 'incident summaries for the deploy pipeline list every failing check first')
  const distinct = make('ENG-2026-0101-003', 'the deploy pipeline needs two approvals before production')
  const prompt = 'write review summaries for the deploy pipeline'

  const given = (boosts: Map<string, number> | undefined) => {
    const r = selectAndSpread({ prompt, maxTokens: 8000 }, [best, variant, distinct], [], undefined, boosts)
    return new Set([...r.directives, ...r.constraints, ...r.consider].map(e => e.id))
  }

  it('leaves out a near-copy of a clearly better match', () => {
    const ids = given(new Map([[best.id, 0.9], [variant.id, 0.3], [distinct.id, 0.3]]))
    expect(ids.has(best.id)).toBe(true)
    expect(ids.has(variant.id)).toBe(false)
  })

  it('keeps a distinct memory on the same subject, though far less relevant than the best match', () => {
    const ids = given(new Map([[best.id, 0.9], [variant.id, 0.3], [distinct.id, 0.05]]))
    expect(ids.has(best.id)).toBe(true)
    expect(ids.has(distinct.id)).toBe(true)
  })

  it('without the meaning model nothing is suppressed', () => {
    const ids = given(undefined)
    expect(ids.has(variant.id)).toBe(true)
    expect(ids.has(distinct.id)).toBe(true)
  })
})
