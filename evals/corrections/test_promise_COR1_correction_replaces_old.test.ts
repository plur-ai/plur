// COR-1: After I save a correction, my agent is given the correction and no
// longer the memory it replaces.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { deliversText, given } from '../helpers/corrections-inject-feedback-util.js'

const TASK = 'deploy the billing service rollout'

describe('COR-1 a correction replaces the memory it corrects in what the agent is given', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const path of ['inject', 'injectHybrid'] as const) {
    for (const embedder of ['off', 'bag-of-words'] as const) {
      it(`${path} (embedder: ${embedder})`, async () => {
        s = await tempStore({ embedder })
        const OLD = 'Deploy the billing service with blue-green rollouts'
        const FIX = 'Deploy the billing service with canary rollouts, not blue-green'
        const old = await s.plur.learn(OLD, { scope: 'global' })

        const before = await s.plur[path](TASK, { budget: 4000 })
        expect(given(before), 'precondition: before any correction the agent is given the original memory')
          .toContain(old.id)

        const fix = await s.plur.learn(FIX, { scope: 'global', supersedes: [old.id] })

        const after = await s.plur[path](TASK, { budget: 4000 })
        const ids = given(after)
        expect(ids, `the agent was not given the correction; it was given ${JSON.stringify(ids)}`)
          .toContain(fix.id)
        expect(ids, `the agent was still given the memory the correction replaces (${old.id}), in some section`)
          .not.toContain(old.id)
        // The text itself, not only the tags (fourth audit A4-03).
        expect(deliversText(after, FIX), 'the correction is not given whole: its statement is missing from the text').toBe(true)
        expect(deliversText(after, OLD), 'the replaced statement is still in the text the agent receives').toBe(false)
      })
    }
  }
})
