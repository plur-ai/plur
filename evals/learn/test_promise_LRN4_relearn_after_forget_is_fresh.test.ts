// LRN-4: After I forget a memory, saying the same thing again gives me a fresh memory instead of bringing the old one back.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

const SAID = 'Use the eu-west region for all new storage buckets'

describe('LRN-4 re-saying a forgotten memory gives a fresh one', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const via of ['learn', 'learnAsync'] as const) {
    it(`same scope, via ${via}`, async () => {
      s = await tempStore({ embedder: 'off' })
      const old = await s.plur.learn(SAID, { scope: 'global' })
      await s.plur.forget(old.id, 'eval: forget it', { force: true })
      const gone = await s.plur.getById(old.id)
      expect(gone?.status, 'precondition: the first memory is retired after the forget').toBe('retired')

      const again = via === 'learn'
        ? await s.plur.learn(SAID, { scope: 'global' })
        : (await s.plur.learnAsync(SAID, { scope: 'global' })).engram

      expect(again.id, `expected a fresh memory; got back the forgotten one ${old.id}`).not.toBe(old.id)
      const fresh = await s.plur.getById(again.id)
      expect(fresh?.status, `expected the fresh memory to be active; it is ${fresh?.status}`).toBe('active')
      expect(fresh?.statement).toBe(SAID)
      const oldAfter = await s.plur.getById(old.id)
      expect(oldAfter?.status, `expected the forgotten memory to stay forgotten; it is ${oldAfter?.status}`).toBe('retired')

      const found = (await s.plur.recall('eu-west region storage buckets', { limit: 10 })).map(e => e.id)
      expect(found, `expected search to find the fresh memory ${again.id}; got ${JSON.stringify(found)}`).toContain(again.id)
      expect(found, 'search must not bring the forgotten memory back').not.toContain(old.id)
    })
  }
})
