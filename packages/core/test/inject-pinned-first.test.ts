/**
 * Pinned memories come before anything else within the budget (INJ-6).
 *
 * Pins may use the whole budget; an unpinned memory only gets what the pins
 * leave, and none is given while a pinned memory was left out. Every pin left
 * out is named in `omitted_pinned`.
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

function run(maxTokens: number, pins = PINS) {
  return selectAndSpread(
    { prompt: 'deploy the billing service to production', scope: 'project:alpha', maxTokens },
    [...pins, ...MATCHING],
    [],
  )
}

const givenIds = (r: ReturnType<typeof run>) =>
  [...r.directives, ...r.constraints, ...r.consider].map(e => e.id)

describe('pinned first within the budget (INJ-6)', () => {
  it('gives no unpinned memory while a pinned memory is left out', () => {
    const r = run(150)
    const ids = givenIds(r)
    const left = PINS.filter(p => !ids.includes(p.id)).map(p => p.id)
    expect(left.length, 'precondition: ten pins do not all fit in 150 tokens').toBeGreaterThan(0)
    expect(MATCHING.filter(m => ids.includes(m.id)).map(m => m.id)).toEqual([])
    expect(r.omitted_pinned.map(o => o.id).sort()).toEqual([...left].sort())
  })

  it('lets pins use more than half the budget before any unpinned memory', () => {
    const r = run(150)
    const pinTokens = PINS.filter(p => givenIds(r).includes(p.id)).reduce((a, p) => a + estimateTokens(p as never), 0)
    expect(pinTokens).toBeGreaterThan(75)
    expect(r.tokens_used.directives + r.tokens_used.consider).toBeLessThanOrEqual(150)
  })

  it('gives unpinned memories the room left once every pin fits', () => {
    const r = run(2000)
    const ids = givenIds(r)
    expect(r.omitted_pinned).toEqual([])
    for (const p of PINS) expect(ids).toContain(p.id)
    expect(MATCHING.some(m => ids.includes(m.id))).toBe(true)
  })
})
