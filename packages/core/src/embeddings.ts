import type { Engram } from './schemas/engram.js'
import { engramSearchText } from './fts.js'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { atomicWrite } from './sync.js'

/**
 * Embedding-based semantic search for engrams.
 *
 * Uses @huggingface/transformers (ONNX runtime) for local embeddings, routed
 * through the embedder factory at packages/core/src/embedders/index.ts.
 *
 * Default model: BGE-small-en-v1.5 (MIT, 384d, ~130 MB on disk q8).
 * EmbeddingGemma was briefly promoted to default in Sprint 0 PR 5 (#219) but
 * the iter-1 audit (B-2) reverted the default pending Phase C LongMemEval-S
 * evidence — see docs/audit/sprint-0/iter-1-gaps-consolidated.md and
 * docs/benchmarks/embedder-bake-off-2026-05.md. EmbeddingGemma is still
 * available via PLUR_EMBEDDER=embedding-gemma. Opt-in API tier:
 * `openai-3-large` (text-embedding-3-large, 3072d) — requires OPENAI_API_KEY.
 *
 * Embeddings are cached per-engram using content hashing to avoid
 * re-computation on subsequent searches. The cache file is stamped with the
 * active embedder name + dim; on mismatch the cache is invalidated and
 * rebuilt (Sprint 0 iter-2 B-1, closes RC-3).
 */

// Lazy-loaded pipeline — only initialized when first needed
let embedPipeline: any = null
let lastLoadError: string | null = null
// Allow callers to reset the cached failure state (e.g. after fixing model
// download). Setting transformersUnavailable=true here is a soft signal —
// getEmbedder() retries on every call until success.
let transformersUnavailable = false

// Opt-out: when true, getEmbedder() short-circuits to null without attempting
// a model load. Configurable via PLUR_DISABLE_EMBEDDINGS env var (read at
// import time) or PlurConfigSchema.embeddings.enabled=false (wired by Plur
// constructor via setEmbeddingsEnabled). Default: enabled.

/**
 * Parse the PLUR_DISABLE_EMBEDDINGS env var. Returns a human-readable
 * disabled-reason when the variable indicates opt-out, or null when
 * embeddings should remain enabled. Exported for unit testing — the
 * module-level capture happens once at import time and cannot be retested
 * from within the same process.
 *
 * Accepts truthy spellings: "1", "true", "yes" (case-insensitive). Any
 * other value (including unset, "0", "false", "") leaves embeddings enabled.
 */
export function readDisabledFromEnv(env: Record<string, string | undefined>): string | null {
  const raw = env.PLUR_DISABLE_EMBEDDINGS
  if (!raw) return null
  const normalized = raw.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return 'embeddings disabled by PLUR_DISABLE_EMBEDDINGS env var'
  }
  return null
}

const ENV_DISABLED_REASON = readDisabledFromEnv(process.env)
let embeddingsDisabled = ENV_DISABLED_REASON !== null
let disabledReason: string | null = ENV_DISABLED_REASON

export interface EmbedderStatus {
  available: boolean
  loaded: boolean
  lastError: string | null
  /** True when embeddings are explicitly disabled by user (env var or config). */
  disabled: boolean
  /** Human-readable reason when disabled is true; null otherwise. */
  disabledReason: string | null
}

/** Inspect embedder state without forcing a load. Used by `plur doctor`. */
export function embedderStatus(): EmbedderStatus {
  return {
    available: !embeddingsDisabled && !transformersUnavailable,
    loaded: embedPipeline !== null,
    lastError: lastLoadError,
    disabled: embeddingsDisabled,
    disabledReason,
  }
}

/**
 * Toggle embeddings on/off at runtime.
 *
 * Called by the Plur constructor when config.embeddings.enabled is false, and
 * available to host code that needs to flip state for tests or runtime
 * overrides. The PLUR_DISABLE_EMBEDDINGS env var takes precedence at import
 * time; calling setEmbeddingsEnabled(true) after that env var is set will
 * still re-enable.
 */
export function setEmbeddingsEnabled(enabled: boolean, reason?: string): void {
  embeddingsDisabled = !enabled
  disabledReason = enabled ? null : (reason ?? 'embeddings disabled by config')
  if (!enabled) {
    // Drop any loaded pipeline so the model can be unloaded by the GC.
    embedPipeline = null
  }
}

/** Reset cached error state — next embed() call will retry the load. */
export function resetEmbedder(): void {
  transformersUnavailable = false
  lastLoadError = null
  embedPipeline = null
}

async function getEmbedder() {
  if (embeddingsDisabled) return null
  if (embedPipeline) return embedPipeline
  // Soft retry: even if a previous load failed, try again on every call.
  // Loads are cheap once the model is cached; failures are rare and
  // transient (network, sandbox restrictions on first download).
  try {
    // Sprint 0 PR 4: route through the embedder factory so PLUR_EMBEDDER
    // controls which model is loaded. Default is bge-small (Sprint 0 iter-2
    // B-2 revert) when the env var is unset, so existing installs are
    // unchanged. EmbeddingGemma stays opt-in until Phase C produces evidence.
    const { getEmbedder: getAdapter, resolveEmbedderName } = await import('./embedders/index.js')
    const adapter = getAdapter(resolveEmbedderName())
    embedPipeline = adapter
    transformersUnavailable = false
    lastLoadError = null
    return embedPipeline
  } catch (err) {
    transformersUnavailable = true
    lastLoadError = err instanceof Error ? err.message : String(err)
    return null
  }
}

