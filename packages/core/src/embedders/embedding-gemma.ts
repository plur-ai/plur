/**
 * EmbeddingGemma adapter — Google EmbeddingGemma-300M via @huggingface/transformers
 * (onnx-community/embeddinggemma-300m-ONNX, q8 ~300 MB, 768-dim, Apache 2.0).
 * Only the `sentence_embedding` output includes the official Dense layers and L2 norm,
 * so the model is loaded via AutoModel and that output read directly — never
 * mean-pool `last_hidden_state`.
 * Role prefixes per the model card: "task: search result | query: " for queries,
 * "title: none | text: " for documents (the default when `role` is omitted).
 */
import type { EmbedderAdapter, EmbedRole } from './types.js'
import { importTransformers, resolveLoadCacheDir, modelPresence, envOf, refuseMissingModelOffline, localOnlyOptions } from './transformers-base.js'

export const EMBEDDING_GEMMA_MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX'
const DIM = 768
/** q8 weights, as loaded below; external-data chunks come from its config. */
const GEMMA_WEIGHTS = 'model_quantized.onnx'

// Minimal callable shapes for the transformers.js tokenizer and model.
// We extract `sentence_embedding` from the ONNX graph directly — the pipeline
// API only surfaces `last_hidden_state` after JS-side pooling, which skips
// the two Dense post-pooling layers that are part of EmbeddingGemma's stack.
type Tok = (text: string, opts: { padding: boolean; truncation: boolean }) => Promise<unknown>
type Mdl = (inputs: unknown) => Promise<{ sentence_embedding: { data: Float32Array | number[] } }>

let loaded: Promise<{ tokenizer: Tok; model: Mdl }> | null = null

async function load(): Promise<{ tokenizer: Tok; model: Mdl }> {
  if (!loaded) {
    loaded = (async () => {
      // The Xet transfer protocol can silently truncate ONNX files, so disable it.
      process.env.HF_HUB_DISABLE_XET ??= '1'
      const transformers = await importTransformers()
      const { AutoTokenizer, AutoModel } = transformers as unknown as {
        AutoTokenizer: { from_pretrained: (id: string, o?: object) => Promise<unknown> }
        AutoModel: { from_pretrained: (id: string, o?: object) => Promise<unknown> }
      }
      // The cache the presence check looked in: the override when the model
      // is complete there, else the library default where an existing user
      // already has it.
      const cacheDir = await resolveLoadCacheDir(EMBEDDING_GEMMA_MODEL_ID, GEMMA_WEIGHTS)
      const env = envOf(transformers)
      if (cacheDir && env) env.cacheDir = cacheDir
      // Downloads off: a model missing from disk is refused before the
      // library is asked. The tokenizer loader looks up tokenizer_config.json
      // remotely without the options passed below, so `local_files_only`
      // alone would still reach the network.
      await refuseMissingModelOffline(EMBEDDING_GEMMA_MODEL_ID, GEMMA_WEIGHTS, 'embedding model')
      const offline = localOnlyOptions()
      const tokenizer = (await AutoTokenizer.from_pretrained(EMBEDDING_GEMMA_MODEL_ID, offline)) as unknown as Tok
      const model = (await AutoModel.from_pretrained(EMBEDDING_GEMMA_MODEL_ID, { dtype: 'q8', ...offline })) as unknown as Mdl
      gemmaLoaded = true
      return { tokenizer, model }
    })()
    // A failed load is not cached: the next call tries again.
    loaded.catch(() => { loaded = null })
  }
  return loaded
}

let gemmaLoaded = false

/** Reset the model + tokenizer cache. Test-only. */
export function _resetEmbeddingGemmaCache(): void {
  loaded = null
  gemmaLoaded = false
}

export function makeEmbeddingGemmaAdapter(): EmbedderAdapter {
  async function embedOne(text: string, role?: EmbedRole): Promise<Float32Array> {
    const prefix = role === 'query' ? 'task: search result | query: ' : 'title: none | text: '
    const { tokenizer, model } = await load()
    const inputs = await tokenizer(prefix + text, { padding: true, truncation: true })
    const outputs = await model(inputs)
    const raw = outputs.sentence_embedding.data
    const arr = raw instanceof Float32Array ? raw : new Float32Array(raw)
    if (arr.length !== DIM) {
      throw new Error(`EmbeddingGemma: expected ${DIM}-dim sentence_embedding, got ${arr.length}`)
    }
    return arr
  }

  return {
    // Suffix is a cache-space marker: embeddings.ts detects a name change and
    // invalidates cached vectors built in a different space. '@graph' marks
    // reading sentence_embedding from the graph; '-mcprefix' marks the
    // model-card role prefixes.
    name: 'embedding-gemma@graph-mcprefix',
    dim: DIM,
    modelId: EMBEDDING_GEMMA_MODEL_ID,
    embed: embedOne,
    // isLoaded: whether this process has loaded the model (never loads or
    // downloads it). modelPresent: whether the q8 weights are on disk.
    isLoaded: () => gemmaLoaded,
    modelPresent: () => modelPresence(EMBEDDING_GEMMA_MODEL_ID, GEMMA_WEIGHTS),
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = []
      for (const t of texts) out.push(await embedOne(t))
      return out
    },
  }
}
