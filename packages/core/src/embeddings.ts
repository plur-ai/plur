import type { Engram } from './schemas/engram.js'
import type { EmbedRole } from './embedders/types.js'
import { downloadsOffByEnv, envOf } from './embedders/transformers-base.js'
import { engramSearchText } from './fts.js'
import { existsSync, readFileSync, mkdirSync, appendFileSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import { atomicWrite, withLock } from './sync.js'
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

/**
 * Can the semantic leg answer now? (#1586 audit rounds 3-4, R1)
 *
 * - `ready`: the model is loaded in this process.
 * - `cached`: on disk (in the model cache, or under transformers.js's
 *   `localModelPath`) but not loaded — loading it is part of a recall's work,
 *   bounded by the recall deadline, with keyword results kept if it is late.
 * - `missing`: not on disk. A recall never downloads it: it answers by keyword
 *   and says so. `plur doctor` is the way to download it. A long-lived process
 *   that opted in ({@link allowBackgroundModelLoad}) starts one in-process
 *   load in the background, once per process, unless downloads are off.
 * - `unknown`: embeddings off, or an embedder that cannot say — callers
 *   proceed as before.
 */
export async function semanticModelState(): Promise<'ready' | 'cached' | 'missing' | 'unknown'> {
  const embedder = await getEmbedder()
  if (!embedder) return 'unknown'
  if (typeof embedder.isLoaded === 'function' && embedder.isLoaded()) return 'ready'
  const present = await modelPresent(embedder)
  if (present === null) return 'unknown'
  if (present) return 'cached'
  await maybeStartBackgroundModelLoad(embedder)
  return 'missing'
}

/** Are the model's files on disk where a load would read them? Null when the
 *  embedder cannot say. The adapter checks weights, tokenizer, config and any
 *  external-data chunks, per file, in the cache it would use and under
 *  `localModelPath` (#1586 rounds 5-6). */
async function modelPresent(embedder: { modelPresent?: () => Promise<boolean | null> }): Promise<boolean | null> {
  if (typeof embedder.modelPresent !== 'function') return null
  try { return await embedder.modelPresent() } catch { return null }
}

/**
 * The one download policy, for every path that loads the model (#1586 round 5,
 * L-learn): recall, injection, and the learn-time near-duplicate check and
 * auto-indexing. With downloads off (HF_HUB_OFFLINE, TRANSFORMERS_OFFLINE,
 * PLUR_MODEL_DOWNLOAD=off, allowRemoteModels=false) a model that is not on
 * disk is not loaded at all, so nothing is fetched.
 */
async function loadAllowed(embedder: { isLoaded?: () => boolean; modelPresent?: () => Promise<boolean | null> }): Promise<boolean> {
  if (typeof embedder.isLoaded === 'function' && embedder.isLoaded()) return true
  const present = await modelPresent(embedder)
  if (present !== false) return true
  return !(await modelDownloadDisabled())
}

let backgroundModelLoadAllowed_ = false
let backgroundModelLoadStarted = false
let backgroundModelLoadCount = 0

/**
 * Let THIS process load (and, if needed, download) the model in the background
 * when a recall finds it missing. For long-lived processes only — the MCP
 * server, the opencode plugin. A short-lived CLI or hook process never calls
 * this, so it never downloads: it would be killed mid-download at exit.
 */
export function allowBackgroundModelLoad(allowed = true): void {
  backgroundModelLoadAllowed_ = allowed
}

/** How many background model loads this process started (0 or 1). */
export function backgroundModelLoadAttempts(): number {
  return backgroundModelLoadCount
}

/** Test-only: forget the background-load state. */
export function _resetBackgroundModelLoad(): void {
  backgroundModelLoadAllowed_ = false
  backgroundModelLoadStarted = false
  backgroundModelLoadCount = 0
}

const truthy = (v: string | undefined): boolean => !!v && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())

/** Downloads are off: HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE, PLUR_MODEL_DOWNLOAD=off,
 *  or transformers.js configured with `allowRemoteModels = false`. */
