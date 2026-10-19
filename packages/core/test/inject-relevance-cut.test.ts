import { describe, it, expect } from 'vitest'
import { selectAndSpread } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

// A task should be given the memories that apply to it, not every memory that
// shares a word with it. Before this cut the budget was filled with anything
// that cleared a near-zero floor on a score normalised to the best match, so a
// nearby rule for a different situation ("incident summaries" for a task about
// review summaries) was handed over beside the one that applies. With the
// meaning model available, a candidate must now be at least a fixed share as
// relevant as the best match; pinned memories stay exempt, and the keyword-only
// path is unchanged.
describe('injection keeps candidates close to the best match (meaning model available)', () => {
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
  const neighbour = () => make({ id: 'ENG-2026-0201-002', statement: 'Incident summaries use three paragraphs and a timeline' })

  it('a nearby memory far less relevant than the best match is not given', () => {
    const boosts = new Map([['ENG-2026-0201-001', 0.8], ['ENG-2026-0201-002', 0.6]])
    const ids = allIds(selectAndSpread({ prompt: TASK, maxTokens: 5000 }, [needed(), neighbour()], [], undefined, boosts))
    expect(ids).toContain('ENG-2026-0201-001')
    expect(ids).not.toContain('ENG-2026-0201-002')
  })

  it('two memories about equally relevant are both given', () => {
    const twin = make({ id: 'ENG-2026-0201-003', statement: 'Write review summaries in plain words and one next action' })
    const boosts = new Map([['ENG-2026-0201-001', 0.8], ['ENG-2026-0201-003', 0.78]])
    const ids = allIds(selectAndSpread({ prompt: TASK, maxTokens: 5000 }, [needed(), twin], [], undefined, boosts))
    expect(ids).toEqual(expect.arrayContaining(['ENG-2026-0201-001', 'ENG-2026-0201-003']))
  })

  it('a pinned memory is given however weak its match', () => {
    const pinned = make({ id: 'ENG-2026-0201-004', statement: 'Never name a customer in public text', pinned: true })
    const boosts = new Map([['ENG-2026-0201-001', 0.8], ['ENG-2026-0201-004', 0.2]])
    const ids = allIds(selectAndSpread({ prompt: TASK, maxTokens: 5000 }, [needed(), pinned], [], undefined, boosts))
    expect(ids).toEqual(expect.arrayContaining(['ENG-2026-0201-001', 'ENG-2026-0201-004']))
  })

  it('without the meaning model (keyword-only path) selection is unchanged', () => {
    const ids = allIds(selectAndSpread({ prompt: TASK, maxTokens: 5000 }, [needed(), neighbour()], []))
    expect(ids).toEqual(expect.arrayContaining(['ENG-2026-0201-001', 'ENG-2026-0201-002']))
  })

  it('a semantic-only match far weaker than a keyword-and-meaning match is not given', () => {
    const unrelated = make({ id: 'ENG-2026-0201-005', statement: 'Keep proposal estimates in an appendix' })
    const boosts = new Map([['ENG-2026-0201-001', 0.8], ['ENG-2026-0201-005', 0.7]])
    const ids = allIds(selectAndSpread({ prompt: TASK, maxTokens: 5000 }, [needed(), unrelated], [], undefined, boosts))
    expect(ids).toContain('ENG-2026-0201-001')
    expect(ids).not.toContain('ENG-2026-0201-005')
  })
})
