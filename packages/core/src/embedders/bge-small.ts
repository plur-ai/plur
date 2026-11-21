/**
 * BGE-small adapter — BAAI/bge-small-en-v1.5 via @huggingface/transformers.
 *
 * 384-dim, ~33M params, ~130MB on disk. MIT.
 *
 * The same model embeddings.ts uses, exposed through the adapter interface so
 * it can be compared with other embedders.
 */
import { makeTransformersAdapter } from './transformers-base.js'
import type { EmbedderAdapter } from './types.js'

export const BGE_SMALL_MODEL_ID = 'Xenova/bge-small-en-v1.5'

/**
 * The BGE v1.5 model card's instruction for short-query-to-passage retrieval.
 * The model was trained with it on the query side only; adding it to the query
 * (never to stored text) is how the card says to search with these models.
 */
export const BGE_SEARCH_INSTRUCTION = 'Represent this sentence for searching relevant passages: '

export function makeBgeSmallAdapter(): EmbedderAdapter {
  return makeTransformersAdapter({
    name: 'bge-small',
    dim: 384,
    modelId: BGE_SMALL_MODEL_ID,
    pooling: 'cls',
    normalize: true,
    dtype: 'fp32',
    searchInstruction: BGE_SEARCH_INSTRUCTION,
  })
}
