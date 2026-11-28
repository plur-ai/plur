/**
 * INJ-1 under unified injection: a nearby rule that does not apply is not
 * handed over beside the one that does. A lower-ranked memory that is nearly
 * the same text as one already chosen is skipped when the task's own words
 * point to the chosen one (they name what differs in it) and not to the other.
 * Equally relevant variants, whose differences the task does not mention,
 * are all kept.
 */
import { describe, it, expect } from 'vitest'
import { selectUnified } from '../src/inject-unified.js'
import { EngramSchema, type Engram } from '../src/schemas/engram.js'

const today = new Date().toISOString().slice(0, 10)
const mk = (id: string, statement: string): Engram => EngramSchema.parse({
  id, statement, type: 'behavioral', scope: 'global', status: 'active', version: 2, tags: [],
  activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 0, last_accessed: today },
}) as Engram
const ids = (r: ReturnType<typeof selectUnified>) => [...r.directives, ...r.constraints, ...r.consider].map(e => e.id)
const filler = Array.from({ length: 6 }, (_, i) => mk(`ENG-2026-1101-${String(i + 10).padStart(3, '0')}`, `unrelated note ${i} about the coffee machine on floor ${i}`))

describe('unified injection skips a near-twin the task does not point to', () => {
  it('a summary rule for incidents is not given beside the one for reviews when the task is a review', () => {
    const review = mk('ENG-2026-1101-001', 'At Dovren Toolworks, write review summaries as three bullets followed by one explicit next action.')
    const incident = mk('ENG-2026-1101-002', 'At Dovren Toolworks, write incident summaries as three paragraphs followed by one explicit next action.')
    const r = selectUnified({ prompt: 'Draft a review summary for a completed change and state the next action.', maxTokens: 4000 }, [incident, review, ...filler], [], { recall_limit: 10 })
    expect(ids(r)).toContain(review.id)
    expect(ids(r)).not.toContain(incident.id)
  })

  it('equally relevant variants whose differences the task does not name are all kept', () => {
    const a = mk('ENG-2026-1101-003', 'Deploy the billing service to production with blue-green rollouts and a manual smoke test.')
    const b = mk('ENG-2026-1101-004', 'Deploy the billing service to production behind a feature flag that defaults to off.')
    const c = mk('ENG-2026-1101-005', 'Deploy the billing service to production during the morning window with on-call awake.')
    const r = selectUnified({ prompt: 'deploy the billing service to production', maxTokens: 4000 }, [a, b, c, ...filler], [], { recall_limit: 10 })
    expect(ids(r)).toEqual(expect.arrayContaining([a.id, b.id, c.id]))
  })

  it('when the task names both variants, both are given', () => {
    const review = mk('ENG-2026-1101-006', 'Write review summaries as three bullets followed by one next action.')
    const incident = mk('ENG-2026-1101-007', 'Write incident summaries as three paragraphs followed by one next action.')
    const r = selectUnified({ prompt: 'write the review summary and the incident summary', maxTokens: 4000 }, [review, incident, ...filler], [], { recall_limit: 10 })
    expect(ids(r)).toEqual(expect.arrayContaining([review.id, incident.id]))
  })

  it('memories that are not near-copies are never skipped by this rule', () => {
    const one = mk('ENG-2026-1101-008', 'Review summaries use three bullets.')
    const two = mk('ENG-2026-1101-009', 'A review is closed only after its summary is posted to the team channel by the author.')
    const r = selectUnified({ prompt: 'draft a review summary', maxTokens: 4000 }, [one, two, ...filler], [], { recall_limit: 10 })
    expect(ids(r)).toContain(one.id)
    expect(ids(r)).toContain(two.id)
  })
})
