// INJ-4: A memory waiting for my approval is never given to my agent, but I can
// still find it by searching.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { given } from '../helpers/corrections-inject-feedback-util.js'

const TASK = 'deploy the billing service rollout'

describe('INJ-4 a draft is never injected, yet search still finds it', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const embedder of ['off', 'bag-of-words'] as const) {
    it(`end to end through inject, injectHybrid, recall and recallHybrid (embedder: ${embedder})`, async () => {
      s = await tempStore({ embedder })
      const approved = await s.plur.learn('Deploy the billing service with blue-green rollouts', { scope: 'global' })
      const draft = await s.plur.learn('Deploy the billing service rollout only on Tuesdays',
        { scope: 'global', commitment: 'draft' })
      expect((await s.plur.getById(draft.id))?.commitment, 'precondition: the memory is stored as a draft')
        .toBe('draft')

      for (const path of ['inject', 'injectHybrid'] as const) {
        const ids = given(await s.plur[path](TASK, { budget: 4000 }))
        expect(ids, `precondition (${path}): an approved memory just as relevant is given`).toContain(approved.id)
        expect(ids, `${path} gave the agent a memory still waiting for approval (${draft.id})`)
          .not.toContain(draft.id)
      }

      for (const search of ['recall', 'recallHybrid'] as const) {
        const found = (await s.plur[search]('billing service rollout Tuesdays', { limit: 10 })).map(e => e.id)
        expect(found, `${search} could not find the memory waiting for approval`).toContain(draft.id)
      }
    })
  }
})
