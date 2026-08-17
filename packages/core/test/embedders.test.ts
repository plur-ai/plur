/**
 * Embedder adapter contract tests — Sprint 0 PR 4 (feat/embedder-bake-off).
 *
 * The bake-off needs four ONNX adapters behind a uniform interface so the
 * benchmark harness can swap them via --embedder. The contract is:
 *
 *   interface EmbedderAdapter {
 *     readonly name: string
 *     readonly dim: number
 *     readonly modelId: string
 *     embed(text: string, role?: EmbedRole): Promise<Float32Array>
 *     embedBatch(texts: string[]): Promise<Float32Array[]>
 *   }
 *
 * Tests in this file exercise:
 *   - The factory returns the right adapter for each known name.
 *   - Each adapter reports name/dim/modelId matching the spec.
 *   - embed() returns a Float32Array of exactly `dim` floats.
 *   - embedBatch() returns N arrays in the same order as input.
 *   - Unknown embedder names throw.
 *
 * Model loads can hit the network on first use. Real end-to-end load tests
 * are gated behind PLUR_EMBEDDER_NETWORK_TESTS=1 so CI stays offline-safe.
 * Without the flag set, only metadata + factory routing are checked.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  getEmbedder,
  EMBEDDER_NAMES,
  type EmbedderAdapter,
  type EmbedderName,
} from '../src/embedders/index.js'
import { makeEmbeddingGemmaAdapter, _resetEmbeddingGemmaCache } from '../src/embedders/embedding-gemma.js'

const NETWORK = process.env.PLUR_EMBEDDER_NETWORK_TESTS === '1'

/** Expected metadata per adapter — checked even when the network is offline.
 *  adapterName overrides the expected `.name` when the adapter name differs from the factory key
 *  (e.g. 'embedding-gemma' factory key → 'embedding-gemma@graph-mcprefix' adapter name for cache busting). */
const EXPECTED: Record<EmbedderName, { dim: number; modelId: string; adapterName?: string }> = {
  'minilm': { dim: 384, modelId: 'Xenova/all-MiniLM-L6-v2' },
  'bge-small': { dim: 384, modelId: 'Xenova/bge-small-en-v1.5' },
  'bge-base': { dim: 768, modelId: 'Xenova/bge-base-en-v1.5' },
  // adapter.name is 'embedding-gemma@graph-mcprefix' — the @graph suffix busts caches
  // that hold wrong-space vectors from the old JS-side mean pooling (#483).
  'embedding-gemma': { dim: 768, modelId: 'onnx-community/embeddinggemma-300m-ONNX', adapterName: 'embedding-gemma@graph-mcprefix' },
  'openai-3-large': { dim: 3072, modelId: 'text-embedding-3-large' },
}

describe('EmbedderAdapter factory — metadata contract', () => {
  it('exports the five expected names', () => {
    expect(EMBEDDER_NAMES.sort()).toEqual(
      ['bge-base', 'bge-small', 'embedding-gemma', 'minilm', 'openai-3-large'],
    )
  })

  it('throws on unknown embedder names', () => {
    expect(() => getEmbedder('nope' as EmbedderName)).toThrow(/unknown embedder/i)
  })

  for (const name of EMBEDDER_NAMES) {
    describe(`adapter "${name}"`, () => {
      it('reports the expected name, dim, and modelId', () => {
        const adapter = getEmbedder(name)
        expect(adapter.name).toBe(EXPECTED[name].adapterName ?? name)
        expect(adapter.dim).toBe(EXPECTED[name].dim)
        expect(adapter.modelId).toBe(EXPECTED[name].modelId)
      })

      it('exposes embed and embedBatch as async functions', () => {
        const adapter = getEmbedder(name)
        expect(typeof adapter.embed).toBe('function')
        expect(typeof adapter.embedBatch).toBe('function')
      })
    })
  }
})

/**
 * Run the EmbeddingGemma adapter against a MOCKED transformers stack and return
 * the exact strings the adapter hands to the tokenizer (prefix + text) for each
 * embed call. Fully offline — no model download. Scoped via doMock + a
 * re-import so the network-gated live-load suite below stays on real
 * transformers (afterEach unmocks + resets the module registry).
 */
async function captureTokenizerInputs(
  calls: Array<[text: string, role?: 'query' | 'passage']>,
): Promise<string[]> {
  vi.resetModules()
  const inputs: string[] = []
  vi.doMock('@huggingface/transformers', () => ({
    AutoTokenizer: { from_pretrained: async () => (text: string) => { inputs.push(text); return {} } },
    AutoModel: { from_pretrained: async () => async () => ({ sentence_embedding: { data: new Float32Array(768) } }) },
  }))
  const { makeEmbeddingGemmaAdapter: mk } = await import('../src/embedders/embedding-gemma.js')
  const adapter = mk()
  for (const [text, role] of calls) await adapter.embed(text, role)
  return inputs
}

