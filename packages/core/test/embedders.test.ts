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
 *     embed(text: string): Promise<Float32Array>
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
import { describe, it, expect } from 'vitest'
import {
  getEmbedder,
  EMBEDDER_NAMES,
  type EmbedderAdapter,
  type EmbedderName,
} from '../src/embedders/index.js'

const NETWORK = process.env.PLUR_EMBEDDER_NETWORK_TESTS === '1'

/** Expected metadata per adapter — checked even when the network is offline. */
const EXPECTED: Record<EmbedderName, { dim: number; modelId: string }> = {
  'minilm': { dim: 384, modelId: 'Xenova/all-MiniLM-L6-v2' },
  'bge-small': { dim: 384, modelId: 'Xenova/bge-small-en-v1.5' },
  'bge-base': { dim: 768, modelId: 'Xenova/bge-base-en-v1.5' },
  'embedding-gemma': { dim: 768, modelId: 'onnx-community/embeddinggemma-300m-ONNX' },
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
        expect(adapter.name).toBe(name)
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
})
