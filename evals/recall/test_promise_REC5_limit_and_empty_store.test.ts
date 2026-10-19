// REC-5: Search never returns more results than I asked for, and an empty store answers with nothing rather than an error.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

const ASKED = 3

describe('REC-5 search respects the limit, and an empty store answers with nothing', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const embedder of ['off', 'bag-of-words'] as const) {
    it(`never more than asked (embedder: ${embedder})`, async () => {
      s = await tempStore({ embedder })
      for (let i = 1; i <= 12; i++) {
        await s.plur.learn(`Kafka consumer group rebalancing rule number ${i} for partition ${i * 7}`, { scope: 'global' })
      }

      // Precondition: many more memories match than the limit I will ask for.
      const wide = await s.plur.recall('kafka consumer group rebalancing', { limit: 20 })
      expect(wide.length, `precondition: expected more than ${ASKED} matching memories; found ${wide.length}`)
        .toBeGreaterThan(ASKED)

      const keyword = await s.plur.recall('kafka consumer group rebalancing', { limit: ASKED })
      const hybrid = await s.plur.recallHybrid('kafka consumer group rebalancing', { limit: ASKED })
      const meta = await s.plur.recallHybridWithMeta('kafka consumer group rebalancing', { limit: ASKED })

      for (const [name, got] of [['keyword search', keyword], ['hybrid search', hybrid], ['hybrid search with details', meta.engrams]] as const) {
        expect(got.length, `${name}: expected some results (matches exist); got none`).toBeGreaterThan(0)
        expect(got.length, `${name}: asked for at most ${ASKED} results, got ${got.length}`).toBeLessThanOrEqual(ASKED)
      }
    })

    it(`an empty store answers with nothing (embedder: ${embedder})`, async () => {
      s = await tempStore({ embedder })
      const keyword = await s.plur.recall('anything at all', { limit: 5 }).catch((e: Error) => `threw: ${e.message}`)
      const hybrid = await s.plur.recallHybrid('anything at all', { limit: 5 }).catch((e: Error) => `threw: ${e.message}`)
      expect(keyword, 'keyword search on an empty store: expected an empty list, not an error').toEqual([])
      expect(hybrid, 'hybrid search on an empty store: expected an empty list, not an error').toEqual([])
    })
  }
})
