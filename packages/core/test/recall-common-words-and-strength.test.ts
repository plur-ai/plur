/**
 * Recall's ranking, as unified injection uses it:
 *  - a query word found in every memory of a small store still matches
 *    (its weight is small but never zero), so those memories are found;
 *  - among equally matching memories, the stronger one (after fading) ranks
 *    first; a locked memory does not fade; a weak match is not lifted past a
 *    clearly better one by strength alone.
 */
import { describe, it, expect } from 'vitest'
import { searchEngramsScored } from '../src/fts.js'
import { fuseLegs } from '../src/hybrid-search.js'
import { EngramSchema, type Engram } from '../src/schemas/engram.js'

const DAY = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * DAY - 3_600_000).toISOString()
const mk = (id: string, statement: string, strength = 0.9, daysUnused = 0, extra: Record<string, unknown> = {}): Engram => ({
  ...EngramSchema.parse({
    id, statement, type: 'behavioral', scope: 'global', status: 'active',
    activation: { retrieval_strength: strength, storage_strength: 1, frequency: 0, last_accessed: ago(daysUnused) },
  }),
  ...extra,
}) as Engram

describe('keyword matching: a word in every memory still counts', () => {
  const es = [
    mk('ENG-2026-4001-001', 'Invoices are rounded half-up to two decimals before tax'),
    mk('ENG-2026-4001-002', 'Invoices always state the currency next to every amount'),
    mk('ENG-2026-4001-003', 'Invoices for my side gig go out on the first of the month'),
    mk('ENG-2026-4001-004', 'Invoices above the limit need a second approver from finance'),
  ]
  it('every memory with the shared word is found, the one with a rarer word first', () => {
    const hits = searchEngramsScored(es, 'are invoices rounded, approved and sent', 10).map(h => h.engram.id)
    expect(hits[0]).toBe('ENG-2026-4001-001')
    expect(new Set(hits)).toEqual(new Set(es.map(e => e.id)))
  })
})

describe('fusion: strength breaks ties between equal matches', () => {
  const say = (p: string) => `Deploy the billing service rollout using plan ${p}`
  const rank = (es: Engram[]) => fuseLegs(searchEngramsScored(es, 'deploy the billing service rollout', 10), []).map(f => f.engram.id)

  it('a memory unused for 14 days ranks between fresh ones at 0.55 and 0.45', () => {
    const ids = rank([
      mk('ENG-2026-4002-001', say('alpha'), 1.0, 14),
      mk('ENG-2026-4002-002', say('bravo'), 0.55, 0),
      mk('ENG-2026-4002-003', say('charlie'), 0.45, 0),
    ])
    expect(ids).toEqual(['ENG-2026-4002-002', 'ENG-2026-4002-001', 'ENG-2026-4002-003'])
  })

  it('a locked memory does not fade; its unlocked twin does', () => {
    const ids = rank([
      mk('ENG-2026-4003-001', say('alpha'), 0.7, 60, { commitment: 'locked' }),
      mk('ENG-2026-4003-002', say('bravo'), 0.7, 60, { commitment: 'decided' }),
      mk('ENG-2026-4003-003', say('charlie'), 0.65, 0, { commitment: 'decided' }),
    ])
    expect(ids).toEqual(['ENG-2026-4003-001', 'ENG-2026-4003-003', 'ENG-2026-4003-002'])
  })

  it('strength does not lift a weaker match past a clearly better one', () => {
    const ids = rank([
      mk('ENG-2026-4004-001', 'Deploy the billing service rollout carefully', 0.2, 400),
      mk('ENG-2026-4004-002', 'Billing totals are in cents', 1.0, 0),
    ])
    expect(ids[0]).toBe('ENG-2026-4004-001')
  })
})
