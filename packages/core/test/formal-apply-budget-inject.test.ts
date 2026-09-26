/**
 * Apply phase of the formal-verification run (owner decision I1 cap-sum).
 * Model: spec/formal/PlurSpec/ScopeInject.lean §5 (`total_le_budget`).
 *
 * The total injection (directives + constraints + consider + spread) never
 * exceeds the injection budget (`maxTokens`). Directives and constraints keep
 * priority; the consider pool, then spreading activation, shrink to what is
 * left. `tokens_used` (directives + consider) is the total and is ≤ the budget.
 * Replayed pre-fix: 40 matching + 40 associated engrams at maxTokens 500 →
 * tokens_used 448 + 375 = 823.
 */
import { describe, it, expect } from 'vitest'
import { selectAndSpread, estimateTokens } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

const base = {
  type: 'behavioral', scope: 'global', status: 'active', version: 2, tags: ['deploy'],
  activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 0, last_accessed: '2026-09-20T10:11:12.000Z' },
}
const pad = (i: number) => String(i).padStart(2, '0')
const corpus = (n: number) => {
  const many = Array.from({ length: n }, (_, i) => EngramSchema.parse({
    ...base, id: `ENG-2026-0920-3${pad(i)}`, statement: `deploy rule number ${i} ` + 'x'.repeat(150),
    associations: [{ target_type: 'engram', target: `ENG-2026-0920-4${pad(i)}`, type: 'semantic', strength: 0.9 }],
  }))
  const assoc = Array.from({ length: n }, (_, i) => EngramSchema.parse({
    ...base, tags: [], id: `ENG-2026-0920-4${pad(i)}`, statement: 'associated ' + 'y'.repeat(150),
  }))
  return [...many, ...assoc]
}
const total = (r: ReturnType<typeof selectAndSpread>) => r.tokens_used.directives + r.tokens_used.consider
const deliveredCost = (r: ReturnType<typeof selectAndSpread>, all: ReturnType<typeof corpus>) => {
  const byId = new Map(all.map(e => [e.id, e]))
  return [...r.directives, ...r.constraints, ...r.consider]
    .reduce((a, w) => a + estimateTokens(byId.get(w.id)! as never), 0)
}

describe('I1 — the injection total never exceeds the budget', () => {
  it('replayed case: maxTokens 500 → total ≤ 500', () => {
    const all = corpus(40)
    const r = selectAndSpread({ prompt: 'deploy', maxTokens: 500 }, all, [])
    expect(total(r)).toBeLessThanOrEqual(500)
    expect(deliveredCost(r, all)).toBeLessThanOrEqual(500)
    expect(deliveredCost(r, all)).toBe(total(r))
  })

  it('holds across budgets, including tiny ones', () => {
    const all = corpus(40)
    for (const maxTokens of [0, 20, 60, 100, 250, 500, 700, 1000, 1500, 3000]) {
      const r = selectAndSpread({ prompt: 'deploy', maxTokens }, all, [])
      expect(total(r)).toBeLessThanOrEqual(maxTokens)
      expect(deliveredCost(r, all)).toBeLessThanOrEqual(maxTokens)
    }
  })

  it('directives keep priority: the directive tokens are what the sections selected', () => {
    const all = corpus(40)
    const r = selectAndSpread({ prompt: 'deploy', maxTokens: 500 }, all, [])
    expect(r.tokens_used.directives).toBeGreaterThan(0)
    expect(r.tokens_used.consider).toBeLessThanOrEqual(500 - r.tokens_used.directives)
  })

  it('good case: with room left, consider and spreading still deliver', () => {
    const all = corpus(8)
    const r = selectAndSpread({ prompt: 'deploy', maxTokens: 5000 }, all, [])
    const ids = r.consider.map(e => e.id)
    expect(ids.some(id => id.startsWith('ENG-2026-0920-4'))).toBe(true) // spread
    expect(total(r)).toBeLessThanOrEqual(5000)
  })
})
