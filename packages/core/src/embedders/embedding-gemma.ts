/**
 * EmbeddingGemma adapter — Google EmbeddingGemma-300M via @huggingface/transformers.
 *
 * 768-dim native (with Matryoshka tiers at 512/256/128), ~300M params, ~300MB
 * on disk with int8/q8 quantisation. Apache 2.0.
 *
 * Model id: onnx-community/embeddinggemma-300m-ONNX — the community ONNX
 * conversion that ships with text/embed pipeline metadata. Recent
 * @huggingface/transformers releases (3.x) handle the gemma3_text model_type
 * via the feature-extraction pipeline. Pooling for EmbeddingGemma is the
 * "last token" / mean of the prompt+content tokens; we use mean here as the
 * pipeline's `mean` pooling matches the encoder semantics for this model.
 *
 * Disk cost (FYI): q8 weights ~ 300 MB, fp32 ~ 1.2 GB. We prefer q8 here so
 * the bake-off lines up with the published EmbeddingGemma benchmarks (which
 * report numbers at q8) and so first-time download stays within reach on
 * laptop bandwidth.
 *
 * If a future @huggingface/transformers version drops gemma3_text support
 * the adapter still loads — the lazy import will throw a descriptive error
 * at first embed() call rather than at module import time.
 */
import { makeTransformersAdapter } from './transformers-base.js'
import type { EmbedderAdapter } from './types.js'

export const EMBEDDING_GEMMA_MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX'

export function makeEmbeddingGemmaAdapter(): EmbedderAdapter {
  return makeTransformersAdapter({
    name: 'embedding-gemma',
    dim: 768,
    modelId: EMBEDDING_GEMMA_MODEL_ID,
    pooling: 'mean',
    normalize: true,
    // q8 picked to match the published EmbeddingGemma benchmark numbers and
    // keep the first-run download manageable (~300MB instead of ~1.2GB).
    dtype: 'q8',
  })
}
