// REC-7: With a slow but working meaning model, search still answers within the normal deadline and says when the meaning part was cut short.
//
// "The normal deadline" is the one a user gets without configuring anything:
// PLUR_RECALL_DEADLINE_MS unset (helpers/store.ts sets it only for the real
// model) and no deadline passed by the caller. The shipped default is 10
// seconds (README of #1586: "A recall returns within this deadline with
// whatever is ready and says what is missing"). The literal below is written
// from that promise, not imported from the code.
//
// The slow model works: every embed call returns a correct vector, just after
// SLOW_MS, which is longer than the deadline. The control arm uses the same
// store with a fast model and must answer as a full meaning search, so the
// eval cannot pass by always reporting "degraded".
import { afterEach, describe, expect, it } from 'vitest'
import { _setCachedEmbedder } from '../../packages/core/src/embeddings.js'
import { bagOfWords, tempStore, useEmbedder, type TempStore } from '../helpers/store.js'

const NORMAL_DEADLINE_MS = 10_000
/** Allowance for a heavily loaded machine on top of the deadline. */
const MARGIN_MS = 5_000
/** Longer than the deadline: the meaning part cannot finish in time. */
const SLOW_MS = 25_000

describe('REC-7 a slow meaning model does not hold search past the normal deadline', () => {
  let s: TempStore
  // Slow embed calls still pending when a test ends are released at once, so
  // nothing keeps writing into a store that is being deleted.
  const pending: Array<() => void> = []
  afterEach(async () => {
    while (pending.length) pending.pop()!()
    await new Promise(r => setTimeout(r, 200))
    s?.cleanup()
  })

  function useSlowEmbedder(): void {
    const slow = <T>(value: T): Promise<T> => new Promise(resolve => {
      const t = setTimeout(() => resolve(value), SLOW_MS)
      pending.push(() => { clearTimeout(t); resolve(value) })
    })
    _setCachedEmbedder({
      name: 'slow-stub', dim: 64, modelId: 'stub',
      embed: (t: string) => slow(bagOfWords(t)),
      embedBatch: (ts: string[]) => slow(ts.map(t => bagOfWords(t))),
    })
  }

  async function seed(): Promise<{ hit: string }> {
    s = await tempStore({ embedder: 'bag-of-words' })
    expect(process.env.PLUR_RECALL_DEADLINE_MS, 'precondition: no deadline override is set, so the normal deadline applies').toBeUndefined()
    const hit = await s.plur.learn('Rotate the staging database password every quarter', { scope: 'global' })
    await s.plur.learn('Lunch orders go in the shared kitchen sheet', { scope: 'global' })
    await s.plur.learn('The office printer lives on the third floor', { scope: 'global' })
    return { hit: hit.id }
  }

  it('slow model: keyword results arrive within the normal deadline and the answer says the meaning part was cut short', async () => {
    const { hit } = await seed()
    useSlowEmbedder()

    const started = Date.now()
    const result = await s.plur.recallHybridWithMeta('staging database password', { limit: 5 })
    const elapsed = Date.now() - started

    expect(elapsed, `expected an answer within the normal ${NORMAL_DEADLINE_MS} ms deadline (+${MARGIN_MS} ms margin) although the model takes ${SLOW_MS} ms; it took ${elapsed} ms`)
      .toBeLessThan(NORMAL_DEADLINE_MS + MARGIN_MS)
    const ids = result.engrams.map(e => e.id)
    expect(ids, `expected the keyword match ${hit} in the answer; got ${JSON.stringify(ids)}`).toContain(hit)
    expect(result.mode, `expected the answer to say it was not a full meaning search; it said mode "${result.mode}"`)
      .not.toBe('hybrid')
    expect(String(result.degraded_reason ?? ''), `expected the answer to say the meaning part ran out of time; degraded_reason was ${JSON.stringify(result.degraded_reason)}`)
      .toMatch(/deadline/)
    expect(typeof result.embedderError === 'string' && result.embedderError.length > 0,
      `expected a plain reason for the cut-short search; embedderError was ${JSON.stringify(result.embedderError)}`).toBe(true)
    expect(result.results_complete, 'expected the answer to say its results are not complete').toBe(false)
  })

  it('control: a fast model gives a full meaning search on the same store', async () => {
    const { hit } = await seed()
    useEmbedder('bag-of-words')

    const result = await s.plur.recallHybridWithMeta('staging database password', { limit: 5 })
    const ids = result.engrams.map(e => e.id)
    expect(ids, `control: expected ${hit} in the answer; got ${JSON.stringify(ids)}`).toContain(hit)
    expect(result.mode, `control: a fast model should give a full meaning search; mode was "${result.mode}" (${result.embedderError})`).toBe('hybrid')
    expect(result.degraded_reason, 'control: a fast model should not be reported as cut short').toBeUndefined()
    expect(result.results_complete, 'control: a fast model should give complete results').toBe(true)
  })
})
