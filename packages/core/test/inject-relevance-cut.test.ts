import { describe, it, expect } from 'vitest'
import { selectAndSpread } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

// A task should be given the rule that applies to it, not also the variant of
// that rule written for a different situation. Before this change the budget
// was filled with anything that cleared a near-zero floor on a score normalised
// to the best match, so "incident summaries use paragraphs" was handed over
// beside "review summaries use bullets" for a task about review summaries.
// With the meaning model available, a candidate that is nearly the same
// statement as a clearly more relevant one is now left out. Memories on other
// parts of the task, equally relevant variants, pinned memories and the
// keyword-only path are unaffected.
describe('injection leaves out a nearby variant of a better match (meaning model available)', () => {
  const make = (overrides: Partial<any>) => EngramSchema.parse({
    type: 'behavioral', status: 'active', scope: 'global', ...overrides,
  })
  const allIds = (result: ReturnType<typeof selectAndSpread>) => [
    ...result.directives.map(e => e.id),
    ...result.constraints.map(e => e.id),
    ...result.consider.map(e => e.id),
  ]
  const TASK = 'write the review summaries for the finished change'
  const needed = () => make({ id: 'ENG-2026-0201-001', statement: 'Write review summaries as three bullets and one next action' })
  const variant = () => make({ id: 'ENG-2026-0201-002', statement: 'Write incident summaries as three paragraphs and one next action' })

  it('the variant of the best match written for another situation is not given', () => {
    const boosts = new Map([['ENG-2026-0201-001', 0.8], ['ENG-2026-0201-002', 0.6]])
    const ids = allIds(selectAndSpread({ prompt: TASK, maxTokens: 5000 }, [needed(), variant()], [], undefined, boosts))
    expect(ids).toContain('ENG-2026-0201-001')
    expect(ids).not.toContain('ENG-2026-0201-002')
  })

  it('two variants about equally relevant are both given', () => {
    const twin = make({ id: 'ENG-2026-0201-003', statement: 'Write review summaries as three bullets and one open question' })
    const boosts = new Map([['ENG-2026-0201-001', 0.8], ['ENG-2026-0201-003', 0.8]])
    const ids = allIds(selectAndSpread({ prompt: TASK, maxTokens: 5000 }, [needed(), twin], [], undefined, boosts))
    expect(ids).toEqual(expect.arrayContaining(['ENG-2026-0201-001', 'ENG-2026-0201-003']))
  })

  it('a much weaker memory about another part of the task is still given', () => {
    const other = make({ id: 'ENG-2026-0201-005', statement: 'Every finished change links its tracking issue' })
    const boosts = new Map([['ENG-2026-0201-001', 0.8], ['ENG-2026-0201-005', 0.1]])
    const ids = allIds(selectAndSpread({ prompt: TASK, maxTokens: 5000 }, [needed(), other], [], undefined, boosts))
    expect(ids).toEqual(expect.arrayContaining(['ENG-2026-0201-001', 'ENG-2026-0201-005']))
  })

  it('a pinned variant is given however weak its match', () => {
    const pinned = make({ id: 'ENG-2026-0201-004', statement: 'Write incident summaries as three paragraphs and one next action', pinned: true })
    const boosts = new Map([['ENG-2026-0201-001', 0.8], ['ENG-2026-0201-004', 0.2]])
    const ids = allIds(selectAndSpread({ prompt: TASK, maxTokens: 5000 }, [needed(), pinned], [], undefined, boosts))
    expect(ids).toEqual(expect.arrayContaining(['ENG-2026-0201-001', 'ENG-2026-0201-004']))
  })

  it('without the meaning model (keyword-only path) selection is unchanged', () => {
    const ids = allIds(selectAndSpread({ prompt: TASK, maxTokens: 5000 }, [needed(), variant()], []))
    expect(ids).toEqual(expect.arrayContaining(['ENG-2026-0201-001', 'ENG-2026-0201-002']))
  })
})
