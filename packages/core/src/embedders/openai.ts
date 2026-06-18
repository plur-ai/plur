/**
 * OpenAI `text-embedding-3-large` adapter — Sprint 0 PR 5 (#219).
 *
 * 3072-dim embeddings via the OpenAI Embeddings API. Supports Matryoshka
 * truncation through the `dimensions` request param; we ship the full 3072d
 * by default to match the model's spec. Opt-in only — activated via
 * `PLUR_EMBEDDER=openai-3-large` plus a valid `OPENAI_API_KEY`.
 *
 * License / cost note: the OpenAI API is a paid commercial service governed by
 * OpenAI's terms (https://openai.com/policies). At the time of writing
 * `text-embedding-3-large` is billed per 1k tokens. Local users typically
 * stay on the default EmbeddingGemma adapter (Apache 2.0, no network) and
 * only flip to this adapter when they want the higher-end retrieval ceiling
 * and are happy to pay for it.
 *
 * Network shape: minimal `fetch` POST to `/v1/embeddings`. No SDK dependency
 * so the package stays free of optional peer deps and works in environments
 * that don't ship the `openai` package. If/when an SDK switch is wanted, the
 * adapter is a single-file swap.
 */
import type { EmbedderAdapter } from './types.js'

export const OPENAI_3_LARGE_MODEL_ID = 'text-embedding-3-large'
export const OPENAI_3_LARGE_DIM = 3072

const ENDPOINT = 'https://api.openai.com/v1/embeddings'

function readApiKey(): string {
  const key = process.env.OPENAI_API_KEY
  if (!key || key.trim() === '') {
    throw new Error(
      'openai-3-large embedder requires OPENAI_API_KEY. Set the env var (export OPENAI_API_KEY=sk-...) or unset PLUR_EMBEDDER to fall back to the local default.',
    )
  }
  return key
}

async function postEmbed(texts: string[]): Promise<Float32Array[]> {
  const key = readApiKey()
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: OPENAI_3_LARGE_MODEL_ID,
      input: texts,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `openai-3-large embed failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    )
  }
  const json = (await res.json()) as { data?: Array<{ embedding: number[] | string }> }
  if (!Array.isArray(json.data) || json.data.length !== texts.length) {
    throw new Error(
      `openai-3-large embed returned ${json.data?.length ?? 'no'} vectors for ${texts.length} inputs`,
    )
  }
  return json.data.map((row, i) => {
    const e = row.embedding
    if (!Array.isArray(e)) {
      throw new Error(`openai-3-large returned non-array embedding at index ${i}`)
    }
    if (e.length !== OPENAI_3_LARGE_DIM) {
      throw new Error(
        `openai-3-large returned ${e.length}-dim vector at index ${i}, expected ${OPENAI_3_LARGE_DIM}`,
      )
    }
    return Float32Array.from(e)
  })
}

export function makeOpenAI3LargeAdapter(): EmbedderAdapter {
  return {
    name: 'openai-3-large',
    dim: OPENAI_3_LARGE_DIM,
    modelId: OPENAI_3_LARGE_MODEL_ID,
    async embed(text: string): Promise<Float32Array> {
      const [v] = await postEmbed([text])
      return v
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return []
      return postEmbed(texts)
    },
  }
}
