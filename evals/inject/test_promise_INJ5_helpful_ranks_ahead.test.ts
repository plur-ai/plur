// INJ-5: Memories I rated helpful are given to my agent ahead of equally
// relevant ones I rated unhelpful.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { given, positionInText } from '../helpers/corrections-inject-feedback-util.js'

const TASK = 'deploy the billing service rollout'
// Two memories equally relevant to the task: the same task words, the same length.
const FIRST = 'Deploy the billing service rollout behind the green flag'
const SECOND = 'Deploy the billing service rollout behind the amber flag'

describe('INJ-5 a memory rated helpful is given ahead of an equally relevant one rated unhelpful', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const path of ['inject', 'injectHybrid'] as const) {
    for (const ratings of [1, 3] as const) {
      // Both assignments, so the order the memories were saved in cannot be
      // what puts the helpful one first.
      for (const helpfulIs of ['first saved', 'second saved'] as const) {
        it(`${path}, rated ${ratings}x each, helpful one ${helpfulIs}`, async () => {
          s = await tempStore({ embedder: 'bag-of-words' })
          const a = await s.plur.learn(FIRST, { scope: 'global' })
          const b = await s.plur.learn(SECOND, { scope: 'global' })
          const [helpful, unhelpful] = helpfulIs === 'first saved' ? [a, b] : [b, a]

          const before = given(await s.plur[path](TASK, { budget: 4000 }))
          expect(before, 'precondition: before any rating both memories are given').toEqual(
            expect.arrayContaining([a.id, b.id]))

          for (let i = 0; i < ratings; i++) {
            await s.plur.feedback(helpful.id, 'positive')
            await s.plur.feedback(unhelpful.id, 'negative')
          }

          const r = await s.plur[path](TASK, { budget: 4000 })
          const ids = given(r)
          expect(ids, 'the memory rated helpful was not given at all').toContain(helpful.id)
          const pHelpful = positionInText(r, helpful.id)
          const pUnhelpful = positionInText(r, unhelpful.id)
          // If the unhelpful one was dropped entirely, the helpful one is ahead.
          if (pUnhelpful >= 0) {
            expect(pHelpful, `the memory rated unhelpful (${unhelpful.id}) is given ahead of the one rated helpful (${helpful.id})`)
              .toBeLessThan(pUnhelpful)
          }
        })
      }
    }
  }
})
