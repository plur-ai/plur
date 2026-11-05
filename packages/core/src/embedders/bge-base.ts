/**
 * BGE-base adapter: BAAI/bge-base-en-v1.5 via @huggingface/transformers.
 *
 * 768-dim, ~110M params, ~440MB on disk. MIT.
 * Slightly better retrieval quality than bge-small at roughly 3x the compute.
 */
import { makeTransformersAdapter } from './transformers-base.js'
import type { EmbedderAdapter } from './types.js'
import { BGE_SEARCH_INSTRUCTION } from './bge-small.js'

export const BGE_BASE_MODEL_ID = 'Xenova/bge-base-en-v1.5'

export function makeBgeBaseAdapter(): EmbedderAdapter {
  return makeTransformersAdapter({
    name: 'bge-base',
    dim: 768,
    modelId: BGE_BASE_MODEL_ID,
    pooling: 'cls',
    normalize: true,
    dtype: 'fp32',
    searchInstruction: BGE_SEARCH_INSTRUCTION,
  })
}
