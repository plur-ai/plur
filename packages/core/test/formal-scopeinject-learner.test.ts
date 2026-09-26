/**
 * Formal-verification run (ScopeInject cluster, candidate 4): extraction must
 * not invert a rule's polarity from the LEFT. A1 fixed the tail ("never X" →
 * "X"); the unanchored always/never pattern still cut a preceding negation off
 * and matched "never" inside "whenever".
 * Model: spec/formal/PlurSpec/ScopeInject.lean (`extract_preserves_polarity`).
 */
import { describe, it, expect } from 'vitest'
import { extractLearnings } from '../src/learner.js'

const stmts = (t: string) => extractLearnings([{ role: 'user', content: t }]).map(c => c.statement)

describe('learner keeps a negation that precedes always/never', () => {
  it.each([
    ["Don't always rerun the full suite.", "Don't always rerun the full suite"],
    ['Don’t always rerun the full suite.', 'Don’t always rerun the full suite'],
    ['Do not always trust the cache on CI.', 'Do not always trust the cache on CI'],
    ['You should not always rebase onto main.', 'not always rebase onto main'],
  ])('%s', (text, expected) => {
    expect(stmts(text)).toEqual([expected])
  })

  it('does not read "never" inside "whenever"', () => {
    for (const s of stmts('Whenever you deploy, run the smoke tests first.')) {
      expect(s.toLowerCase().startsWith('never')).toBe(false)
    }
  })

  it('good case: plain always/never rules are unchanged', () => {
    expect(stmts('Never commit the API key to the repo.')).toEqual(['Never commit the API key to the repo'])
    expect(stmts('Always run pnpm build before tests.')).toEqual(['Always run pnpm build before tests'])
  })
})
