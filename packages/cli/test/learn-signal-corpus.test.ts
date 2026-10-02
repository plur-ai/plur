/**
 * The detector measured on a labelled corpus (re-audit of PR #1522, round 2).
 *
 * Every message carries its expected label. A message the detector still gets
 * wrong is listed in KNOWN with the reason, and asserted as that known
 * behaviour, so any change to it shows up here. The aggregate test holds the
 * owner's targets: precision at least 85%, recall not below the 71.1% the
 * round-1 fix measured.
 */
import { describe, it, expect } from 'vitest'
import { hasLearnSignal } from '../src/lib/learn-signal.js'
import { CORPUS } from './fixtures/learn-signal-corpus.js'

/** Messages the detector is known to label wrongly, with the reason. Asserted as the opposite of their label. */
const KNOWN: Record<string, string> = {
  'Actually, the staging host is the second one, not the first.':
    'a correction with no correction phrase; "actually" fired on plain requests in round 1, so it is not on the list. Left to the fallback.',
  'Again: no emojis in commits.':
    'a rule with no rule phrase ("Again:" is too common as a plain word to match on). Left to the fallback.',
}

const show = (t: string) => JSON.stringify(t.length > 90 ? `${t.slice(0, 60)}…${t.slice(-25)}` : t)

describe('hasLearnSignal on the labelled corpus', () => {
  for (const [label, lang, text] of CORPUS) {
    const known = KNOWN[text]
    const expected = known ? label !== 'S' : label === 'S'
    it(`${known ? 'known ' + (label === 'S' ? 'miss' : 'over-fire') + ' ' : ''}${label} [${lang}] ${show(text)}`, () => {
      expect(hasLearnSignal(text)).toBe(expected)
    })
  }

  it('precision >= 85% and recall >= 71.1% over the whole corpus', () => {
    let tp = 0, fp = 0, fn = 0
    for (const [label, , text] of CORPUS) {
      const got = hasLearnSignal(text)
      if (label === 'S' && got) tp++
      else if (label === 'S') fn++
      else if (got) fp++
    }
    const precision = tp / (tp + fp)
    const recall = tp / (tp + fn)
    expect(precision).toBeGreaterThanOrEqual(0.85)
    expect(recall).toBeGreaterThanOrEqual(0.711)
  })
})
