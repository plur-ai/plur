/**
 * EmbeddingGemma adapter — Google EmbeddingGemma-300M via @huggingface/transformers.
 *
 * 768-dim native (with Matryoshka tiers at 512/256/128), ~300M params, ~300MB
 * on disk with int8/q8 quantisation. Apache 2.0.
 *
 * Model id: onnx-community/embeddinggemma-300m-ONNX — the community ONNX
 * conversion. The ONNX graph ships two outputs: last_hidden_state [B,T,768]
 * and sentence_embedding [B,768]. The sentence_embedding output is the
 * complete official stack: mean pooling + Dense(768→3072) + Dense(3072→768)
 * + L2 normalisation (from the sentence-transformers modules.json). The old
 * adapter fed last_hidden_state through a JS-side mean pooling, skipping the
 * two Dense projection layers — the resulting vectors had cos ≈ −0.003 against
 * sentence_embedding and were in a different space from all published figures.
 *
 * Fix (#483): load the model via AutoModel (not the feature-extraction pipeline)
 * and read sentence_embedding directly. The adapter name is 'embedding-gemma@graph-mcprefix'
 * (not 'embedding-gemma') so any caches built with wrong-space vectors are
 * automatically detected as a name mismatch and rebuilt by embeddings.ts.
 *
 * Role prefixes: EmbeddingGemma is trained with asymmetric prefixes per its
 * model card — "task: search result | query: " for search queries and
 * "title: none | text: " for stored documents. (The earlier "query: "/"passage: "
 * pair was the E5 convention, NOT EmbeddingGemma's — #483.) Callers pass
 * role='query' for search; omitting role defaults to the document prefix.
 *
 * Disk cost: q8 weights ~ 300 MB. We use q8 to match published EmbeddingGemma
 * benchmark numbers and keep first-run download manageable.
 */
import type { EmbedderAdapter, EmbedRole } from './types.js'

export const EMBEDDING_GEMMA_MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX'
const DIM = 768

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
      // Xet transfer protocol silently truncates ONNX files (#340). Disable it.
      process.env.HF_HUB_DISABLE_XET ??= '1'
      const { AutoTokenizer, AutoModel } = await import('@huggingface/transformers')
      const tokenizer = (await AutoTokenizer.from_pretrained(EMBEDDING_GEMMA_MODEL_ID)) as unknown as Tok
      const model = (await AutoModel.from_pretrained(EMBEDDING_GEMMA_MODEL_ID, { dtype: 'q8' })) as unknown as Mdl
      return { tokenizer, model }
    })()
  }
  return loaded
}

/** Reset the model + tokenizer cache. Test-only. */
export function _resetEmbeddingGemmaCache(): void {
  loaded = null
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
    // auto-invalidates any cached vectors built in a different space. '@graph'
    // marked the switch off JS-side pooling; '-mcprefix' marks the #483 switch to
    // the model-card role prefixes (old "query:"/"passage:" vectors are a
    // different space and must be rebuilt).
    name: 'embedding-gemma@graph-mcprefix',
    dim: DIM,
    modelId: EMBEDDING_GEMMA_MODEL_ID,
    embed: embedOne,
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = []
      for (const t of texts) out.push(await embedOne(t))
      return out
    },
  }
}