/** Generate embedding for a text string. Returns the active embedder's native dim, or null if unavailable. */
export async function embed(text: string): Promise<Float32Array | null> {
  const embedder = await getEmbedder()
  if (!embedder) return null
  // When the cached value is an EmbedderAdapter (PR 4 path) it has an .embed
  // method; the legacy code path stored the raw transformers pipeline. Branch
  // on shape so the swap is backward-compatible in tests that stub the cache.
  if (typeof embedder.embed === 'function') {
    try {
      return await embedder.embed(text)
    } catch (err) {
      transformersUnavailable = true
      lastLoadError = err instanceof Error ? err.message : String(err)
      embedPipeline = null
      return null
    }
  }
  const result = await embedder(text, { pooling: 'cls', normalize: true })
  return new Float32Array(result.data)
}

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // vectors are already normalized, so dot product = cosine similarity
}

/** Cache file for embeddings. */
interface EmbeddingCache {
  [engramId: string]: {
    hash: string
    embedding: number[]
  }
}

function loadCache(cachePath: string): EmbeddingCache {
  if (!existsSync(cachePath)) return {}
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8'))
  } catch {
    return {}
  }
}

function saveCache(cachePath: string, cache: EmbeddingCache): void {
  const dir = cachePath.substring(0, cachePath.lastIndexOf('/'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  atomicWrite(cachePath, JSON.stringify(cache))
}

function hashStatement(statement: string): string {
  return createHash('sha256').update(statement).digest('hex').slice(0, 16)
}

/**
 * Semantic search using embeddings.
 * Computes embedding for query, compares against cached engram embeddings.
 * Returns engrams sorted by cosine similarity (descending).
 */
export async function embeddingSearch(
  engrams: Engram[],
  query: string,
  limit: number,
  storagePath?: string,
): Promise<Engram[]> {
  if (engrams.length === 0) return []

  // Load embedding cache
  const cachePath = storagePath
    ? join(storagePath, '.embeddings-cache.json')
    : '.embeddings-cache.json'
  const cache = loadCache(cachePath)

  // Embed the query
  const queryEmbedding = await embed(query)
  if (!queryEmbedding) {
    // Embeddings unavailable — return empty (caller should fall back to BM25)
    return []
  }

  // Embed engrams (with caching)
  const similarities: Array<{ engram: Engram; score: number }> = []

  for (const engram of engrams) {
    const searchText = engramSearchText(engram)
    const hash = hashStatement(searchText)
    let engramEmbedding: Float32Array

    if (cache[engram.id]?.hash === hash) {
      // Cache hit
      engramEmbedding = new Float32Array(cache[engram.id].embedding)
    } else {
      // Cache miss — compute embedding from enriched text
      const emb = await embed(searchText)
      if (!emb) return [] // model unloaded mid-search
      engramEmbedding = emb
      cache[engram.id] = {
        hash,
        embedding: Array.from(engramEmbedding),
      }
    }

    const score = cosineSimilarity(queryEmbedding, engramEmbedding)
    similarities.push({ engram, score })
  }

  // Save updated cache
  saveCache(cachePath, cache)

  // Sort by similarity (descending) and return top N
  similarities.sort((a, b) => b.score - a.score)
  return similarities.slice(0, limit).map(s => s.engram)
}

/** Result with cosine similarity score attached. */
export interface SimilarityResult {
  engram: Engram
  score: number
}

/**
 * Semantic search using embeddings, returning scored results.
 * Identical to embeddingSearch but preserves cosine similarity scores.
 */
export async function embeddingSearchWithScores(
  engrams: Engram[],
  query: string,
  limit: number,
  storagePath?: string,
): Promise<SimilarityResult[]> {
  if (engrams.length === 0) return []

  // Load embedding cache
  const cachePath = storagePath
    ? join(storagePath, '.embeddings-cache.json')
    : '.embeddings-cache.json'
  const cache = loadCache(cachePath)

  // Embed the query
  const queryEmbedding = await embed(query)
  if (!queryEmbedding) {
    // Embeddings unavailable — return empty (caller should fall back to BM25)
    return []
  }

  // Embed engrams (with caching)
  const similarities: SimilarityResult[] = []

  for (const engram of engrams) {
    const searchText = engramSearchText(engram)
    const hash = hashStatement(searchText)
    let engramEmbedding: Float32Array

    if (cache[engram.id]?.hash === hash) {
      // Cache hit
      engramEmbedding = new Float32Array(cache[engram.id].embedding)
    } else {
      // Cache miss — compute embedding from enriched text
      const emb = await embed(searchText)
      if (!emb) return [] // model unloaded mid-search
      engramEmbedding = emb
      cache[engram.id] = {
        hash,
        embedding: Array.from(engramEmbedding),
      }
    }

    // Clamp to [0, 1] — cosine on normalized embeddings is [-1, 1] but
    // same-language text is practically always non-negative. Clamping ensures
    // dedup thresholds (>0.9, 0.7-0.9) work as documented.
    const rawScore = cosineSimilarity(queryEmbedding, engramEmbedding)
    const score = Math.max(0, Math.min(1, rawScore))
    similarities.push({ engram, score })
  }

  // Save updated cache
  saveCache(cachePath, cache)

  // Sort by similarity (descending) and return top N with scores
  similarities.sort((a, b) => b.score - a.score)
  return similarities.slice(0, limit)
}
