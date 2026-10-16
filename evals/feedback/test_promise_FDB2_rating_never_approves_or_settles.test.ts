// FDB-2: A rating never approves a draft, and an automatic rating never makes a
// memory more settled.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { given } from '../helpers/corrections-inject-feedback-util.js'

// How settled a memory is, least to most (the commitment ladder).
const LADDER = ['exploring', 'leaning', 'decided', 'locked']
const rank = (c: string | undefined) => LADDER.indexOf(c ?? '')

describe('FDB-2 ratings never approve a draft; automatic ratings never settle a memory', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const source of ['explicit', 'auto'] as const) {
    it(`helpful ratings (${source}) leave a draft a draft, and it is still not given to the agent`, async () => {
      s = await tempStore({ embedder: 'off' })
      const approved = await s.plur.learn('Deploy the billing service with blue-green rollouts', { scope: 'global' })
      const draft = await s.plur.learn('Deploy the billing service rollout only on Tuesdays',
        { scope: 'global', commitment: 'draft' })
      expect((await s.plur.getById(draft.id))?.commitment, 'precondition: stored as a draft').toBe('draft')

      for (let i = 0; i < 5; i++) await s.plur.feedback(draft.id, 'positive', undefined, { source })

      const after = await s.plur.getById(draft.id)
      expect(after?.feedback_signals?.positive, 'precondition: the ratings were recorded on the draft').toBe(5)
      expect(after?.commitment, `after 5 helpful ratings the draft became "${after?.commitment}"; it must stay a draft`)
        .toBe('draft')

      const ids = given(await s.plur.inject('deploy the billing service rollout', { budget: 4000 }))
      expect(ids, 'precondition: an approved, equally relevant memory is given').toContain(approved.id)
      expect(ids, 'after helpful ratings the draft is given to the agent as if approved').not.toContain(draft.id)
    })
  }

  for (const start of ['exploring', 'leaning'] as const) {
    it(`automatic helpful ratings never move a "${start}" memory up the ladder`, async () => {
      s = await tempStore({ embedder: 'off' })
      const autoRated = await s.plur.learn('Deploy the billing service with blue-green rollouts',
        { scope: 'global', commitment: start })
      const handRated = await s.plur.learn('Rotate the on-call pager every Monday morning',
        { scope: 'global', commitment: start })

      for (let i = 0; i < 5; i++) {
        await s.plur.feedback(autoRated.id, 'positive', undefined, { source: 'auto' })
      }
      await s.plur.feedback(handRated.id, 'positive')

      // Control: a deliberate rating can settle a memory, so the ladder is live.
      const hand = await s.plur.getById(handRated.id)
      expect(rank(hand?.commitment), `precondition: a deliberate helpful rating moves "${start}" up (got "${hand?.commitment}")`)
        .toBeGreaterThan(rank(start))

      const auto = await s.plur.getById(autoRated.id)
      expect(auto?.feedback_signals?.positive, 'precondition: the automatic ratings were recorded').toBe(5)
      expect(auto?.commitment, `5 automatic helpful ratings moved the memory from "${start}" to "${auto?.commitment}"`)
        .toBe(start)
    })
  }
})
