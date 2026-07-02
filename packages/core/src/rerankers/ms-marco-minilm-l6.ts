/**
 * MS MARCO MiniLM-L-6 adapter — cross-encoder/ms-marco-MiniLM-L-6-v2 via
 * @huggingface/transformers (Xenova ONNX conversion).
 *
 * The tiny-tier reranker (#451, #220). ~22.7M params — 25× smaller than
 * bge-reranker-v2-m3 (568M). English-only, trained on MS MARCO passage
 * ranking. Apache-2.0. q8-quantized weights are ~23 MB on disk.
 *
 * Why this tier exists: bge-reranker-v2-m3 measures seconds-per-query on
 * CPU, which is unusable on the agent hot path. The 4–25M cross-encoder
 * class (FlashRank/TinyBERT/MiniLM) reranks 10–50 candidates in tens of
 * milliseconds on the same hardware while keeping most of the quality lift
 * over plain RRF fusion. Benchmarked head-to-head in issue #451.
 *
 * Architecture: identical to the bge adapter — AutoTokenizer +
 * AutoModelForSequenceClassification driving the sentence-pair tokenization
 * ([CLS] query [SEP] document [SEP]) directly, single-logit relevance
 * output. Higher = more relevant; absolute scale is model-specific and only
 * the ordering matters for the recall path.
 *
 * Lazy load: tokenizer + model are loaded on first score call and cached
 * module-locally so repeated PLUR sessions in the same process share the
 * weight memory.
 */
import type { RerankerAdapter } from './types.js'

// Xenova's ONNX conversion of cross-encoder/ms-marco-MiniLM-L-6-v2 — the
// canonical transformers.js layout, resolves via the same AutoTokenizer +
// AutoModelForSequenceClassification path as the bge adapter.
export const MS_MARCO_MINILM_L6_MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2'

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
      return {
        tokenizer: tokenizer as unknown as LoadedPipeline['tokenizer'],
        model: model as unknown as LoadedPipeline['model'],
      }
    })()
  }
  return await pending
}

/** Reset the shared pipeline cache. Test-only. */
export function _resetMsMarcoMiniLmCache(): void {
  pending = null
}

export function makeMsMarcoMiniLmL6Adapter(): RerankerAdapter {
  const modelId = MS_MARCO_MINILM_L6_MODEL_ID
  const dtype: 'q8' | 'fp32' = 'q8'

  async function scoreBatch(query: string, documents: string[]): Promise<number[]> {
    if (documents.length === 0) return []
    const pipe = await loadPipeline(modelId, dtype)
    // Batch (query, document) pairs: `text` as a repeated query array and
    // `text_pair` as the document array — the bert tokenizer encodes each
    // pair into [CLS] query [SEP] document [SEP] in one go.
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
    // logits.dims is [batch, num_labels]. ms-marco-MiniLM-L-6-v2 uses
    // num_labels=1 (a single relevance scalar). We extract the first column.
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
    name: 'ms-marco-minilm-l6',
    modelId,
    score,
    scoreBatch,
  }
}
