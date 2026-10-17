// REC-6: A memory that was replaced by a correction is either hidden or visibly
// marked as replaced when I search, in what I actually see.
//
// Stricter than before (audit B-01 sibling): the core cases below check the
// replaced-by link on the result object; the MCP cases check what the agent
// actually reads in the recall tool reply. A link the reply does not show is
// not a mark. Visible mark = the text shown for the replaced memory names the
// correction's id and says it was superseded or replaced.
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
import { tempStore, useEmbedder, type TempStore } from '../helpers/store.js'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'

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

describe('REC-6 in the MCP recall replies, a replaced memory is hidden or visibly marked', () => {
  let m: McpSession | undefined
  afterEach(async () => { await m?.close(); m = undefined })

  for (const embedder of ['off', 'bag-of-words'] as const) {
    it(`plur_recall (hybrid and keyword) and plur_recall_hybrid (embedder: ${embedder})`, async () => {
      useEmbedder(embedder)
      m = await mcpSession({ profile: 'full' })
      const old = await m.plur.learn('The invoice export runs nightly at 02:00 from the reporting host', { scope: 'global' })
      const correction = await m.plur.learn('The invoice export runs nightly at 04:00 from the reporting host', {
        scope: 'global', supersedes: [old.id],
      })
      const query = 'invoice export nightly reporting host'
      for (const [name, tool, args] of [
        ['plur_recall (hybrid)', 'plur_recall', { query, limit: 10 }],
        ['plur_recall (keyword)', 'plur_recall', { query, limit: 10, mode: 'keyword' }],
        ['plur_recall_hybrid', 'plur_recall_hybrid', { query, limit: 10 }],
      ] as const) {
        const res = await m.call(tool, args)
        expect(res.isError, `${name} failed: ${res.text}`).toBe(false)
        const results: Array<{ id: string; statement: string }> = res.json?.results ?? []
        expect(results.map(r => r.id), `${name}: precondition — the correction ${correction.id} is in the reply`).toContain(correction.id)
        const shown = results.find(r => r.id === old.id)
        if (!shown) continue // hidden: acceptable
        const visible = shown.statement
        const marked = visible.includes(correction.id) && /supersed|replac/i.test(visible)
        expect(marked, `${name}: the replaced memory ${old.id} is shown as if current — the agent reads "${visible}", with no visible mark that ${correction.id} replaced it`)
          .toBe(true)
      }
    })
  }
})
