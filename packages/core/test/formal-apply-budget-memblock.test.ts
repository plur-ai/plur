/**
 * Apply phase of the formal-verification run (owner decision I2 drop).
 * Model: spec/formal/PlurSpec/ScopeInject.lean §5 (`memBlockNew`).
 *
 * renderMemoryBlock drops any section (directives, constraints, consider) that
 * does not fit the remaining budget — the whole section. With a token budget,
 * the rendered block never exceeds `tokenBudget - usedTokens` once the fixed
 * instructions fit. Replayed pre-fix: budget 499, three 5000-token sections →
 * 5469 tokens rendered.
 */
import { describe, it, expect } from 'vitest'
import { renderMemoryBlock, PLUR_MEMORY_INSTRUCTIONS } from '../src/memory-block.js'

const tok = (s: string) => Math.ceil(s.length / 4)
const INSTR = tok(PLUR_MEMORY_INSTRUCTIONS)
const section = (label: string, tokens: number) => `[${label}] ` + 'x'.repeat(tokens * 4 - label.length - 3)
const inj = (d: string, c: string, k: string) =>
  ({ count: 3, directives: d, constraints: c, consider: k, text: '' }) as any

describe('I2 — renderMemoryBlock drops sections that do not fit', () => {
  it('replayed case: three 5000-token sections at budget 499 render within budget', () => {
    const out = renderMemoryBlock({
      injection: inj(section('D', 5000), section('C', 5000), section('K', 5000)),
      tokenBudget: INSTR + 50,
    })
    expect(tok(out)).toBeLessThanOrEqual(INSTR + 50)
    expect(out).not.toContain('[D]')
  })

  it('a section that does not fit is dropped whole; a later one that fits is kept', () => {
    const budget = INSTR + 600
    const out = renderMemoryBlock({
      injection: inj(section('D', 100), section('C', 2000), section('K', 200)),
      tokenBudget: budget,
    })
    expect(out).toContain(section('D', 100))
    expect(out).not.toContain('[C]')
    expect(out).toContain(section('K', 200))
    expect(tok(out)).toBeLessThanOrEqual(budget)
  })

  it('usedTokens is charged: the whole output stays within tokenBudget - usedTokens', () => {
    for (const used of [0, 50, 200, 400]) {
      const budget = INSTR + 500
      const out = renderMemoryBlock({
        injection: inj(section('D', 150), section('C', 150), section('K', 150)),
        tokenBudget: budget,
        usedTokens: used,
      })
      expect(tok(out)).toBeLessThanOrEqual(budget - used)
    }
  })

  it('good case: no budget renders every section; a roomy budget renders the same', () => {
    const i = inj(section('D', 100), section('C', 100), section('K', 100))
    const unbounded = renderMemoryBlock({ injection: i })
    const roomy = renderMemoryBlock({ injection: i, tokenBudget: 100000 })
    expect(unbounded).toContain('[D]')
    expect(unbounded).toContain('[C]')
    expect(unbounded).toContain('[K]')
    expect(roomy).toBe(unbounded)
  })
})
