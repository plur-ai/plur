// Proof that the duplicate-checker grading (LRN-7, LRN-8) reads the store, not
// the reported decision, and that each label accepts only its right outcome.
// Not a promise eval: hand-built store snapshots, a scripted checker, the
// bag-of-words embedder, no model, no money. Run with
//   pnpm exec vitest run --config evals/vitest.diagnostics.config.ts evals/helpers/dedup-outcome.unit.test.ts
import { describe, expect, it } from 'vitest'
import { classify, isRight, judgeDedupOutcome, type Stored } from './dedup-outcome.js'
import type { DedupPair } from './quality.js'

const OLD = 'At Dovren Toolworks, write review summaries as three bullets followed by one explicit next action.'
const NEW = 'At Dovren Toolworks, write review summaries as five bullets followed by one explicit next action.'
const PAIR: DedupPair = { id: 'T1', existing: OLD, incoming: NEW, label: 'supersede' }

const mem = (id: string, statement: string, rel: Stored['relations'] = {}, status = 'active'): Stored =>
  ({ id, statement, status, relations: { supersedes: [], superseded_by: [], ...rel } })

describe('classify: hand-built store snapshots', () => {
  const cases: Array<[string, Stored[], string]> = [
    ['only the existing memory', [mem('A', OLD)], 'one-memory'],
    ['new supersedes old, linked both ways, old text kept', [mem('A', OLD, { superseded_by: ['B'] }), mem('B', NEW, { supersedes: ['A'] })], 'superseded'],
    ['two live memories, no link', [mem('A', OLD), mem('B', NEW)], 'kept-separate'],
    ['the existing text was rewritten to the new one (overwrite)', [mem('A', NEW)], 'existing-rewritten'],
    ['overwrite plus a second copy', [mem('A', NEW), mem('B', NEW)], 'existing-rewritten'],
    ['the existing memory is gone', [mem('B', NEW)], 'existing-rewritten'],
    ['the existing memory was retired with nothing replacing it', [mem('A', OLD, {}, 'retired'), mem('B', NEW)], 'existing-rewritten'],
    ['superseded old still live: link only on the new memory', [mem('A', OLD), mem('B', NEW, { supersedes: ['A'] })], 'wrong-shape'],
    ['link only on the old memory', [mem('A', OLD, { superseded_by: ['B'] }), mem('B', NEW)], 'wrong-shape'],
    ['the superseding memory holds altered text', [mem('A', OLD, { superseded_by: ['B'] }), mem('B', NEW + ' Also ping the lead.', { supersedes: ['A'] })], 'wrong-shape'],
    ['the superseding memory is itself superseded', [mem('A', OLD, { superseded_by: ['B'] }), mem('B', NEW, { supersedes: ['A'], superseded_by: ['A'] })], 'wrong-shape'],
    ['two memories both claim to replace the old one', [mem('A', OLD, { superseded_by: ['B', 'C'] }), mem('B', NEW, { supersedes: ['A'] }), mem('C', NEW, { supersedes: ['A'] })], 'wrong-shape'],
  ]
  for (const [name, stored, want] of cases) {
    it(`${name} -> ${want}`, () => {
      const c = classify(PAIR, 'A', stored)
      expect(c.outcome, c.detail).toBe(want)
    })
  }
})

describe('isRight: each label accepts only its right outcomes', () => {
  const all = ['one-memory', 'superseded', 'kept-separate', 'existing-rewritten', 'wrong-shape', 'could-not-tell'] as const
  const right: Record<DedupPair['label'], string[]> = {
    duplicate: ['one-memory', 'superseded'],
    supersede: ['superseded'],
    distinct: ['kept-separate'],
  }
  for (const label of Object.keys(right) as DedupPair['label'][]) {
    for (const o of all) {
      it(`${label} + ${o} -> ${right[label].includes(o) ? 'right' : 'wrong'}`, () => {
        expect(isRight(label, o)).toBe(right[label].includes(o))
      })
    }
  }
})

const target = (prompt: string) => /\[(ENG-[^\]]+)\]/.exec(prompt)?.[1] ?? 'none'
const says = (decision: string) => async (prompt: string) => `DECISION: ${decision}\nTARGET: ${decision === 'ADD' ? 'none' : target(prompt)}\nREASON: scripted`

describe('judgeDedupOutcome: the real store, a scripted checker', () => {
  for (const path of ['single', 'batch'] as const) {
    it(`${path}: ADD keeps two live memories with both texts as said`, async () => {
      const j = await judgeDedupOutcome({ ...PAIR, label: 'distinct' }, says('ADD'), 'bag-of-words', path)
      expect(j.asked, 'precondition: the checker was shown the pair').toBeGreaterThan(0)
      expect(j.outcome, j.detail).toBe('kept-separate')
      expect(j.right).toBe(true)
    })
    it(`${path}: NOOP leaves only the existing memory`, async () => {
      const j = await judgeDedupOutcome({ ...PAIR, label: 'duplicate' }, says('NOOP'), 'bag-of-words', path)
      expect(j.asked, 'precondition: the checker was shown the pair').toBeGreaterThan(0)
      expect(j.outcome, j.detail).toBe('one-memory')
      expect(j.right).toBe(true)
    })
    it(`${path}: ADD on a supersede pair is wrong (the new memory is not linked)`, async () => {
      const j = await judgeDedupOutcome(PAIR, says('ADD'), 'bag-of-words', path)
      expect(j.outcome, j.detail).toBe('kept-separate')
      expect(j.right).toBe(false)
    })
  }
  it('a checker that fails is "could not tell", not a decision', async () => {
    const j = await judgeDedupOutcome(PAIR, async () => { throw new Error('checker down') }, 'bag-of-words')
    expect(j.outcome, j.detail).toBe('could-not-tell')
    expect(j.right).toBe(false)
  })
})
