// PRV-2: Searching in one project never shows memories from another project, even one with a similar name.
//
// Three projects whose names share a prefix (app, app-two, application) each
// hold a memory on the same topic. A search scoped to `project:app` must find
// app's memory and never the other two, on every search path.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

const MINE = 'project app: the release checklist requires a signed changelog'
const SIBLING = 'project app-two: the release checklist requires a signed changelog and a demo'
const LOOKALIKE = 'project application: the release checklist requires a signed changelog and QA'

describe('PRV-2 a project search never shows memories from a similarly named project', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const embedder of ['off', 'bag-of-words'] as const) {
    it(`recall, hybrid recall and inject scoped to project:app (embedder: ${embedder})`, async () => {
      s = await tempStore({ embedder })
      const mine = await s.plur.learn(MINE, { scope: 'project:app' })
      const sibling = await s.plur.learn(SIBLING, { scope: 'project:app-two' })
      const lookalike = await s.plur.learn(LOOKALIKE, { scope: 'project:application' })
      const others = [sibling.id, lookalike.id]

      const unscoped = (await s.plur.recall('release checklist signed changelog', { limit: 20 })).map(e => e.id)
      expect(unscoped, 'precondition: an unscoped search finds all three projects\' memories').toEqual(
        expect.arrayContaining([mine.id, ...others]))

      const query = 'release checklist signed changelog'
      const keyword = (await s.plur.recall(query, { scope: 'project:app', limit: 20 })).map(e => e.id)
      const hybrid = (await s.plur.recallHybrid(query, { scope: 'project:app', limit: 20 })).map(e => e.id)
      const injected = (await s.plur.inject(query, { scope: 'project:app', budget: 4000 })).injected_ids
      const injectedHybrid = (await s.plur.injectHybrid(query, { scope: 'project:app', budget: 4000 })).injected_ids

      for (const [name, ids] of [['keyword search', keyword], ['hybrid search', hybrid], ['inject', injected], ['hybrid inject', injectedHybrid]] as const) {
        expect(ids, `${name} in project:app should find project app's own memory; got ${JSON.stringify(ids)}`).toContain(mine.id)
        expect(ids, `${name} in project:app showed a memory from project:app-two`).not.toContain(sibling.id)
        expect(ids, `${name} in project:app showed a memory from project:application`).not.toContain(lookalike.id)
      }
    })
  }
})
