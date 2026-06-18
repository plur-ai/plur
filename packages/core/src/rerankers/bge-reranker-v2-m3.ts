/**
 * BGE reranker v2-m3 adapter — BAAI/bge-reranker-v2-m3 via @huggingface/transformers.
 *
 * Cross-encoder reranker. Multilingual (100+ languages), state-of-the-art on
 * MTEB reranking benchmarks. MIT license. ~568M params; q8-quantized weights
 * land around 280-310 MB on disk.
 *
 * Architecture:
 *   AutoTokenizer + AutoModelForSequenceClassification path. We do not use
 *   pipeline('text-classification', ...) because the rerank token pair
 *   ([CLS] query [SEP] document [SEP]) is the bert-style sentence-pair
 *   tokenization, which the text-classification pipeline does not expose
 *   first-class. Driving the tokenizer + model directly gives us the
 *   single-logit output (the relevance score) cleanly.
 *
 * Output scale: a raw logit, not a sigmoid probability. Higher = more
 * relevant. Absolute values are not bounded but typically fall in [-10, +10].
 * Only the ordering matters for the recall path — we never threshold on the
 * raw value.
 *
 * Lazy load: tokenizer + model are loaded on first score call and cached
 * module-locally so repeated PLUR sessions in the same process share the
 * ~300 MB weight memory.
 */
import type { RerankerAdapter } from './types.js'

// Community ONNX conversion of BAAI/bge-reranker-v2-m3. We pin to the
// onnx-community mirror — the Xenova mirror returns 401 as of 2026-05
// (gated behind a Hugging Face login). onnx-community publishes the same
// q8-quantized weights under the Apache-2.0 license with the documented
// `xenova/transformers.js` ONNX layout, so the AutoTokenizer +
// AutoModelForSequenceClassification path resolves cleanly.
export const BGE_RERANKER_V2_M3_MODEL_ID = 'onnx-community/bge-reranker-v2-m3-ONNX'

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

let pending: Promise<LoadedPipeline> | null = null

async function loadPipeline(modelId: string, dtype: 'q8' | 'fp32'): Promise<LoadedPipeline> {
  if (!pending) {
    pending = (async () => {
      // Force the classic HF download path — the Xet transfer protocol truncates
      // ONNX downloads in this stack, corrupting the model ("Protobuf parsing
      // failed") so the reranker silently falls back to RRF order. Never use Xet. (#340)
      process.env.HF_HUB_DISABLE_XET ??= '1'
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers')
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(modelId),
        AutoModelForSequenceClassification.from_pretrained(modelId, { dtype } as { dtype: 'q8' | 'fp32' }),
      ])
      // The tokenizer and model are callable instances (they implement _call
      // via PretrainedMixin). We narrow them to the minimal callable shape
      // we need at the use site.
      return {
        tokenizer: tokenizer as unknown as LoadedPipeline['tokenizer'],
        model: model as unknown as LoadedPipeline['model'],
      }
    })()
  }
  return await pending
}

/** Reset the shared pipeline cache. Test-only. */
export function _resetBgeRerankerCache(): void {
  pending = null
}

export function makeBgeRerankerV2M3Adapter(): RerankerAdapter {
  const modelId = BGE_RERANKER_V2_M3_MODEL_ID
  const dtype: 'q8' | 'fp32' = 'q8'

  async function scoreBatch(query: string, documents: string[]): Promise<number[]> {
    if (documents.length === 0) return []
    const pipe = await loadPipeline(modelId, dtype)
    // The transformers.js tokenizer signature is (text, { text_pair, ... }).
    // To batch (query, document) pairs we pass `text` as a repeated query
    // array and `text_pair` as the document array — the bert tokenizer
    // encodes each pair into [CLS] query [SEP] document [SEP] in one go.
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
    // logits.dims is [batch, num_labels]. bge-reranker-v2-m3 uses num_labels=1
    // (a single relevance scalar). We extract the first column.
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

  return {
    name: 'bge-reranker-v2-m3',
    modelId,
    score,
    scoreBatch,
  }
}
