/**
 * Shared base for @huggingface/transformers-backed adapters.
 *
 * Centralises the lazy pipeline load + the embed/embedBatch shape so each
 * concrete adapter only declares its model id, dim, pooling strategy, and
 * dtype. This is the path that handles MiniLM, BGE-small, BGE-base, and
 * (if the transformers runtime supports it) EmbeddingGemma.
 *
 * Each adapter caches its pipeline as a module-local Map so two instances of
 * the same name share the model instance — important because each load is
 * 100MB+ of WASM / ONNX setup.
 */
import type { EmbedderAdapter } from './types.js'

/** Pooling strategies supported by @huggingface/transformers feature-extraction. */
export type Pooling = 'cls' | 'mean' | 'none'

export interface TransformersAdapterConfig {
  name: string
  dim: number
  modelId: string
  pooling: Pooling
  /** ONNX weight dtype. 'fp32' is the safe default; 'q8' / 'fp16' may be model-specific. */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4'
  /** Whether to L2-normalise the output. BGE and MiniLM use this. */
  normalize?: boolean
}

const pipelineCache = new Map<string, Promise<unknown>>()

async function loadPipeline(modelId: string, dtype: TransformersAdapterConfig['dtype']): Promise<unknown> {
  const key = `${modelId}::${dtype ?? 'fp32'}`
  let pending = pipelineCache.get(key)
  if (!pending) {
    pending = (async () => {
      const { pipeline } = await import('@huggingface/transformers')
      return pipeline('feature-extraction', modelId, dtype ? { dtype } : undefined)
    })()
    pipelineCache.set(key, pending)
  }
  return await pending
}

/** Reset the shared pipeline cache. Test-only. */
export function _resetTransformersPipelineCache(): void {
  pipelineCache.clear()
}

export function makeTransformersAdapter(config: TransformersAdapterConfig): EmbedderAdapter {
  const pooling: Pooling = config.pooling
  const normalize = config.normalize ?? true

  async function embedOne(text: string): Promise<Float32Array> {
    const pipe = (await loadPipeline(config.modelId, config.dtype)) as (
      input: string | string[],
      opts: { pooling: Pooling; normalize: boolean },
    ) => Promise<{ data: Float32Array | number[] }>
    const result = await pipe(text, { pooling, normalize })
    const arr = result.data instanceof Float32Array ? result.data : new Float32Array(result.data)
    if (arr.length !== config.dim) {
      throw new Error(
        `Embedder "${config.name}" returned ${arr.length}-dim vector, expected ${config.dim}`,
      )
    }
    return arr
  }

  return {
    name: config.name,
    dim: config.dim,
    modelId: config.modelId,
    embed: embedOne,
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      // The transformers pipeline supports batched input, but in practice the
      // batched-output reshape depends on the runtime version. Iterating
      // gives stable order semantics — speed-critical batches are rare in
      // PLUR's recall path.
      const out: Float32Array[] = []
      for (const t of texts) out.push(await embedOne(t))
      return out
    },
  }
}
