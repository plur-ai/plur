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
      // Force the classic HF download path: the Xet transfer protocol truncates
      // ONNX model files in this stack (@huggingface/transformers 3.8.1),
      // producing corrupt models ("Protobuf parsing failed") that silently
      // degrade recall to fallback. Never use Xet. (#340)
      process.env.HF_HUB_DISABLE_XET ??= '1'
      const transformers = await import('@huggingface/transformers')

      // Let the caller place the model cache (#845).
      //
      // transformers.js v3 derives its cache directory from the PACKAGE
      // LOCATION (`<package>/.cache`) and reads no environment variable —
      // HF_HOME and TRANSFORMERS_CACHE are both ignored (see its src/env.js).
      // The only lever is `env.cacheDir`, set before the first pipeline() call,
      // and that call site is HERE, in core. So for any consumer installing
      // from npm the model lives inside node_modules, and every `npm ci`
      // destroys it: a server running from a git checkout re-downloaded ~128MB
      // per deploy, and an air-gapped host could not work at all.
      //
      // That failure is quiet, which is what made it expensive. embed()
      // returning null is a DELIBERATE degradation — hybrid recall drops to
      // BM25-only and new records are written without vectors, with nothing
      // raised. enterprise#662 reached production that way: every "hybrid"
      // recall on a containerised deployment had been BM25-only since the
      // feature shipped, and not one engram had ever been embedded.
      //
      // Precedence: explicit PLUR var, then the HF convention (honoured here
      // even though the library ignores it, because operators reasonably expect
      // it to work), then the library default.
      const cacheDir = process.env.PLUR_MODEL_CACHE_DIR || process.env.HF_HOME
      if (cacheDir) {
        // Assigned before pipeline() — after the first load the value is
        // already baked into the resolved paths and changing it does nothing.
        ;(transformers as { env?: { cacheDir?: string } }).env!.cacheDir = cacheDir
      }

      return transformers.pipeline('feature-extraction', modelId, dtype ? { dtype } : undefined)
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
