// REC-6: A memory that was replaced by a correction is not presented as current when I search.
//
// This promise carries an open owner decision (promises.yaml `decide`): search
// may hide a replaced memory, or show it marked as replaced. This eval accepts
// EITHER, and rejects only the third option — showing it as if it were current:
//   * hidden: the replaced memory is not in the results (and the correction is), or
//   * marked: it is in the results, and the result itself names the correction
//     that replaced it (`relations.superseded_by`, which is what the MCP recall
//     tool renders as "[superseded by …]").
// It is checked for keyword and hybrid search.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

describe('REC-6 a replaced memory is not presented as current in search', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const embedder of ['off', 'bag-of-words'] as const) {
    it(`keyword and hybrid search (embedder: ${embedder})`, async () => {
      s = await tempStore({ embedder })
      const old = await s.plur.learn('The invoice export runs nightly at 02:00 from the reporting host', { scope: 'global' })
      const correction = await s.plur.learn('The invoice export runs nightly at 04:00 from the reporting host', {
        scope: 'global', supersedes: [old.id],
      })

      for (const [name, search] of [
        ['keyword search', (q: string) => s.plur.recall(q, { limit: 10 })],
        ['hybrid search', (q: string) => s.plur.recallHybrid(q, { limit: 10 })],
      ] as const) {
        const results = await search('invoice export nightly reporting host')
        const ids = results.map(e => e.id)
        expect(ids, `${name}: precondition — the correction ${correction.id} should be found; got ${JSON.stringify(ids)}`)
          .toContain(correction.id)
        const shown = results.find(e => e.id === old.id)
        if (!shown) continue // hidden: acceptable
        const mark = shown.relations?.superseded_by ?? []
        expect(mark, `${name}: the replaced memory ${old.id} was returned as if current — expected it hidden, or marked as replaced by ${correction.id}; its replaced-by mark was ${JSON.stringify(mark)}`)
          .toContain(correction.id)
      }
    })
  }
})
