/**
 * Model: spec/formal/PlurSpec/ScopeInject.lean §5 (`sections_le_budget`,
 * `old_sections_exceed`).
 *
 * The sections (pins, constraints floor, directives, constraints slack) never
 * spend more than the injection budget, whatever `pinned_ratio` is set to.
 * The constraints-floor pass draws only on what the pins left: with a pinned
 * share above 1 − the floor ratio (0.6) the pins and the floor together used
 * to overrun `maxTokens`.
 */
import { describe, it, expect } from 'vitest'
import { selectAndSpread, estimateTokens } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

const base = {
  type: 'behavioral', scope: 'global', status: 'active', version: 2, tags: ['deploy'],
  activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 0, last_accessed: '2026-09-20T10:11:12.000Z' },
}
const pad = (i: number) => String(i).padStart(2, '0')
// Pinned directives (positive polarity) and unpinned constraints (polarity dont).
const corpus = () => [
  ...Array.from({ length: 30 }, (_, i) => EngramSchema.parse({
    ...base, id: `ENG-2026-1101-1${pad(i)}`, pinned: true, polarity: 'do',
    statement: `deploy with the release checklist item ${i} ` + 'p'.repeat(120),
  })),
  ...Array.from({ length: 30 }, (_, i) => EngramSchema.parse({
    ...base, id: `ENG-2026-1101-2${pad(i)}`, polarity: 'dont',
    statement: `never deploy without rule ${i} ` + 'c'.repeat(120),
  })),
]
const total = (r: ReturnType<typeof selectAndSpread>) => r.tokens_used.directives + r.tokens_used.consider
const deliveredCost = (r: ReturnType<typeof selectAndSpread>, all: ReturnType<typeof corpus>) => {
  const byId = new Map(all.map(e => [e.id, e]))
  return [...r.directives, ...r.constraints, ...r.consider]
    .reduce((a, w) => a + estimateTokens(byId.get(w.id)! as never), 0)
}

describe('injection sections stay within the budget for every pinned share', () => {
  it('pinned_ratio 1: pins fill the budget, the constraints floor gets nothing more', () => {
    const all = corpus()
    const r = selectAndSpread({ prompt: 'deploy', maxTokens: 1000 }, all, [], { pinned_ratio: 1 })
    expect(r.tokens_used.directives).toBeLessThanOrEqual(1000)
    expect(total(r)).toBeLessThanOrEqual(1000)
    expect(deliveredCost(r, all)).toBeLessThanOrEqual(1000)
  })

  it('holds across pinned shares and budgets', () => {
    const all = corpus()
    for (const pinned_ratio of [0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
      for (const maxTokens of [0, 50, 200, 500, 1000, 2000, 8000]) {
        const r = selectAndSpread({ prompt: 'deploy', maxTokens }, all, [], { pinned_ratio })
        expect(total(r), `ratio ${pinned_ratio} budget ${maxTokens}`).toBeLessThanOrEqual(maxTokens)
        expect(deliveredCost(r, all), `ratio ${pinned_ratio} budget ${maxTokens}`).toBeLessThanOrEqual(maxTokens)
      }
    }
  })

  it('good case: at the default share, pins and constraints are both delivered', () => {
    const all = corpus()
    const r = selectAndSpread({ prompt: 'deploy', maxTokens: 2000 }, all, [])
    expect(r.directives.some(e => e.id.startsWith('ENG-2026-1101-1'))).toBe(true)
    expect(r.constraints.some(e => e.id.startsWith('ENG-2026-1101-2'))).toBe(true)
    expect(total(r)).toBeLessThanOrEqual(2000)
  })
})