async function modelDownloadDisabled(): Promise<boolean> {
  if (downloadsOffByEnv()) return true
  try {
    const transformers = await import('@huggingface/transformers') as { env?: { allowRemoteModels?: boolean } }
    if (envOf(transformers)?.allowRemoteModels === false) return true
  } catch { return true }
  return false
}

/** At most once per process, never awaited by a recall, never retried. */
async function maybeStartBackgroundModelLoad(embedder: { embed: (t: string) => Promise<unknown> }): Promise<void> {
  if (!backgroundModelLoadAllowed_ || backgroundModelLoadStarted) return
  if (await modelDownloadDisabled()) return
  if (backgroundModelLoadStarted) return
  backgroundModelLoadStarted = true
  backgroundModelLoadCount++
  // Nothing of ours keeps the process alive: no timer, no awaited promise.
  // The MCP server exits explicitly when its client goes away.
  void embedder.embed('warm up').catch(() => { /* reported by embedderStatus(); not retried */ })
}

/** Generate embedding for a text string. Returns the active embedder's native dim, or null if unavailable.
 *  Pass role='query' when embedding search terms; omit or pass 'passage' for stored engram text.
 *  Adapters that support asymmetric prefixes (EmbeddingGemma) use this to pick the correct space. */
export async function embed(text: string, role?: EmbedRole): Promise<Float32Array | null> {
  const embedder = await getEmbedder()
  if (!embedder) return null
  if (!(await loadAllowed(embedder))) {
    lastLoadError = 'the embedding model is not on disk and downloads are off — run `plur doctor` with network access to download it'
    return null
  }
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
  const cache = loadMainCache(cachePath, active)
  applyDelta(cache, cachePath, active)
  return cache
}

/**
 * The vectors saved since the cache file was last rewritten (#1586 round 6,
 * L2): one JSON line per vector, appended. A cut-off recall appends only what
 * it computed, instead of rewriting a cache file that grows with the store;
 * a completed search or the background fill folds the lines back into the
 * main file. A line cut short by a killed process is skipped.
 */
function deltaPath(cachePath: string): string {
  return cachePath.replace(/\.json$/, '') + '.delta.jsonl'
}

function applyDelta(cache: EmbeddingCache, cachePath: string, active: { name: string; dim: number }): void {
  const dp = deltaPath(cachePath)
  if (!existsSync(dp)) return
  let text = ''
  try { text = readFileSync(dp, 'utf8') } catch { return }
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const e = JSON.parse(line) as { id?: string; hash?: string; embedding?: number[]; embedder?: string; dim?: number }
      if (e.embedder !== active.name || e.dim !== active.dim) continue
      if (typeof e.id !== 'string' || typeof e.hash !== 'string' || !Array.isArray(e.embedding)) continue
      cache.entries[e.id] = { hash: e.hash, embedding: e.embedding }
    } catch { /* a partial line from a killed process */ }
  }
}

/** Short, bounded lock around cache writes (#1586 round 6, L1): about 150 ms
 *  of retries; when it cannot be taken the save is skipped (the vectors are
 *  recomputed later), never waited out. */
const CACHE_LOCK_OPTS = { maxRetries: 4, baseDelay: 10 }

function withCacheLock(cachePath: string, fn: () => void): boolean {
  try {
    const dir = dirname(cachePath)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    withLock(cachePath, fn, CACHE_LOCK_OPTS)
    return true
  } catch {
    return false
  }
}

/** Append vectors to the cache's delta file, under the cache lock. */
function appendEntries(cachePath: string, meta: { name: string; dim: number }, entries: EmbeddingCacheEntries): boolean {
  const ids = Object.keys(entries)
  if (ids.length === 0) return true
  const lines = ids.map(id => JSON.stringify({ id, hash: entries[id].hash, embedding: entries[id].embedding, embedder: meta.name, dim: meta.dim })).join('\n') + '\n'
  return withCacheLock(cachePath, () => {
    const dp = deltaPath(cachePath)
    // A line cut short by a killed process has no newline: start on a fresh
    // line, so it never swallows this record (#1586 round 7, D-1).
    appendFileSync(dp, (endsTorn(dp) ? '\n' : '') + lines)
  })
}

