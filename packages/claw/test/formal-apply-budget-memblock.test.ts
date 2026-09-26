/**
 * Apply phase of the formal-verification run (owner decision I2 drop), claw
 * side: assembleContext renders its memory block through core's
 * renderMemoryBlock, so the drop-sections-that-do-not-fit rule holds here too
 * and claw's output stays identical to core's. Imports core's built dist
 * (`pnpm --filter @plur-ai/core build` first).
 */
import { describe, it, expect } from 'vitest'
import { renderMemoryBlock, PLUR_MEMORY_INSTRUCTIONS } from '@plur-ai/core'
import { assembleContext } from '../src/assembler.js'

const tok = (s: string) => Math.ceil(s.length / 4)
const INSTR = tok(PLUR_MEMORY_INSTRUCTIONS)
const section = (label: string, tokens: number) => `[${label}] ` + 'x'.repeat(tokens * 4 - label.length - 3)
const inj = (d: string, c: string, k: string) =>
  ({ count: 3, directives: d, constraints: c, consider: k, text: '', injected_ids: [] }) as any

describe('I2 — claw memory block drops sections that do not fit', () => {
  it('replayed case: 5000-token sections are dropped, the addition stays within budget', () => {
    const messages = [{ role: 'user', content: 'x'.repeat(400) }] as any
    const tokenBudget = 100 + INSTR + 60
    const r = assembleContext({
      messages,
      injection: inj(section('D', 5000), section('C', 5000), section('K', 5000)),
      tokenBudget,
    })
    expect(r.systemPromptAddition).not.toContain('[D]')
    expect(r.estimatedTokens).toBeLessThanOrEqual(tokenBudget + 40) // + an optional update notice
  })

  it('claw renders exactly what core renders (identical behaviour)', () => {
    const messages = [{ role: 'user', content: 'y'.repeat(800) }] as any
    const injection = inj(section('D', 100), section('C', 2000), section('K', 200))
    const tokenBudget = 200 + INSTR + 600
    const r = assembleContext({ messages, injection, tokenBudget })
    const core = renderMemoryBlock({ injection, tokenBudget, usedTokens: 200 })
    expect(r.systemPromptAddition!.startsWith(core)).toBe(true)
    expect(core).toContain('[D]')
    expect(core).not.toContain('[C]')
    expect(core).toContain('[K]')
  })
})
