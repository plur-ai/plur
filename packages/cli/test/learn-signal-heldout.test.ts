/**
 * The detector on a held-out set it was not written against (0.21.1 re-audit,
 * round 3). Only the aggregate is gated, never single messages: asserting
 * each label would invite tuning to these exact phrasings. Gate (owner):
 * precision >= 85%, recall >= 60% overall and >= 55% for Slovenian.
 */
import { describe, it, expect } from 'vitest'
import { hasLearnSignal } from '../src/lib/learn-signal.js'
import { HELDOUT } from './fixtures/learn-signal-heldout.js'

function score(lang?: string) {
  let tp = 0, fp = 0, fn = 0
  for (const m of HELDOUT) {
    if (lang && m.lang !== lang) continue
    const got = hasLearnSignal(m.text)
    if (m.label === 'S' && got) tp++
    else if (m.label === 'S') fn++
    else if (got) fp++
  }
  return { precision: tp / (tp + fp), recall: tp / (tp + fn) }
}

describe('hasLearnSignal on the held-out set', () => {
  it('precision >= 85% and recall >= 60% overall', () => {
    const { precision, recall } = score()
    expect(precision).toBeGreaterThanOrEqual(0.85)
    expect(recall).toBeGreaterThanOrEqual(0.6)
  })
  it('recall >= 55% in Slovenian, with precision >= 85%', () => {
    const { precision, recall } = score('sl')
    expect(precision).toBeGreaterThanOrEqual(0.85)
    expect(recall).toBeGreaterThanOrEqual(0.55)
  })
})