/** Does the file exist, non-empty, without a trailing newline? */
function endsTorn(path: string): boolean {
  let fd: number | undefined
  try {
    const size = statSync(path).size
    if (size === 0) return false
    fd = openSync(path, 'r')
    const b = Buffer.alloc(1)
    readSync(fd, b, 0, 1, size - 1)
    return b[0] !== 0x0a
  } catch {
    return false
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* closed */ }
  }
}

/** Compact once the delta file passes this size, whether or not a search
 *  ever completes (#1586 round 7, D-2). About 1,000 vectors of 384 floats. */
const DEFAULT_DELTA_COMPACT_BYTES = 8 * 1024 * 1024
let deltaCompactBytes = DEFAULT_DELTA_COMPACT_BYTES

/** Test seam: the compaction threshold in bytes (undefined restores). */
export function _setDeltaCompactBytes(bytes: number | undefined): void {
  deltaCompactBytes = bytes ?? DEFAULT_DELTA_COMPACT_BYTES
}

/** Fold the delta into the main file when it has grown past the threshold.
 *  Under the cache lock; when the lock is busy, nothing happens (fail open). */
function compactIfLarge(cachePath: string, meta: { name: string; dim: number }, deadlineAt?: number): void {
  const dp = deltaPath(cachePath)
  let size = 0
  try { size = statSync(dp).size } catch { return }
  if (size <= deltaCompactBytes) return
  // Only this model's records count (#1586 round 8, R8-2): records of
  // another model are kept by every fold, so counting them would fold on
  // every search.
  if (ownDeltaBytes(dp, meta) <= deltaCompactBytes) return
  // A fold rewrites the whole cache. Do it now only when the time budget
  // allows it (no deadline: not a recall); else, in a long-lived process,
  // after the reply; else leave it for a search that has the time.
  let mainSize = 0
  try { mainSize = statSync(cachePath).size } catch { /* none yet */ }
  const estimateMs = ((mainSize + size) / (1024 * 1024)) * foldCostMsPerMb
  if (deadlineAt === undefined || deadlineAt - Date.now() > 2 * estimateMs) {
    if (compactCache(cachePath, meta)) thresholdFolds++
    return
  }
  if (backgroundModelLoadAllowed_) deferFold(cachePath, meta, deadlineAt)
}

/** Bytes of the delta that belong to `meta`'s model (lines end with its
 *  embedder and dim, as appendEntries writes them). */
function ownDeltaBytes(dp: string, meta: { name: string; dim: number }): number {
  const suffix = `"embedder":${JSON.stringify(meta.name)},"dim":${meta.dim}}`
  let text = ''
  try { text = readFileSync(dp, 'utf8') } catch { return 0 }
  let bytes = 0
  for (const line of text.split('\n')) if (line.endsWith(suffix)) bytes += line.length + 1
  return bytes
}

/** Estimated cost of a fold per MB of cache (main + delta). Round 6 measured
 *  about 0.4 s for 37 MB; this keeps a margin. */
const DEFAULT_FOLD_COST_MS_PER_MB = 25
let foldCostMsPerMb = DEFAULT_FOLD_COST_MS_PER_MB
let thresholdFolds = 0
const deferredFolds = new Set<string>()

/** Test seam: the fold-cost estimate per MB (undefined restores). */
export function _setFoldCostMsPerMb(ms: number | undefined): void {
  foldCostMsPerMb = ms ?? DEFAULT_FOLD_COST_MS_PER_MB
}

/** Test seam: how many threshold folds this process has run. */
export function _thresholdFoldCount(): number {
  return thresholdFolds
}

/** Fold once the recall that saw the large delta has replied (its deadline
 *  has passed). The timer is unref'd: it never keeps a process alive. */
