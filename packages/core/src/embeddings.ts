import type { Engram } from './schemas/engram.js'
import type { EmbedRole } from './embedders/types.js'
import { engramSearchText } from './fts.js'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { atomicWrite } from './sync.js'
import { logger } from './logger.js'

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

/**
 * Dimension of the DEFAULT embedder (bge-small → 384). Exported for backward
 * compatibility with #289/#290.
 *
 * NOTE (#335): the embedder is pluggable via PLUR_EMBEDDER, so the dimension of
 * vectors this install actually produces is NOT fixed at this value —
 * bge-base / embedding-gemma are 768, openai-3-large is 3072. Any backend that
 * persists vectors MUST size its column to the **active** embedder's dim,
 * obtained from `activeEmbedderDim()` — NOT this constant. `EMBED_DIM` remains
 * only as the documented default; `activeEmbedderDim()` is the source of truth.
 */
export const EMBED_DIM = 384

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

/**
 * Test-only: install a stub adapter as the active embedder so tests can
 * exercise the embed()/activeEmbedderDim() contracts (#335) without a
 * model load. Mirrors rerankers' `_setCachedReranker`. Production code
 * never calls this; pair with `resetEmbedder()` in afterEach.
 */
export function _setCachedEmbedder(adapter: {
  name: string
  dim: number
  modelId: string
  embed(text: string): Promise<Float32Array>
  embedBatch(texts: string[]): Promise<Float32Array[]>
}): void {
  embedPipeline = adapter
  transformersUnavailable = false
  lastLoadError = null
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

/** Generate embedding for a text string. Returns the active embedder's native dim, or null if unavailable.
 *  Pass role='query' when embedding search terms; omit or pass 'passage' for stored engram text.
 *  Adapters that support asymmetric prefixes (EmbeddingGemma) use this to pick the correct space. */
export async function embed(text: string, role?: EmbedRole): Promise<Float32Array | null> {
  const embedder = await getEmbedder()
  if (!embedder) return null
  // When the cached value is an EmbedderAdapter (PR 4 path) it has an .embed
  // method; the legacy code path stored the raw transformers pipeline. Branch
  // on shape so the swap is backward-compatible in tests that stub the cache.
  if (typeof embedder.embed === 'function') {
    let vector: Float32Array | null
    try {
      vector = await embedder.embed(text, role)
    } catch (err) {
      transformersUnavailable = true
      lastLoadError = err instanceof Error ? err.message : String(err)
      embedPipeline = null
      return null
    }
    // Dimension-drift check (#290 generalized to the active embedder, #335):
    // the adapter declares its dim; if the live model produces a different
    // length, persisted vectors would silently corrupt. Throw OUTSIDE the catch
    // so it surfaces — degrading this to null would re-introduce the exact
    // silent drift the contract prevents.
    if (vector && typeof embedder.dim === 'number' && vector.length !== embedder.dim) {
      throw new Error(
        `Embedding dimension mismatch: embedder "${embedder.name}" declares ${embedder.dim} dims ` +
          `but produced ${vector.length}. The adapter's declared dim and its model must agree; ` +
          `vectors at the wrong dimension are incompatible with any store that persisted them.`,
      )
    }
    return vector
  }
  const result = await embedder(text, { pooling: 'cls', normalize: true })
  return new Float32Array(result.data)
}

/**
 * Get the active embedder's name+dim for cache stamping. Returns null when
 * embeddings are disabled or the embedder failed to load — callers should
 * skip cache writes in that case.
 */
async function getActiveEmbedderMeta(): Promise<{ name: string; dim: number } | null> {
  const embedder = await getEmbedder()
  if (!embedder) return null
  if (typeof embedder.name === 'string' && typeof embedder.dim === 'number') {
    return { name: embedder.name, dim: embedder.dim }
  }
  // Legacy pipeline shape — pre-PR-4 raw transformers pipeline (only seen in
  // older test stubs). Fall back to a sentinel that won't match any real
  // adapter, so the cache invalidates conservatively.
  return { name: 'legacy-pipeline', dim: 0 }
}

/**
 * The dimension of vectors the ACTIVE embedder produces (per PLUR_EMBEDDER).
 * This — not the `EMBED_DIM` default constant — is the value an external store
 * must size its vector column to, so it never drifts from what core writes
 * (#335). Returns null when embeddings are disabled or the embedder failed to
 * load (no vectors will be produced, so there is nothing to size to).
 */
export async function activeEmbedderDim(): Promise<number | null> {
  const meta = await getActiveEmbedderMeta()
  return meta && meta.dim > 0 ? meta.dim : null
}

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // vectors are already normalized, so dot product = cosine similarity
}

/** Cache entries indexed by engram ID. */
interface EmbeddingCacheEntries {
  [engramId: string]: {
    hash: string
    embedding: number[]
  }
}

/**
 * Cache file format (iter-2 audit B-1/B-3).
 *
 * v1 stamps the file with the active embedder's name + dim. On load, if the
 * meta header differs from the active embedder, the cache is invalidated and
 * rebuilt. Backward-compat: the pre-iter-2 flat-object format
 * `{ [engramId]: { hash, embedding } }` is detected by the absence of `meta`
 * and treated as a hard mismatch (no data loss — cache rebuilds from YAML on
 * the same call).
 */
interface EmbeddingCache {
  meta: {
    embedder_name: string
    embedder_dim: number
    version: number
  }
  entries: EmbeddingCacheEntries
}

const CACHE_VERSION = 1

