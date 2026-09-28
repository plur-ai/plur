/**
 * Audit of #1228, finding 3 (LOW): the learner's left-negation fix only knew
 * `don't` / `do not` / `not`. Contracted and fused negations before
 * always/never ("cannot always", "doesn't always", "shouldn't always",
 * "won't always", "isn't always") were cut off, so the stored directive was
 * the inverted "always …". Model: spec/formal/PlurSpec/ScopeInject.lean §4
 * (`extract_preserves_polarity`, negators abstracted as one `neg` token).
 */
import { describe, it, expect } from 'vitest'
import { extractLearnings } from '../src/learner.js'

const stmts = (t: string) => extractLearnings([{ role: 'user', content: t }]).map(c => c.statement)

describe('learner keeps every negation directly before always/never', () => {
  it.each([
    ['You cannot always trust the cache on CI.', 'cannot always trust the cache on CI'],
    ["The linter doesn't always catch unused imports.", "doesn't always catch unused imports"],
    ['You shouldn’t always rebase onto main.', 'shouldn’t always rebase onto main'],
    ["The nightly job won't always finish before standup.", "won't always finish before standup"],
    ["The staging box isn't always reachable over the vpn.", "isn't always reachable over the vpn"],
    ["You can't always rely on the retry.", "can't always rely on the retry"],
    ['The flaky suite doesnt always fail on the first run.', 'doesnt always fail on the first run'],
  ])('%s', (text, expected) => {
    expect(stmts(text)).toEqual([expected])
  })

  it('no candidate is ever an un-negated always/never cut from a negated sentence', () => {
    for (const text of [
      'You cannot always trust the cache on CI.',
      "Tests won't ever pass on the old runner.",
      "You mustn't always squash the merge.",
    ]) {
      for (const s of stmts(text)) expect(s, text).not.toMatch(/^(always|never)\b/i)
    }
  })

  it('a word merely ending in -nt is not taken as a negation', () => {
    expect(stmts('I want always the short summary first.')).toEqual(['always the short summary first'])
  })
})