function deferFold(cachePath: string, meta: { name: string; dim: number }, deadlineAt: number): void {
  if (deferredFolds.has(cachePath)) return
  deferredFolds.add(cachePath)
  const t = setTimeout(() => {
    deferredFolds.delete(cachePath)
    try {
      const dp = deltaPath(cachePath)
      if (existsSync(dp) && ownDeltaBytes(dp, meta) > deltaCompactBytes && compactCache(cachePath, meta)) thresholdFolds++
    } catch { /* derived state: best effort */ }
  }, Math.max(0, deadlineAt - Date.now()) + 250)
  ;(t as { unref?: () => void }).unref?.()
}

/** Fold the delta file and `extra` into the main cache file, under the lock:
 *  re-read what is on disk, so another process's vectors are kept. */
function compactCache(cachePath: string, meta: { name: string; dim: number }, extra: EmbeddingCacheEntries = {}): boolean {
  return withCacheLock(cachePath, () => {
    const onDisk = loadCache(cachePath, meta)
    onDisk.entries = { ...onDisk.entries, ...extra }
    saveCache(cachePath, onDisk)
    // Records of another model or dimension stay in the delta (#1586 round
    // 7, D-3): during a model switch, a process still on the old model must
    // not throw away the new model's vectors.
    const dp = deltaPath(cachePath)
    let others: string[] = []
    try {
      others = readFileSync(dp, 'utf8').split('\n').filter(line => {
        if (!line) return false
        try {
          const e = JSON.parse(line) as { embedder?: string; dim?: number }
          return e.embedder !== meta.name || e.dim !== meta.dim
        } catch { return false }
      })
    } catch { /* no delta */ }
    try {
      if (others.length > 0) atomicWrite(dp, others.join('\n') + '\n', { durable: false })
      else unlinkSync(dp)
    } catch { /* none */ }
  })
}

/** Test seam (#1586 round 7, D-3). */
export function _compactEmbeddingCache(cachePath: string, meta: { name: string; dim: number }): boolean {
  return compactCache(cachePath, meta)
}

/** Test seam / child-process entry (#1586 round 6, L1). */
export function _appendEmbeddingCacheEntries(cachePath: string, meta: { name: string; dim: number }, entries: EmbeddingCacheEntries): boolean {
  return appendEntries(cachePath, meta, entries)
}

/** Test seam: every vector the cache holds (main file plus delta). */
export function _readEmbeddingCacheEntries(cachePath: string, meta: { name: string; dim: number }): EmbeddingCacheEntries {
  return loadCache(cachePath, meta).entries
}

function loadMainCache(cachePath: string, active: { name: string; dim: number }): EmbeddingCache {
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
  const dir = dirname(cachePath)
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  // Derived state: every vector here is recomputable from the corpus, so the
  // fsync is pure cost. Losing this cache to a power cut costs a re-embed, not
  // data (audit #794, F4).
  atomicWrite(cachePath, JSON.stringify(cache), { durable: false })
}

function hashStatement(statement: string): string {
  return createHash('sha256').update(statement).digest('hex').slice(0, 16)
}

/**
 * Merge externally-obtained vectors into the on-disk embeddings cache.
 *
 * The #1046 PGLite→SQLite migration's write half: vectors verified fresh
 * against the CURRENT engram text are folded into the cache under this
 * module's own key discipline (`hashStatement` of the search text), so the
 * yaml/sqlite tiers serve them exactly as if they had been computed here.
 * Lives in this file because the cache format — meta header, entry shape,
 * hash function — is deliberately private to it.
 *
 * Existing entries win only when they were computed from the SAME text as
 * the import (equal `hashStatement` of the search text): then the live embed
 * path already wrote a vector at least as fresh. An existing entry keyed to
 * OTHER text is stale — the caller verified the import against the engram's
 * current text — so the import replaces it; keeping it threw the verified
 * vector away and forced the re-embed this merge exists to avoid (formal R2,
 * core-retrieval#12). Returns how many entries were written.
 */
