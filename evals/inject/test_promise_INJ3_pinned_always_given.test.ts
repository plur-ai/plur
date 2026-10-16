// INJ-3: A rule I pinned is always given to my agent in its scope, even when it
// does not match the task.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { given } from '../helpers/corrections-inject-feedback-util.js'

const TASK = 'deploy the billing service to production'

describe('INJ-3 a pinned rule is given even when the task does not match it', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const path of ['inject', 'injectHybrid'] as const) {
    for (const how of ['pinned when saved', 'pinned afterwards'] as const) {
      it(`${how} (${path})`, async () => {
        s = await tempStore({ embedder: 'bag-of-words' })
        // Memories that DO match the task, competing for the same space.
        for (let i = 1; i <= 6; i++) {
          await s.plur.learn(`Deploy the billing service to production in step ${i} of the release checklist`,
            { scope: 'project:alpha' })
        }
        // Rules that share no word with the task (not even "the"): one pinned, one twin not pinned.
        const pinnedText = 'Never mention customer names unless users raise them first'
        const rule = how === 'pinned when saved'
          ? await s.plur.learn(pinnedText, { scope: 'project:alpha', pinned: true })
          : await s.plur.learn(pinnedText, { scope: 'project:alpha' })
        if (how === 'pinned afterwards') {
          const updated = await s.plur.setPinned(rule.id, true)
          expect(updated?.pinned, 'precondition: setPinned reports the rule as pinned').toBe(true)
        }
        const twin = await s.plur.learn('Always greet returning visitors warmly by their first name',
          { scope: 'project:alpha' })

        const r = await s.plur[path](TASK, { scope: 'project:alpha', budget: 2000 })
        const ids = given(r)
        // Preconditions: the injection is working, and an equally unrelated
        // rule that is NOT pinned is left out — so the task really does not match.
        expect(r.count, 'precondition: the agent was given the memories that match the task').toBeGreaterThan(0)
        expect(ids, 'precondition: an unrelated rule that is not pinned is not given, so the task does not match it')
          .not.toContain(twin.id)

        expect(ids, `the pinned rule ${rule.id} was not given to the agent in its scope; it was given ${JSON.stringify(ids)}`)
          .toContain(rule.id)
      })
    }
  }
})
