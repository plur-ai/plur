// REC-4: A memory I forget never comes back when I search, whichever search I use.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

describe('REC-4 a forgotten memory never comes back in search', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const embedder of ['off', 'bag-of-words'] as const) {
    it(`keyword and hybrid search (embedder: ${embedder})`, async () => {
      s = await tempStore({ embedder })
      const keep = await s.plur.learn('Deploy the billing service with blue-green rollouts', { scope: 'global' })
      const gone = await s.plur.learn('Deploy the billing service on Fridays after the freeze', { scope: 'global' })

      const before = await s.plur.recallHybrid('deploy billing service', { limit: 10 })
      expect(before.map(e => e.id), 'precondition: both memories are found before the forget').toEqual(
        expect.arrayContaining([keep.id, gone.id]))

      await s.plur.forget(gone.id, 'eval: forget it')

      const keyword = (await s.plur.recall('deploy billing service', { limit: 10 })).map(e => e.id)
      const hybrid = (await s.plur.recallHybrid('deploy billing service', { limit: 10 })).map(e => e.id)
      expect(keyword, 'keyword search still finds the memory I kept').toContain(keep.id)
      expect(hybrid, 'hybrid search still finds the memory I kept').toContain(keep.id)
      expect(keyword, 'keyword search returned the forgotten memory').not.toContain(gone.id)
      expect(hybrid, 'hybrid search returned the forgotten memory').not.toContain(gone.id)
    })
  }
})
