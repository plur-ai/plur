// REC-2: A memory worded differently from my question is still found; matching words is not required.
//
// Uses only the paraphrase questions: evals/gold/check.py proves none of them
// shares a content word with the memory it should find. Two arms:
//   meaning   — the shipped model must reach the floor;
//   control   — keyword search alone must stay far below it. If the control
//               passes too, the questions are not testing meaning and the
//               meaning arm's score proves nothing.
// Floors are literals, proposed from the first baseline (2026-10-15) and confirmed
// by the owner on 2026-10-16.
import { describe, expect, it } from 'vitest'
import { fmt, goldSet, holdoutConfigured, loadCorpus, recallAtK, searchIn, type GoldSet } from '../helpers/quality.js'
import { tempStore, type TempStore } from '../helpers/store.js'

const FLOOR = 0.6 // set by the owner 2026-10-16: share of reworded questions answered in the top 5
const CONTROL_CEILING = 0.25 // keyword-only search must stay at or under this

async function measure(set: GoldSet, embedder: 'real' | 'off') {
  const s = await tempStore({ embedder })
  try {
    const ids = await loadCorpus(s.plur, set.corpus)
    const qs = set.queries.filter(q => q.kind === 'paraphrase')
    if (qs.length < 20) throw new Error(`precondition: only ${qs.length} reworded questions in the ${set.name} set`)
    return await recallAtK(searchIn(s.plur, embedder === 'real' ? 'hybrid' : 'bm25-only', 5), qs, ids, 5)
  } finally {
    s.cleanup()
  }
}

describe('REC-2 a reworded question still finds its memory', () => {

  for (const which of ['dev', ...(holdoutConfigured() ? ['holdout'] as const : [])] as const) {
    it(`${which} set: the meaning model finds it, keyword search alone does not`, async () => {
      const set = goldSet(which)
      const control = await measure(set, 'off')
      const meaning = await measure(set, 'real')
      console.log(`REC-2 ${which} meaning ${fmt(meaning)}; keyword-only control ${fmt(control)}`)
      expect(control.rate,
        `the keyword-only control found ${fmt(control)} of reworded questions; above ${CONTROL_CEILING * 100}% the questions share too many words to test meaning`)
        .toBeLessThanOrEqual(CONTROL_CEILING)
      expect(meaning.rate, `reworded questions were answered in the top five for ${fmt(meaning)}; the floor is ${FLOOR * 100}%. Missed: ${meaning.misses.join(', ')}`)
        .toBeGreaterThanOrEqual(FLOOR)
    })
  }
})
