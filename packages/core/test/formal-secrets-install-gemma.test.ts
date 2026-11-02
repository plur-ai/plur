/**
 * EmbeddingGemma reads the model's normalized `sentence_embedding` output and
 * never a mean-pool of hidden states; asking whether it is loaded never loads
 * or downloads it. The transformers stack is a stub: nothing touches the network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({ imports: 0, presence: 0 }))

vi.mock('../src/embedders/transformers-base.js', () => ({
  importTransformers: async () => {
    calls.imports++
    return {
      AutoTokenizer: { from_pretrained: async () => async () => ({}) },
      AutoModel: {
        from_pretrained: async () => async () => ({
          sentence_embedding: { data: Float32Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)) },
          last_hidden_state: { data: new Float32Array(768 * 4).fill(0.5), dims: [1, 4, 768] },
        }),
      },
    }
  },
  resolveLoadCacheDir: async () => null,
  modelPresence: () => { calls.presence++; return { present: false } },
  envOf: () => null,
  refuseMissingModelOffline: async () => {},
  localOnlyOptions: () => ({}),
}))

import { makeEmbeddingGemmaAdapter, _resetEmbeddingGemmaCache } from '../src/embedders/embedding-gemma.js'

beforeEach(() => {
  _resetEmbeddingGemmaCache()
  calls.imports = 0
  calls.presence = 0
})

describe('EmbeddingGemma output and load state', () => {
  it('returns the sentence_embedding output, not a pooled last_hidden_state', async () => {
    const v = await makeEmbeddingGemmaAdapter().embed('a memory')
    expect(v.length).toBe(768)
    expect(v[0]).toBe(1)
    expect(Array.from(v.slice(1)).every(x => x === 0)).toBe(true)
  })

  it('isLoaded never loads or downloads the model', async () => {
    const a = makeEmbeddingGemmaAdapter()
    expect(a.isLoaded!()).toBe(false)
    expect(a.isLoaded!()).toBe(false)
    expect(calls.imports).toBe(0)
    expect(calls.presence).toBe(0)
    await a.embed('x')
    expect(a.isLoaded!()).toBe(true)
    expect(calls.imports).toBe(1)
  })
})
