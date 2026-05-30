/**
 * BGE-base adapter — BAAI/bge-base-en-v1.5 via @huggingface/transformers.
 *
 * 768-dim, ~110M params, ~440MB on disk. MIT.
 *
 * The larger BGE sibling. Roughly +1.5pp MTEB over bge-small at ~3x the
 * compute cost. Included so the bake-off can pin whether the dim bump is
 * worth the latency/RAM hit on LongMemEval.
 */
import { makeTransformersAdapter } from './transformers-base.js'
import type { EmbedderAdapter } from './types.js'

export const BGE_BASE_MODEL_ID = 'Xenova/bge-base-en-v1.5'

export function makeBgeBaseAdapter(): EmbedderAdapter {
  return makeTransformersAdapter({
    name: 'bge-base',
    dim: 768,
    modelId: BGE_BASE_MODEL_ID,
    pooling: 'cls',
    normalize: true,
    dtype: 'fp32',
  })
}
