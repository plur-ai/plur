// REC-1: When I ask about something I taught it, the memory that answers it comes back in the top five.
//
// Quality eval (evals/README.md): frozen labels in evals/gold/recall-v1, written
// by a different model family from the promise text alone. The floor is a
// literal. It was proposed from the first measured baseline (2026-10-15) and
// confirmed by the owner on 2026-10-16.
import { afterEach, describe, expect, it } from 'vitest'
import { fmt, goldSet, holdoutConfigured, loadCorpus, recallAtK, searchIn, type GoldSet } from '../helpers/quality.js'
import { tempStore, type TempStore } from '../helpers/store.js'

const FLOOR = 0.85 // set by the owner 2026-10-16: share of questions whose answer is in the top 5

async function measure(set: GoldSet, s: TempStore) {
  const ids = await loadCorpus(s.plur, set.corpus)
  return recallAtK(searchIn(s.plur, 'hybrid', 5), set.queries, ids, 5)
}

describe('REC-1 the memory that answers my question is in the top five', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('dev set, real meaning model', async () => {
    s = await tempStore({ embedder: 'real' })
    const r = await measure(goldSet('dev'), s)
    console.log(`REC-1 dev R@5 ${fmt(r)}; missed: ${r.misses.join(', ')}`)
    expect(r.rate, `the answer was in the top five for ${fmt(r)} of questions; the floor is ${FLOOR * 100}%. Missed: ${r.misses.join(', ')}`)
      .toBeGreaterThanOrEqual(FLOOR)
  })

  if (holdoutConfigured()) {
    it('private holdout set, real meaning model', async () => {
      s = await tempStore({ embedder: 'real' })
      const r = await measure(goldSet('holdout'), s)
      console.log(`REC-1 holdout R@5 ${fmt(r)}`)
      expect(r.rate, `holdout: the answer was in the top five for ${fmt(r)}; the floor is ${FLOOR * 100}%`)
        .toBeGreaterThanOrEqual(FLOOR)
    })
  }
})
