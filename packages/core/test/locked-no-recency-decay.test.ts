/**
 * A locked memory does not fade with disuse: injection ranks it at its own
 * stored strength however long it has gone unused. Confidence decay already
 * exempted locked memories (decay.ts confidenceDecay); the recency decay in
 * scoreEngram did not, so a locked 0.7 left unused for 60 days ranked behind a
 * fresh 0.65. An unlocked memory still fades.
 */
import { describe, it, expect } from 'vitest'
import { scoreEngram, selectAndSpread } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

const DAY_MS = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY_MS - 3_600_000).toISOString()

const mk = (id: string, statement: string, strength: number, daysUnused: number, commitment?: string) =>
  EngramSchema.parse({
    id, statement, type: 'behavioral', scope: 'global', status: 'active', version: 2, tags: [],
    ...(commitment ? { commitment } : {}),
    ...(commitment === 'locked' ? { locked_reason: 'test', locked_at: '2025-01-01T00:00:00.000Z' } : {}),
    temporal: { learned_at: '2025-01-01T00:00:00.000Z' },
    activation: { retrieval_strength: strength, storage_strength: 1, frequency: 0, last_accessed: ago(daysUnused) },
  })

const PROMPT = 'deploy the billing service rollout'
const words = new Set(PROMPT.split(/\W+/).filter(w => w.length > 2))
const score = (e: ReturnType<typeof mk>) => scoreEngram(e as never, PROMPT, words, [], undefined, false)

describe('a locked memory keeps its rank with disuse', () => {
  it('a locked memory unused for 60 days scores like the same memory used today', () => {
    const stale = mk('ENG-2026-1019-001', 'Deploy the billing service rollout using plan alpha', 0.7, 60, 'locked')
    const fresh = mk('ENG-2026-1019-002', 'Deploy the billing service rollout using plan alpha', 0.7, 0, 'locked')
    expect(score(stale)).toBeCloseTo(score(fresh), 10)
  })

  it('an unlocked memory unused for 60 days still fades', () => {
    const stale = mk('ENG-2026-1019-003', 'Deploy the billing service rollout using plan bravo', 0.7, 60, 'decided')
    const fresh = mk('ENG-2026-1019-004', 'Deploy the billing service rollout using plan bravo', 0.7, 0, 'decided')
    expect(score(stale)).toBeLessThan(score(fresh))
  })

  it('injection orders a stale locked 0.7 ahead of a fresh 0.65, and a stale unlocked 0.7 behind it', () => {
    const locked = mk('ENG-2026-1019-005', 'Deploy the billing service rollout using plan alpha', 0.7, 60, 'locked')
    const unlocked = mk('ENG-2026-1019-006', 'Deploy the billing service rollout using plan bravo', 0.7, 60, 'decided')
    const fresh = mk('ENG-2026-1019-007', 'Deploy the billing service rollout using plan charlie', 0.65, 0, 'decided')
    const r = selectAndSpread({ prompt: PROMPT }, [unlocked, fresh, locked] as never, [])
    const order = [...r.directives, ...r.constraints, ...r.consider].map(e => e.id)
    expect(order).toEqual(expect.arrayContaining([locked.id, unlocked.id, fresh.id]))
    expect(order.indexOf(locked.id)).toBeLessThan(order.indexOf(fresh.id))
    expect(order.indexOf(unlocked.id)).toBeGreaterThan(order.indexOf(fresh.id))
  })
})