export function mergeEmbeddingsIntoCache(
  storagePath: string,
  active: { name: string; dim: number },
  imports: Array<{ engramId: string; searchText: string; embedding: number[] }>,
): number {
  const cachePath = join(storagePath, '.embeddings-cache.json')
  const cache = loadCache(cachePath, active)
  const fresh: EmbeddingCacheEntries = {}
  for (const imp of imports) {
    if (imp.embedding.length !== active.dim) continue
    const hash = hashStatement(imp.searchText)
    if (cache.entries[imp.engramId]?.hash === hash) continue
    fresh[imp.engramId] = { hash, embedding: imp.embedding }
  }
  const written = Object.keys(fresh).length
  if (written === 0) return 0
  // Under the cache lock, with the delta folded in first and then removed
  // (#1586 round 7, D-4): an older delta record can never be applied over an
  // imported vector afterwards. Lock busy: nothing written, imported later.
  return compactCache(cachePath, active, fresh) ? written : 0
}

/**
 * Keeps the vectors an embedding search computes (#1586 round 5, R3).
 *
 * A recall cut off by its deadline used to throw them away, so a store without
 * an embedding cache started again at its first engram on every recall and
 * never became hybrid. Now they are saved — atomically (tmp + rename) — at the
 * moment the caller stops waiting (synchronously, inside the abort, so the
 * write lands before the reply and before a short-lived process exits), and
 * again when the search ends. Each cut-off recall makes progress.
 */
function cacheProgress(cachePath: string, cache: EmbeddingCache, signal?: AbortSignal, deadlineAt?: number): { added(id: string): void; done(): void } {
  const meta = { name: cache.meta.embedder_name, dim: cache.meta.embedder_dim }
  compactIfLarge(cachePath, meta, deadlineAt)
  /** Vectors not yet on disk. */
  let pending: EmbeddingCacheEntries = {}
  let lastFlush = Date.now()
  /** Append what is pending to the delta file (cheap: only the new lines). */
  const flush = (): void => {
    if (Object.keys(pending).length === 0) return
    const batch = pending
    pending = {}
    lastFlush = Date.now()
    if (!appendEntries(cachePath, meta, batch)) {
      // Lock busy: skipped; the vectors are recomputed by a later search.
    }
  }
  const onAbort = (): void => flush()
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    added: (id: string) => {
      pending[id] = cache.entries[id]
      // Save in steps while embedding (L2): what is left for the deadline is
      // small, whatever the size of the cache.
      if (Object.keys(pending).length >= PROGRESS_FLUSH_EVERY || Date.now() - lastFlush > PROGRESS_FLUSH_MS) {
        flush()
        // Still inside the search (not at the deadline): the place to fold a
        // delta that has grown past the threshold (D-2).
        compactIfLarge(cachePath, meta, deadlineAt)
      }
    },
    done: () => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) { flush(); return }
      // A completed search folds everything into the main file (the reply
      // was not cut, so this is the place for the full rewrite).
      const all = pending
      pending = {}
      if (Object.keys(all).length > 0 || existsSync(deltaPath(cachePath))) compactCache(cachePath, meta, all)
    },
  }
}

const PROGRESS_FLUSH_EVERY = 100
const PROGRESS_FLUSH_MS = 2000

/**
 * Embed every engram the cache does not hold yet, saving as it goes (#1586
 * round 5, R3). Run in the background, once, by a long-lived process that
 * opted in ({@link allowBackgroundModelLoad}) when a recall found the cache
 * incomplete. Stops at the first failure (model missing and downloads off,
 * load error); never retried. Returns how many vectors it added.
 */
