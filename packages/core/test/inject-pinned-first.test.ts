/**
 * Pinned memories come first, up to their share of the budget (INJ-6, owner
 * decision 2026-10-19).
 *
 * Pins are given first, capped at `injection.pinned_ratio` of the budget
 * (default half), so the memories matching the task still get room. Every pin
 * left out is named in `omitted_pinned`, and is not given through the consider
 * pool either.
 */
import { describe, it, expect } from 'vitest'
import { selectAndSpread, estimateTokens } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

function engram(id: string, statement: string, pinned: boolean) {
  return {
    ...EngramSchema.parse({ id, statement, type: 'behavioral', scope: 'project:alpha', status: 'active' }),
    ...(pinned ? { pinned: true } : {}),
  }
}

const PINS = Array.from({ length: 10 }, (_, i) =>
  engram(`ENG-2026-01-01-${String(i + 1).padStart(3, '0')}`, `Always follow office rule number ${i + 1} about plants and rooms`, true))
const MATCHING = Array.from({ length: 6 }, (_, i) =>
  engram(`ENG-2026-01-02-${String(i + 1).padStart(3, '0')}`, `Deploy the billing service to production in step ${i + 1}`, false))

function run(maxTokens: number, pins = PINS, config?: { pinned_ratio?: number }) {
  return selectAndSpread(
    { prompt: 'deploy the billing service to production', scope: 'project:alpha', maxTokens },
    [...pins, ...MATCHING],
    [],
    config,
  )
}

const givenIds = (r: ReturnType<typeof run>) =>
  [...r.directives, ...r.constraints, ...r.consider].map(e => e.id)

describe('pinned first, up to their share (INJ-6)', () => {
  it('gives pins first within their share, then the matching memories, and names every pin left out', () => {
    const r = run(150)
    const ids = givenIds(r)
    const left = PINS.filter(p => !ids.includes(p.id)).map(p => p.id)
    expect(left.length, 'precondition: ten pins do not all fit in 150 tokens').toBeGreaterThan(0)
    const pinIdx = PINS.filter(p => ids.includes(p.id)).map(p => ids.indexOf(p.id))
    const matchIdx = MATCHING.filter(m => ids.includes(m.id)).map(m => ids.indexOf(m.id))
    expect(pinIdx.length).toBeGreaterThan(0)
    expect(matchIdx.length, 'the task still gets room').toBeGreaterThan(0)
    expect(Math.max(...pinIdx)).toBeLessThan(Math.min(...matchIdx))
    expect(r.omitted_pinned.map(o => o.id).sort()).toEqual([...left].sort())
  })

  it('caps pins at their share of the budget (default half, injection.pinned_ratio)', () => {
    const pinTokens = (r: ReturnType<typeof run>) =>
      PINS.filter(p => givenIds(r).includes(p.id)).reduce((a, p) => a + estimateTokens(p as never), 0)
    const half = run(150)
    expect(pinTokens(half)).toBeLessThanOrEqual(75)
    expect(half.tokens_used.directives + half.tokens_used.consider).toBeLessThanOrEqual(150)
    const more = run(150, PINS, { pinned_ratio: 0.8 })
    expect(pinTokens(more)).toBeLessThanOrEqual(120)
    expect(pinTokens(more)).toBeGreaterThan(pinTokens(half))
  })

  it('gives unpinned memories the room left once every pin fits', () => {
    const r = run(2000)
    const ids = givenIds(r)
    expect(r.omitted_pinned).toEqual([])
    for (const p of PINS) expect(ids).toContain(p.id)
    expect(MATCHING.some(m => ids.includes(m.id))).toBe(true)
  })
})
