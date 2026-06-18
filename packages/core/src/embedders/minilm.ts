/**
 * MiniLM adapter — sentence-transformers/all-MiniLM-L6-v2 via @huggingface/transformers.
 *
 * 384-dim, ~22M params, ~90MB on disk. Apache 2.0.
 *
 * Historical default referenced in the PLUR design docs; kept as a baseline
 * for the bake-off so we can measure how much BGE/EmbeddingGemma actually
 * buy us on LongMemEval.
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
