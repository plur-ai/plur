// Proof that LRN-7's outcome classification reads the store, not the reported
// decision. Not a promise eval: a scripted checker, the bag-of-words embedder,
// no model, no money. Run with
//   pnpm exec vitest run --config evals/vitest.diagnostics.config.ts evals/helpers/dedup-outcome.unit.test.ts
import { describe, expect, it } from 'vitest'
import { judgeDedupOutcome } from './dedup-outcome.js'
import type { Pair } from './quality.js'

const PAIR: Pair = {
  id: 'T1',
  existing: 'At Dovren Toolworks, write review summaries as three bullets followed by one explicit next action.',
  incoming: 'At Dovren Toolworks, write review summaries as five bullets followed by one explicit next action.',
  label: 'distinct',
}
const target = (prompt: string) => /\[(ENG-[^\]]+)\]/.exec(prompt)?.[1] ?? 'none'
const says = (decision: string) => async (prompt: string) => `DECISION: ${decision}\nTARGET: ${decision === 'ADD' ? 'none' : target(prompt)}\nREASON: scripted`

describe('LRN-7 outcome from the store', () => {
  it('ADD keeps two memories with both texts as said', async () => {
    const j = await judgeDedupOutcome(PAIR, says('ADD'), 'bag-of-words')
    expect(j.asked, 'precondition: the checker was shown the pair').toBeGreaterThan(0)
    expect(j.outcome, j.detail).toBe('kept-separate')
  })
  for (const d of ['NOOP', 'UPDATE', 'MERGE']) {
    it(`${d} leaves one memory`, async () => {
      const j = await judgeDedupOutcome(PAIR, says(d), 'bag-of-words')
      expect(j.asked, 'precondition: the checker was shown the pair').toBeGreaterThan(0)
      expect(j.outcome, j.detail).toBe('one-memory')
    })
  }
  it('a checker that fails is "could not tell", not a decision', async () => {
    const j = await judgeDedupOutcome(PAIR, async () => { throw new Error('checker down') }, 'bag-of-words')
    expect(j.outcome, j.detail).toBe('could-not-tell')
  })
})
