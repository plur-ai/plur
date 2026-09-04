/**
 * Cross-encoder rerankers via @huggingface/transformers — one adapter factory,
 * two shipped models.
 *
 * Both models drive AutoTokenizer + AutoModelForSequenceClassification directly
 * rather than pipeline('text-classification', ...): the rerank input is the
 * bert-style sentence pair ([CLS] query [SEP] document [SEP]), which the
 * text-classification pipeline does not expose first-class. The single-logit
 * output is the relevance score — a raw logit, not a probability. Higher =
 * more relevant; the absolute scale is model-specific and only the ordering
 * matters for the recall path, so nothing thresholds on the raw value.
 *
 * Lazy load: tokenizer + model are loaded on first score call and cached
 * per model id, so repeated PLUR sessions in the same process share the
 * weight memory.
 *
 * The two factories used to be two ~120-line files that differed only in the
 * model id and the adapter name (2026-09 audit). Keeping them as one module
 * means a fix to the tokenization or logit handling cannot land in one model
 * and miss the other.
 *
 * ## bge-reranker-v2-m3
 * BAAI/bge-reranker-v2-m3. Multilingual (100+ languages), state-of-the-art on
 * MTEB reranking benchmarks. MIT license. ~568M params; q8-quantized weights
 * land around 280-310 MB on disk. Seconds per query on CPU — offline/batch
 * quality tier, not the agent hot path.
 *
 * We pin to the onnx-community mirror — the Xenova mirror returns 401 as of
 * 2026-05 (gated behind a Hugging Face login). onnx-community publishes the
 * same q8-quantized weights under the Apache-2.0 license with the documented
 * `xenova/transformers.js` ONNX layout.
 *
 * ## ms-marco-minilm-l6
 * cross-encoder/ms-marco-MiniLM-L-6-v2 (Xenova ONNX conversion). The tiny-tier
 * reranker (#451, #220): ~22.7M params, 25x smaller than bge-reranker-v2-m3,
 * English-only, trained on MS MARCO passage ranking, Apache-2.0, ~23 MB on
 * disk. Reranks 10-50 candidates in tens of milliseconds on CPU while keeping
 * most of the quality lift over plain RRF fusion; benchmarked head-to-head in
 * issue #451.
 */
import type { RerankerAdapter } from './types.js'

export const BGE_RERANKER_V2_M3_MODEL_ID = 'onnx-community/bge-reranker-v2-m3-ONNX'
export const MS_MARCO_MINILM_L6_MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2'

type Dtype = 'q8' | 'fp32'

interface LoadedPipeline {
  tokenizer: {
    (
      text: string | string[],
      opts?: {
        text_pair?: string | string[]
        padding?: boolean
        truncation?: boolean
        return_tensor?: boolean
      },
    ): Promise<Record<string, unknown>> | Record<string, unknown>
  }
  model: {
    (inputs: Record<string, unknown>): Promise<{ logits: { data: Float32Array | number[]; dims: number[] } }>
  }
}

/** One in-flight/loaded pipeline per model id — the cache that makes load lazy and shared. */
const pending = new Map<string, Promise<LoadedPipeline>>()

async function loadPipeline(modelId: string, dtype: Dtype): Promise<LoadedPipeline> {
  let p = pending.get(modelId)
  if (!p) {
    p = (async () => {
      // Xet-backed downloads fail in some sandboxes; the classic HTTP path
      // works everywhere transformers.js does.
      process.env.HF_HUB_DISABLE_XET ??= '1'
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers')
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(modelId),
        AutoModelForSequenceClassification.from_pretrained(modelId, { dtype } as { dtype: Dtype }),
      ])
      return {
        tokenizer: tokenizer as unknown as LoadedPipeline['tokenizer'],
        model: model as unknown as LoadedPipeline['model'],
      }
    })()
    pending.set(modelId, p)
  }
  return await p
}

/**
 * Drop every cached pipeline so the next score call retries the model load
 * from scratch (e.g. after purging a corrupt HF cache, #341).
 */
export function _resetCrossEncoderCaches(): void {
  pending.clear()
}

/**
 * Build a cross-encoder adapter for `modelId`. `name` is the value reported by
 * `RerankerAdapter.name` and matched by `RERANKER_NAMES`.
 */
export function makeTransformersCrossEncoder(name: string, modelId: string, dtype: Dtype = 'q8'): RerankerAdapter {
  async function scoreBatch(query: string, documents: string[]): Promise<number[]> {
    if (documents.length === 0) return []
    const pipe = await loadPipeline(modelId, dtype)
    const queries = documents.map(() => query)
    const inputs = (await pipe.tokenizer(queries, {
      text_pair: documents,
      padding: true,
      truncation: true,
      return_tensor: true,
    })) as Record<string, unknown>
    const output = await pipe.model(inputs)
    const logits = output.logits
    const data = logits.data instanceof Float32Array ? logits.data : new Float32Array(logits.data)
    // Single-label head: logits are [batch, 1]. Read the first (only) label
    // per row; a multi-label head would still yield a monotone relevance signal
    // from column 0 for these models.
    const numLabels = logits.dims[logits.dims.length - 1] ?? 1
    const batch = documents.length
    const scores: number[] = new Array(batch)
    for (let i = 0; i < batch; i++) {
      scores[i] = data[i * numLabels]
    }
    return scores
  }

  async function score(query: string, document: string): Promise<number> {
    const out = await scoreBatch(query, [document])
    return out[0]
  }

  return { name, modelId, score, scoreBatch }
}

export function makeBgeRerankerV2M3Adapter(): RerankerAdapter {
  return makeTransformersCrossEncoder('bge-reranker-v2-m3', BGE_RERANKER_V2_M3_MODEL_ID)
}

export function makeMsMarcoMiniLmL6Adapter(): RerankerAdapter {
  return makeTransformersCrossEncoder('ms-marco-minilm-l6', MS_MARCO_MINILM_L6_MODEL_ID)
}