describe('EmbeddingGemma — role-aware prefix contract', () => {
  afterEach(() => {
    vi.doUnmock('@huggingface/transformers')
    vi.resetModules()
    _resetEmbeddingGemmaCache()
  })

  it('adapter name includes @graph cache-bust suffix', () => {
    const adapter = makeEmbeddingGemmaAdapter()
    expect(adapter.name).toBe('embedding-gemma@graph-mcprefix')
  })

  it('prepends a DIFFERENT tokenizer input for query vs passage (role plumbing is live, not a no-op)', async () => {
    // De-tautologized: the old test only asserted embed() returns a Promise —
    // true even if the role plumbing were deleted. Here we capture what actually
    // reaches the tokenizer and assert the two roles differ and that omitting
    // the role defaults to passage.
    const [q, p, omitted] = await captureTokenizerInputs([
      ['memory engram lifecycle', 'query'],
      ['memory engram lifecycle', 'passage'],
      ['memory engram lifecycle'],
    ])
    expect(q).not.toBe(p)          // deleting the role prefix would make these identical
    expect(omitted).toBe(p)        // omitted role → passage (documented default)
    expect(q).toContain('memory engram lifecycle')
    expect(p).toContain('memory engram lifecycle')
  })

  it('uses the EmbeddingGemma model-card role prefixes, not the E5 convention (#483 E1)', async () => {
    // The EmbeddingGemma model card requires 'task: search result | query: ' for
    // queries and 'title: none | text: ' for documents. The adapter
    // (embedding-gemma.ts:63) instead prepends the E5-convention 'query: ' /
    // 'passage: ' — the WRONG prefixes for this model, producing off-space
    // vectors that don't match any published EmbeddingGemma figure.
    // it.fails until #483 swaps in the model-card prefixes; flip to it() when green.
    const [q, p] = await captureTokenizerInputs([
      ['the raw text', 'query'],
      ['the raw text', 'passage'],
    ])
    expect(q).toBe('task: search result | query: the raw text')
    expect(p).toBe('title: none | text: the raw text')
  })
})

describe.skipIf(!NETWORK)('EmbedderAdapter — live model loads (PLUR_EMBEDDER_NETWORK_TESTS=1)', () => {
  // Live tests share state across the suite because each model is ~100MB+
  // and downloads can take a minute on cold caches.
  const LIVE_TIMEOUT = 180_000

  function check(adapter: EmbedderAdapter, vec: Float32Array): void {
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(adapter.dim)
    // Normalised embeddings have L2 norm ~= 1. Strict equality is brittle
    // across runtimes; check the rough magnitude.
    let norm = 0
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
    expect(Math.sqrt(norm)).toBeGreaterThan(0.5)
    expect(Math.sqrt(norm)).toBeLessThan(1.5)
  }

  // openai-3-large requires both NETWORK access and OPENAI_API_KEY. Skip it
  // from the live-load matrix — the OPENAI key is not a CI default and we
  // don't want to bill the OpenAI API on every PR. The bare-key error path
  // is exercised in embedder-default.test.ts instead.
  const LIVE_NAMES = EMBEDDER_NAMES.filter((n) => n !== 'openai-3-large')

  for (const name of LIVE_NAMES) {
    it(`"${name}" embeds a single string`, async () => {
      const adapter = getEmbedder(name)
      const vec = await adapter.embed('the quick brown fox jumps over the lazy dog')
      check(adapter, vec)
    }, LIVE_TIMEOUT)

    it(`"${name}" embeds a batch and preserves order`, async () => {
      const adapter = getEmbedder(name)
      const inputs = ['first sentence', 'second sentence', 'third sentence']
      const vecs = await adapter.embedBatch(inputs)
      expect(vecs.length).toBe(inputs.length)
      for (const v of vecs) check(adapter, v)
      // Sanity: the per-text embeddings should match what we get from embed().
      const single0 = await adapter.embed(inputs[0])
      // Cosine between batch[0] and single embed of the same text >= 0.99.
      let dot = 0
      let n1 = 0
      let n2 = 0
      for (let i = 0; i < single0.length; i++) {
        dot += single0[i] * vecs[0][i]
        n1 += single0[i] * single0[i]
        n2 += vecs[0][i] * vecs[0][i]
      }
      const cos = dot / (Math.sqrt(n1) * Math.sqrt(n2))
      expect(cos).toBeGreaterThan(0.99)
    }, LIVE_TIMEOUT)
  }

  it('"embedding-gemma" query vs passage embeddings differ', async () => {
    const adapter = getEmbedder('embedding-gemma')
    const text = 'memory engram about session lifecycle'
    const queryVec = await adapter.embed(text, 'query')
    const passageVec = await adapter.embed(text, 'passage')
    // Vectors should differ because of role prefixes
    let diff = 0
    for (let i = 0; i < queryVec.length; i++) diff += Math.abs(queryVec[i] - passageVec[i])
    expect(diff).toBeGreaterThan(0.01)
  }, LIVE_TIMEOUT)
})
