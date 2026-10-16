// LRN-5: Importing many memories at once catches duplicates inside the batch and still saves every item when the AI-check budget runs out.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

describe('LRN-5 batch import', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('catches duplicates inside the batch (exact copies kept once, near-copies named)', async () => {
    s = await tempStore({ embedder: 'bag-of-words' })
    const A = 'Rotate the payment gateway signing key every ninety days'
    const nearA = 'Rotate the payment gateway signing key every sixty days'
    const other = 'The office wifi password is on the fridge'
    const batch = await s.plur.learnBatch([
      { statement: A, context: { scope: 'global' } },
      { statement: other, context: { scope: 'global' } },
      { statement: A, context: { scope: 'global' } },
      { statement: nearA, context: { scope: 'global' } },
    ])

    expect(batch.failures, `expected no failures; got ${JSON.stringify(batch.failures)}`).toEqual([])
    const byIndex = new Map(batch.results.map(r => [r.input_index, r]))
    const firstA = byIndex.get(0)!.engram.id
    expect(byIndex.get(2)?.engram.id, `the exact copy inside the batch should land on the first one (${firstA}); got ${byIndex.get(2)?.engram.id}`)
      .toBe(firstA)

    const active = (await s.plur.list()).filter(e => e.status === 'active')
    const copiesOfA = active.filter(e => e.statement === A)
    expect(copiesOfA.length, `expected one memory for the sentence imported twice; found ${copiesOfA.length}`).toBe(1)

    const near = byIndex.get(3)!
    expect(near.engram.id, 'the near-copy is new knowledge and must be saved as its own memory').not.toBe(firstA)
    expect(active.some(e => e.id === near.engram.id && e.statement === nearA), 'expected the near-copy saved as said').toBe(true)
    const named = (near.dedup?.near_duplicates ?? []).map(n => n.id)
    expect(named, `expected the near-copy to be reported as resembling ${firstA}, written earlier in the same batch; it named ${JSON.stringify(named)}`)
      .toContain(firstA)
  })

  it('saves every item when the AI-check budget runs out', async () => {
    s = await tempStore({ embedder: 'bag-of-words' })
    // Similar statements, so every item after the first has candidates and would ask the AI.
    const items = [
      'Retry the billing webhook three times before alerting',
      'Retry the billing webhook five times before paging',
      'Retry the billing webhook with exponential backoff',
      'Retry the billing webhook only on 5xx responses',
      'Retry the billing webhook from the dead letter queue',
    ]
    let llmCalls = 0
    const llm = async (_prompt: string): Promise<string> => {
      llmCalls++
      return 'DECISION: ADD\nTARGET: none\nREASON: new knowledge'
    }
    const batch = await s.plur.learnBatch(items.map(statement => ({ statement, context: { scope: 'global' } })), llm, { maxLlmCalls: 1 })

    expect(llmCalls, `precondition: the AI check was used, and no more than the budget of 1; it was called ${llmCalls} times`).toBe(1)
    expect(batch.failures, `expected no failures; got ${JSON.stringify(batch.failures)}`).toEqual([])
    const active = (await s.plur.list()).filter(e => e.status === 'active').map(e => e.statement)
    for (const it of items) {
      expect(active, `expected "${it}" to be saved although the AI-check budget ran out; saved: ${JSON.stringify(active)}`).toContain(it)
    }
    expect(batch.results.length, `expected a result for each of the ${items.length} items; got ${batch.results.length}`).toBe(items.length)
  })
})
