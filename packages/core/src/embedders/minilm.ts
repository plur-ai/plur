/**
 * MiniLM adapter — sentence-transformers/all-MiniLM-L6-v2 via @huggingface/transformers.
 *
 * 384-dim, ~22M params, ~90MB on disk. Apache 2.0.
 *
 * Kept as a baseline so the gain from BGE/EmbeddingGemma can be measured.
 */
import { makeTransformersAdapter } from './transformers-base.js'
import type { EmbedderAdapter } from './types.js'

export const MINILM_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

export function makeMiniLMAdapter(): EmbedderAdapter {
  return makeTransformersAdapter({
    name: 'minilm',
    dim: 384,
    modelId: MINILM_MODEL_ID,
    pooling: 'mean',
    normalize: true,
    dtype: 'fp32',
  })
}
