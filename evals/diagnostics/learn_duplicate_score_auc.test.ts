// DIAGNOSTIC — not a promise eval. Formerly LRN-3 ("Telling apart a real
// duplicate from a different-but-similar statement is right on a labelled set
// of pairs"), retired 2026-10-17: the owner decided duplicate handling is
// promised only when an AI checker is configured, and that promise (LRN-7) is
// graded on the persisted outcome (evals/learn/test_promise_LRN7_*). A ranking
// of similarity scores is not a decision (audit D-01), so this file is kept as
// a measurement only. It is not named test_promise_*, so the scoreboard never
// collects it and it cannot turn any promise green or red. Run it with
//   pnpm exec vitest run --config evals/vitest.diagnostics.config.ts evals/diagnostics/learn_duplicate_score_auc.test.ts
//
// Without a language model PLUR does not decide duplicates; on every write it
// reports the closest existing memories with a similarity score
// (learnAsync(...).dedup.near_duplicates). This measures how well that score
// separates the labelled pairs: the area under the ROC curve, the chance a
// random duplicate pair scores above a random different-but-similar pair (0.5
// is a coin toss, 1.0 is perfect). The 0.8 reference line was the floor the
// owner set for LRN-3 on 2026-10-16; it stays as the diagnostic's pass mark.
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

describe('diagnostic (formerly LRN-3): a real duplicate scores above a different-but-similar statement', () => {
  for (const which of ['dev', ...(holdoutConfigured() ? ['holdout'] as const : [])] as const) {
    it(`${which} set`, async () => {
      const pairs = goldSet(which).pairs
      const dup: number[] = [], distinct: number[] = []
      for (const p of pairs) (p.label === 'duplicate' ? dup : distinct).push(await score(p))
      const a = auc(dup, distinct)
      const mean = (xs: number[]) => (xs.reduce((x, y) => x + y, 0) / xs.length).toFixed(3)
      console.log(`duplicate-score diagnostic ${which} AUC ${a.toFixed(3)} (duplicates mean ${mean(dup)}, n=${dup.length}; similar-but-different mean ${mean(distinct)}, n=${distinct.length})`)
      expect(a, `a duplicate outscored a similar-but-different pair ${(a * 100).toFixed(1)}% of the time; the floor is ${FLOOR * 100}%`)
        .toBeGreaterThanOrEqual(FLOOR)
    })
  }
})
