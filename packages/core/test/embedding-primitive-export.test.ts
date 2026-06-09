import { describe, it, expect } from 'vitest'
import { embed, EMBED_DIM, embedderStatus, cosineSimilarity } from '../src/index.js'

/**
 * Public embedding-primitive contract (#289).
 *
 * Alternative store backends that persist vectors must be able to compute
 * embeddings identically to core's hybrid search. That requires the embedder
 * and its dimension to be part of the package's public API (re-exported from
 * `src/index.ts`, which `dist/index.js` — `@plur-ai/core`'s entry — is built
 * from) rather than internal to `embeddings.ts`.
 *
 * These assertions are intentionally model-free (no ~130MB BGE download, no
 * ONNX init) so they run in any CI environment. The dimension is enforced
 * against the *live* model by the one-time assertion inside `embed()`
 * (see embeddings.ts) rather than here.
 */
describe('embedding primitive public API (#289)', () => {
  it('re-exports the committed contract: embed, EMBED_DIM, embedderStatus', () => {
    expect(typeof embed).toBe('function')
    expect(typeof embedderStatus).toBe('function')
    expect(typeof EMBED_DIM).toBe('number')
  })

  it('re-exports cosineSimilarity as a convenience', () => {
    expect(typeof cosineSimilarity).toBe('function')
  })

  it('EMBED_DIM is the bge-small-en-v1.5 dimension (384)', () => {
    expect(EMBED_DIM).toBe(384)
  })

  it('cosineSimilarity computes dot product on normalized vectors', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([1, 0, 0])
    const c = new Float32Array([0, 1, 0])
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6)
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 6)
  })
})