export async function fillEmbeddingCache(engrams: Engram[], storagePath?: string): Promise<number> {
  const activeMeta = await getActiveEmbedderMeta()
  if (!activeMeta) return 0
  const cachePath = storagePath ? join(storagePath, '.embeddings-cache.json') : '.embeddings-cache.json'
  const cache = loadCache(cachePath, activeMeta)
  let added = 0
  const progress = cacheProgress(cachePath, cache)
  for (const engram of engrams) {
    const text = engramSearchText(engram)
    const hash = hashStatement(text)
    if (cache.entries[engram.id]?.hash === hash) continue
    const v = await embed(text)
    if (!v) break
    cache.entries[engram.id] = { hash, embedding: Array.from(v) }
    added++
    progress.added(engram.id)
  }
  progress.done()
  return added
}

/** Is the active embedder a remote API (no local model to warm or fill)? */
export async function activeEmbedderIsRemote(): Promise<boolean> {
  const embedder = await getEmbedder()
  return !!embedder && (embedder as { remote?: boolean }).remote === true
}

/** Did this process opt in to background model work? */
export function backgroundModelLoadAllowed(): boolean {
  return backgroundModelLoadAllowed_
}

/** Options for the embedding searches (#1586 audit L3). */
export interface EmbeddingSearchOptions {
  /** The recall's deadline (epoch ms, #1586 round 8): a fold of the cache's
   *  delta file runs during the search only when it fits before it. */
  deadlineAt?: number
  /** Aborted when the caller stopped waiting (a recall past its deadline):
   *  the search embeds nothing more and does not save the cache. */
  signal?: AbortSignal
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
  opts?: EmbeddingSearchOptions,
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
  const progress = cacheProgress(cachePath, cache, opts?.signal, opts?.deadlineAt)

  for (const engram of engrams) {
    const searchText = engramSearchText(engram)
    const hash = hashStatement(searchText)
    let engramEmbedding: Float32Array

    if (cache.entries[engram.id]?.hash === hash) {
      // Cache hit
      engramEmbedding = new Float32Array(cache.entries[engram.id].embedding)
    } else {
      // Cache miss — compute embedding from enriched text. Nobody is waiting
      // for an aborted search: stop embedding (what was computed is saved).
      if (opts?.signal?.aborted) break
      const emb = await embed(searchText)
      if (!emb) { progress.done(); return [] } // model unloaded mid-search
      engramEmbedding = emb
      cache.entries[engram.id] = {
        hash,
        embedding: Array.from(engramEmbedding),
      }
      progress.added(engram.id)
    }

    const score = cosineSimilarity(queryEmbedding, engramEmbedding)
    similarities.push({ engram, score })
  }

  progress.done()
  if (opts?.signal?.aborted) return []

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
  opts?: EmbeddingSearchOptions,
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
  const progress = cacheProgress(cachePath, cache, opts?.signal, opts?.deadlineAt)

  for (const engram of engrams) {
    const searchText = engramSearchText(engram)
    const hash = hashStatement(searchText)
    let engramEmbedding: Float32Array

    if (cache.entries[engram.id]?.hash === hash) {
      // Cache hit
      engramEmbedding = new Float32Array(cache.entries[engram.id].embedding)
    } else {
      // Cache miss — compute embedding from enriched text. Nobody is waiting
      // for an aborted search: stop embedding (what was computed is saved).
      if (opts?.signal?.aborted) break
      const emb = await embed(searchText)
      if (!emb) { progress.done(); return [] } // model unloaded mid-search
      engramEmbedding = emb
      cache.entries[engram.id] = {
        hash,
        embedding: Array.from(engramEmbedding),
      }
      progress.added(engram.id)
    }

    // Clamp to [0, 1] — cosine on normalized embeddings is [-1, 1] but
    // same-language text is practically always non-negative. Clamping ensures
    // dedup thresholds (>0.9, 0.7-0.9) work as documented.
    const rawScore = cosineSimilarity(queryEmbedding, engramEmbedding)
    const score = Math.max(0, Math.min(1, rawScore))
    similarities.push({ engram, score })
  }

  progress.done()
  if (opts?.signal?.aborted) return []

  // Sort by similarity (descending) and return top N with scores
  similarities.sort((a, b) => b.score - a.score)
  return similarities.slice(0, limit)
}

