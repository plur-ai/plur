/**
 * OpenAI `text-embedding-3-large` adapter — Sprint 0 PR 5 (#219),
 * hardened for production reembed runs in #269.
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
 *
 * Hardening (#269, iter-1 audit M-9):
 *   - AbortController timeout so a hung request can't block a migration
 *   - 429/503 retry with Retry-After respect + exponential backoff fallback
 *   - embedBatch chunks requests to the API's input-array and token caps
 *   - inputs over the 8191-token limit are truncated pre-request so one long
 *     statement can't HTTP-400 a 10k-engram reembed run halfway through
 */
import { logger } from '../logger.js'
import type { EmbedderAdapter } from './types.js'

export const OPENAI_3_LARGE_MODEL_ID = 'text-embedding-3-large'
export const OPENAI_3_LARGE_DIM = 3072
/** Hard API limit on tokens per input — oversize inputs return HTTP 400. */
export const OPENAI_3_LARGE_MAX_INPUT_TOKENS = 8191

const ENDPOINT = 'https://api.openai.com/v1/embeddings'

/** API cap on entries in one `input` array. */
const DEFAULT_MAX_BATCH_SIZE = 2048
/** API cap on total tokens per request, summed across inputs. */
const DEFAULT_MAX_TOKENS_PER_REQUEST = 300_000
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_MS = 1_000
/** Cap a server-provided Retry-After so a bad header can't stall a migration. */
const MAX_RETRY_AFTER_MS = 60_000

/** Statuses worth retrying: rate limit + transient overload. */
const RETRYABLE_STATUS = new Set([429, 503])

/** Same 4-chars-per-token heuristic used by inject.ts token budgeting. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface OpenAI3LargeOptions {
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number
  /** Retries after the first attempt for 429/503 responses (default 3). */
  maxRetries?: number
  /** Backoff base when Retry-After is absent (default 1s, doubles per retry). */
  retryBaseMs?: number
  /** Max inputs per POST (default 2048 — the API's array cap). */
  maxBatchSize?: number
  /** Estimated-token budget per POST (default 300k — the API's request cap). */
  maxTokensPerRequest?: number
}

type ResolvedOptions = Required<OpenAI3LargeOptions>

/**
 * Parse a Retry-After header: delta-seconds or HTTP-date per RFC 9110.
 * Returns milliseconds clamped to [0, MAX_RETRY_AFTER_MS], or null when the
 * header is absent/unparseable (callers fall back to exponential backoff).
 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const secs = Number(header)
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(secs * 1000, MAX_RETRY_AFTER_MS)
  }
  const dateMs = Date.parse(header)
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_AFTER_MS)
  }
  return null
}

function readApiKey(): string {
  const key = process.env.OPENAI_API_KEY
  if (!key || key.trim() === '') {
    throw new Error(
      'openai-3-large embedder requires OPENAI_API_KEY. Set the env var (export OPENAI_API_KEY=sk-...) or unset PLUR_EMBEDDER to fall back to the local default.',
    )
  }
  return key
}

/**
 * Truncate an input estimated to exceed the API's per-input token limit.
 * The head of a long statement still embeds usefully; killing an entire
 * reembed migration over one oversize engram does not.
 */
function clampToTokenLimit(text: string, index: number): string {
  const maxChars = OPENAI_3_LARGE_MAX_INPUT_TOKENS * 4
  if (text.length <= maxChars) return text
  logger.warning(
    `[openai-3-large] input ${index} is ~${estimateTokens(text)} tokens (limit ${OPENAI_3_LARGE_MAX_INPUT_TOKENS}) — truncating to avoid an HTTP 400 mid-batch`,
  )
  return text.slice(0, maxChars)
}

function parseVectors(json: unknown, expected: number): Float32Array[] {
  const data = (json as { data?: Array<{ embedding: number[] | string }> }).data
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error(
      `openai-3-large embed returned ${data?.length ?? 'no'} vectors for ${expected} inputs`,
    )
  }
  return data.map((row, i) => {
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

/** One POST with timeout + 429/503 retry. `texts` must fit in one request. */
async function postEmbed(texts: string[], opts: ResolvedOptions): Promise<Float32Array[]> {
  const key = readApiKey()
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    let res: Response
    try {
      res = await opts.fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: OPENAI_3_LARGE_MODEL_ID,
          input: texts,
        }),
        signal: controller.signal,
      })
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`openai-3-large embed timed out after ${opts.timeoutMs}ms`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
    if (res.ok) {
      return parseVectors(await res.json(), texts.length)
    }
    const body = await res.text().catch(() => '')
    if (RETRYABLE_STATUS.has(res.status) && attempt < opts.maxRetries) {
      const delay =
        parseRetryAfterMs(res.headers.get('retry-after')) ?? opts.retryBaseMs * 2 ** attempt
      logger.warning(
        `[openai-3-large] HTTP ${res.status} — retrying in ${delay}ms (attempt ${attempt + 1}/${opts.maxRetries})`,
      )
      await new Promise((r) => setTimeout(r, delay))
      continue
    }
    throw new Error(
      `openai-3-large embed failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    )
  }
}

/** Split clamped inputs into request-sized chunks (array cap + token budget). */
function chunkInputs(texts: string[], opts: ResolvedOptions): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let currentTokens = 0
  for (const text of texts) {
    const cost = estimateTokens(text)
    if (
      current.length > 0 &&
      (current.length >= opts.maxBatchSize || currentTokens + cost > opts.maxTokensPerRequest)
    ) {
      chunks.push(current)
      current = []
      currentTokens = 0
    }
    current.push(text)
    currentTokens += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export function makeOpenAI3LargeAdapter(options?: OpenAI3LargeOptions): EmbedderAdapter {
  const opts: ResolvedOptions = {
    fetch: options?.fetch ?? ((...args) => globalThis.fetch(...args)),
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBaseMs: options?.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    maxBatchSize: options?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    maxTokensPerRequest: options?.maxTokensPerRequest ?? DEFAULT_MAX_TOKENS_PER_REQUEST,
  }
  return {
    name: 'openai-3-large',
    dim: OPENAI_3_LARGE_DIM,
    modelId: OPENAI_3_LARGE_MODEL_ID,
    async embed(text: string): Promise<Float32Array> {
      const [v] = await postEmbed([clampToTokenLimit(text, 0)], opts)
      return v
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return []
      const clamped = texts.map((t, i) => clampToTokenLimit(t, i))
      const out: Float32Array[] = []
      for (const chunk of chunkInputs(clamped, opts)) {
        out.push(...(await postEmbed(chunk, opts)))
      }
      return out
    },
  }
}
