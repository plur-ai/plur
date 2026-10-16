// LRN-3: Telling apart a real duplicate from a different-but-similar statement is right on a labelled set of pairs.
//
// Without a language model PLUR does not decide duplicates; on every write it
// reports the closest existing memories with a similarity score
// (learnAsync(...).dedup.near_duplicates). This eval measures how well that
// score separates the labelled pairs: the area under the ROC curve, the chance
// a random duplicate pair scores above a random different-but-similar pair
// (0.5 is a coin toss, 1.0 is perfect). It does not test a decision, because
// none is made; whether one should be is an owner decision (promises.yaml).
//
// The floor is a literal, proposed from the first baseline (2026-10-15), confirmed by the owner 2026-10-16.
import { describe, expect, it } from 'vitest'
import { auc, goldSet, holdoutConfigured, type Pair } from '../helpers/quality.js'
import { tempStore } from '../helpers/store.js'

const FLOOR = 0.8 // set by the owner 2026-10-16: area under the ROC curve

async function score(p: Pair): Promise<number> {
  const s = await tempStore({ embedder: 'real' })
  try {
    const existing = await s.plur.learn(p.existing, { scope: 'global' })
    const r = await s.plur.learnAsync(p.incoming, { scope: 'global' })
    if (r.dedup?.mode !== 'cosine') {
      throw new Error(`precondition: pair ${p.id} was not scored by similarity (dedup mode ${r.dedup?.mode ?? 'none'})`)
    }
    const hit = r.dedup.near_duplicates?.find(n => n.id === existing.id)
    if (!hit) throw new Error(`precondition: pair ${p.id}: the existing memory was not among the candidates`)
    return hit.score
  } finally {
    s.cleanup()
  }
}

describe('LRN-3 a real duplicate scores above a different-but-similar statement', () => {
  for (const which of ['dev', ...(holdoutConfigured() ? ['holdout'] as const : [])] as const) {
    it(`${which} set`, async () => {
      const pairs = goldSet(which).pairs
      const dup: number[] = [], distinct: number[] = []
      for (const p of pairs) (p.label === 'duplicate' ? dup : distinct).push(await score(p))
      const a = auc(dup, distinct)
      const mean = (xs: number[]) => (xs.reduce((x, y) => x + y, 0) / xs.length).toFixed(3)
      console.log(`LRN-3 ${which} AUC ${a.toFixed(3)} (duplicates mean ${mean(dup)}, n=${dup.length}; similar-but-different mean ${mean(distinct)}, n=${distinct.length})`)
      expect(a, `a duplicate outscored a similar-but-different pair ${(a * 100).toFixed(1)}% of the time; the floor is ${FLOOR * 100}%`)
        .toBeGreaterThanOrEqual(FLOOR)
    })
  }
})