/** Active-embedder cache state used by load/save invariants. */
function emptyCache(meta: { name: string; dim: number }): EmbeddingCache {
  return {
    meta: {
      embedder_name: meta.name,
      embedder_dim: meta.dim,
      version: CACHE_VERSION,
    },
    entries: {},
  }
}

/**
 * Load cache from disk. When the on-disk header doesn't match `active`, the
 * cache is invalidated (returns an empty cache stamped with the active
 * meta). Legacy flat-object files are also invalidated. Logs a one-line info
 * message on invalidation so users see why their first recall after a
 * config change takes longer.
 */
function loadCache(cachePath: string, active: { name: string; dim: number }): EmbeddingCache {
  if (!existsSync(cachePath)) return emptyCache(active)
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf8'))
    // Detect the v1 format. Legacy format has no `meta` field — invalidate.
    if (!raw || typeof raw !== 'object' || !raw.meta) {
      logger.info(`[embeddings] cache at ${cachePath} is in legacy format (no embedder meta) — rebuilding for active embedder ${active.name} (${active.dim}d).`)
      return emptyCache(active)
    }
    const meta = raw.meta as Partial<EmbeddingCache['meta']>
    if (meta.embedder_name !== active.name || meta.embedder_dim !== active.dim) {
      logger.info(`[embeddings] cache embedder mismatch — on-disk: ${meta.embedder_name} (${meta.embedder_dim}d), active: ${active.name} (${active.dim}d). Rebuilding cache.`)
      return emptyCache(active)
    }
    const entries = (raw.entries && typeof raw.entries === 'object') ? raw.entries as EmbeddingCacheEntries : {}
    return { meta: { embedder_name: meta.embedder_name!, embedder_dim: meta.embedder_dim!, version: meta.version ?? CACHE_VERSION }, entries }
  } catch {
    return emptyCache(active)
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

  // Resolve the active embedder before touching the cache so the cache load
  // can compare against the right meta header.
  const activeMeta = await getActiveEmbedderMeta()
  if (!activeMeta) return []

  // Load embedding cache (invalidates if the on-disk header doesn't match).
  const cachePath = storagePath
    ? join(storagePath, '.embeddings-cache.json')
    : '.embeddings-cache.json'
  const cache = loadCache(cachePath, activeMeta)

  // Embed the query
  const queryEmbedding = await embed(query, 'query')
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

    if (cache.entries[engram.id]?.hash === hash) {
      // Cache hit
      engramEmbedding = new Float32Array(cache.entries[engram.id].embedding)
    } else {
      // Cache miss — compute embedding from enriched text
      const emb = await embed(searchText)
      if (!emb) return [] // model unloaded mid-search
      engramEmbedding = emb
      cache.entries[engram.id] = {
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

  const activeMeta = await getActiveEmbedderMeta()
  if (!activeMeta) return []

  // Load embedding cache (invalidates if the on-disk header doesn't match).
  const cachePath = storagePath
    ? join(storagePath, '.embeddings-cache.json')
    : '.embeddings-cache.json'
  const cache = loadCache(cachePath, activeMeta)

  // Embed the query
  const queryEmbedding = await embed(query, 'query')
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

    if (cache.entries[engram.id]?.hash === hash) {
      // Cache hit
      engramEmbedding = new Float32Array(cache.entries[engram.id].embedding)
    } else {
      // Cache miss — compute embedding from enriched text
      const emb = await embed(searchText)
      if (!emb) return [] // model unloaded mid-search
      engramEmbedding = emb
      cache.entries[engram.id] = {
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

/**
 * Rebuild the JSON `.embeddings-cache.json` file under `storagePath` using
 * the active embedder. Used by `plur sync --reembed` when PGLite is NOT the
 * active backend so non-PGLite users have a real migration path on embedder
 * switches.
 *
 * `full=true` deletes the existing cache file before rebuilding (forces every
 * engram to be re-embedded from scratch). `full=false` invalidates the meta
 * header but lets matching entries survive — useful when only the cache file
 * format version bumped without an embedder change.
 *
 * Returns the count of engrams whose embedding was rewritten. Returns 0 and
 * `skipped: true` when embeddings are disabled or the embedder failed to
 * load. Closes RC-3 for the default (non-PGLite) user (Sprint 0 iter-2 B-3).
 */
export async function rebuildJsonCache(
  engrams: Engram[],
  storagePath: string,
  opts?: { full?: boolean },
): Promise<{ reembedded: number; skipped: boolean; reason?: string }> {
  const activeMeta = await getActiveEmbedderMeta()
  if (!activeMeta) {
    return { reembedded: 0, skipped: true, reason: 'embedder unavailable' }
  }
  const cachePath = join(storagePath, '.embeddings-cache.json')
  // Start fresh when --full was requested. Even without --full we want the
  // cache header to track the active embedder, so loadCache's invalidation
  // path already does the right thing for matched entries.
  const cache: EmbeddingCache = opts?.full
    ? emptyCache(activeMeta)
    : loadCache(cachePath, activeMeta)

  let count = 0
  for (const engram of engrams) {
    const searchText = engramSearchText(engram)
    const hash = hashStatement(searchText)
    if (cache.entries[engram.id]?.hash === hash && !opts?.full) continue
    const vec = await embed(searchText)
    if (!vec) {
      return { reembedded: count, skipped: true, reason: 'embedder unavailable mid-rebuild' }
    }
    cache.entries[engram.id] = { hash, embedding: Array.from(vec) }
    count++
  }
  saveCache(cachePath, cache)
  return { reembedded: count, skipped: false }
}
