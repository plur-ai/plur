// REC-3: If the meaning model cannot load, I still get keyword results straight away, and the answer says the search was degraded.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, useEmbedder, type TempStore } from '../helpers/store.js'

describe('REC-3 a broken meaning model still gives keyword results and says so', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('hybrid search with a model that fails to load', async () => {
    // Memories are saved while the model works, so the store is ordinary.
    s = await tempStore({ embedder: 'bag-of-words' })
    const hit = await s.plur.learn('Rotate the staging database password every quarter', { scope: 'global' })
    await s.plur.learn('Lunch orders go in the shared kitchen sheet', { scope: 'global' })

    // Now the model cannot load: every embed call throws.
    useEmbedder('broken')
    const started = Date.now()
    const result = await s.plur.recallHybridWithMeta('staging database password', { limit: 5 })
    const elapsed = Date.now() - started

    const ids = result.engrams.map(e => e.id)
    expect(ids, `expected the keyword match ${hit.id} to come back although the model is broken; got ${JSON.stringify(ids)}`)
      .toContain(hit.id)
    expect(elapsed, `expected an answer straight away (under 5 s); it took ${elapsed} ms`).toBeLessThan(5000)
    expect(result.mode, `expected the answer to say the search was degraded; it said mode "${result.mode}"`)
      .toBe('hybrid-degraded')
    expect(typeof result.embedderError === 'string' && result.embedderError.length > 0,
      `expected the answer to say why it was degraded; the reason was ${JSON.stringify(result.embedderError)}`).toBe(true)
  })
})
