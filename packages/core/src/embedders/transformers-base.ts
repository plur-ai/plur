/**
 * Shared base for @huggingface/transformers-backed adapters.
 *
 * Centralises the lazy pipeline load + the embed/embedBatch shape so each
 * concrete adapter only declares its model id, dim, pooling strategy, and
 * dtype. This is the path that handles MiniLM, BGE-small, BGE-base, and
 * (if the transformers runtime supports it) EmbeddingGemma.
 *
 * Each adapter caches its pipeline as a module-local Map so two instances of
 * the same name share the model instance — important because each load is
 * 100MB+ of WASM / ONNX setup.
 */
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import type { EmbedderAdapter } from './types.js'

/** Pooling strategies supported by @huggingface/transformers feature-extraction. */
export type Pooling = 'cls' | 'mean' | 'none'

export interface TransformersAdapterConfig {
  name: string
  dim: number
  modelId: string
  pooling: Pooling
  /** ONNX weight dtype. 'fp32' is the safe default; 'q8' / 'fp16' may be model-specific. */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4'
  /** Whether to L2-normalise the output. BGE and MiniLM use this. */
  normalize?: boolean
}

const pipelineCache = new Map<string, Promise<unknown>>()
/** Keys whose pipeline promise has resolved. */
const loadedKeys = new Set<string>()

const keyOf = (modelId: string, dtype: TransformersAdapterConfig['dtype']) => `${modelId}::${dtype ?? 'fp32'}`

/** transformers.js file-name suffix per dtype (onnx/model<suffix>.onnx). */
const DTYPE_SUFFIX: Record<string, string> = {
  fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4',
}

type TjsEnv = { cacheDir?: string | null; localModelPath?: string; allowLocalModels?: boolean; allowRemoteModels?: boolean }

/** The library default cache, captured before PLUR ever changes `env.cacheDir`
 *  (undefined = not captured yet). */
let libraryDefaultCacheDir: string | null | undefined
let defaultCacheDirSeam: string | undefined

/** Test seam: pretend the library's default cache is `dir` (undefined restores). */
export function _setDefaultModelCacheDir(dir: string | undefined): void {
  defaultCacheDirSeam = dir
}

/** `env` of the transformers.js module, or undefined — a test double may not
 *  define it (reading a missing export of a vitest mock throws). */
export function envOf(t: unknown): TjsEnv | undefined {
  try { return (t as { env?: TjsEnv }).env } catch { return undefined }
}

/** Import transformers.js, capturing its default cache directory first. */
export async function importTransformers(): Promise<{ env?: TjsEnv } & Record<string, unknown>> {
  const transformers = await import('@huggingface/transformers') as unknown as { env?: TjsEnv } & Record<string, unknown>
  if (libraryDefaultCacheDir === undefined) {
    const d = envOf(transformers)?.cacheDir
    libraryDefaultCacheDir = typeof d === 'string' && d.length > 0 ? d : null
  }
  return transformers
}

async function defaultCacheDir(): Promise<string | null> {
  if (defaultCacheDirSeam !== undefined) return defaultCacheDirSeam
  try { await importTransformers() } catch { return null }
  return libraryDefaultCacheDir ?? null
}

/** Downloads are off by environment (#1586 rounds 4-6). `allowRemoteModels =
 *  false` is enforced by transformers.js itself. */
export function downloadsOffByEnv(): boolean {
  const truthy = (v: string | undefined) => !!v && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())
  return truthy(process.env.HF_HUB_OFFLINE) || truthy(process.env.TRANSFORMERS_OFFLINE)
    || (process.env.PLUR_MODEL_DOWNLOAD ?? '').trim().toLowerCase() === 'off'
}

/**
 * Every file a load of `modelId` reads, relative to the model folder (#1586
 * rounds 5-6): the weights, the tokenizer and config files, and the
 * external-data chunks the model's config declares
 * (`transformers.js_config.use_external_data_format`, resolved the way
 * transformers.js resolves it).
 */
function requiredFiles(weights: string, config: unknown): string[] {
  const files = [join('onnx', weights), 'tokenizer.json', 'tokenizer_config.json', 'config.json']
  const ext = (config as { 'transformers.js_config'?: { use_external_data_format?: unknown } } | null)?.['transformers.js_config']?.use_external_data_format
  let chunks = 0
  if (ext && typeof ext === 'object') {
    const map = ext as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(map, weights)) chunks = Number(map[weights])
    else if (Object.prototype.hasOwnProperty.call(map, 'model')) chunks = Number(map.model)
  } else if (ext) {
    chunks = Number(ext)
  }
  for (let i = 0; i < (Number.isFinite(chunks) ? chunks : 0); i++) {
    files.push(join('onnx', `${weights}_data${i === 0 ? '' : '_' + i}`))
  }
  return files
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/**
 * Are all of a model's files on disk, for a load from `cacheRoot` (the model
 * folder in a cache) with `localRoot` (the model folder under
 * `localModelPath`)? Matches the loader: each file is taken from the cache,
 * else from `localModelPath` (#1586 round 6, L3), so a split layout counts.
 */
function completeIn(cacheRoot: string | null, localRoot: string | null, weights: string): boolean {
  const roots = [cacheRoot, localRoot].filter((r): r is string => !!r)
  if (roots.length === 0) return false
  const configPath = roots.map(r => join(r, 'config.json')).find(p => existsSync(p))
  const files = requiredFiles(weights, configPath ? readJson(configPath) : null)
  return files.every(f => roots.some(r => existsSync(join(r, f))))
}

async function localRootFor(modelId: string): Promise<string | null> {
  try {
    const t = await importTransformers()
    const env = envOf(t)
    const lp = env?.localModelPath
    return lp && env?.allowLocalModels !== false ? join(lp, modelId) : null
  } catch {
    return null
  }
}

/**
 * The cache directory a load of `modelId` should use (#1586 round 6, G1).
 * `PLUR_MODEL_CACHE_DIR` / `HF_HOME` (#845) when the model is complete there;
 * else the library's default cache when it is complete THERE — a model a user
 * already downloaded before setting the override is not lost; else the
 * override (where a download would go), else the default.
 */
export async function resolveLoadCacheDir(modelId: string, weights: string): Promise<string | null> {
  const override = process.env.PLUR_MODEL_CACHE_DIR || process.env.HF_HOME || null
  const def = await defaultCacheDir()
  const local = await localRootFor(modelId)
  if (override && completeIn(join(override, modelId), local, weights)) return override
  if (def && def !== override && completeIn(join(def, modelId), local, weights)) return def
  return override ?? def
}

/** Is the model on disk where a load would read it? Null when there is
 *  neither a cache nor a local model path to look in. */
export async function modelPresence(modelId: string, weights: string): Promise<boolean | null> {
  const cacheDir = await resolveLoadCacheDir(modelId, weights)
  const local = await localRootFor(modelId)
  if (!cacheDir && !local) return null
  return completeIn(cacheDir ? join(cacheDir, modelId) : null, local, weights)
}

async function loadPipeline(modelId: string, dtype: TransformersAdapterConfig['dtype']): Promise<unknown> {
  const key = keyOf(modelId, dtype)
  let pending = pipelineCache.get(key)
  if (!pending) {
    pending = (async () => {
      // Force the classic HF download path: the Xet transfer protocol truncates
      // ONNX model files in this stack (@huggingface/transformers 3.8.1),
      // producing corrupt models ("Protobuf parsing failed") that silently
      // degrade recall to fallback. Never use Xet. (#340)
      process.env.HF_HUB_DISABLE_XET ??= '1'
      const transformers = await importTransformers()

      // Let the caller place the model cache (#845).
      //
      // transformers.js v3 derives its cache directory from the PACKAGE
      // LOCATION (`<package>/.cache`) and reads no environment variable —
      // HF_HOME and TRANSFORMERS_CACHE are both ignored (see its src/env.js).
      // The only lever is `env.cacheDir`, set before the first pipeline() call,
      // and that call site is HERE, in core. So for any consumer installing
      // from npm the model lives inside node_modules, and every `npm ci`
      // destroys it: a server running from a git checkout re-downloaded ~128MB
      // per deploy, and an air-gapped host could not work at all.
      //
      // That failure is quiet, which is what made it expensive. embed()
      // returning null is a DELIBERATE degradation — hybrid recall drops to
      // BM25-only and new records are written without vectors, with nothing
      // raised. enterprise#662 reached production that way: every "hybrid"
      // recall on a containerised deployment had been BM25-only since the
      // feature shipped, and not one engram had ever been embedded.
      //
      // Precedence: explicit PLUR var, then the HF convention (honoured here
      // even though the library ignores it, because operators reasonably expect
      // it to work), then the library default.
      //
      // #1586 round 6 (G1): a model already complete in the library default
      // cache is used from there when the override has none.
      const weights = `model${DTYPE_SUFFIX[dtype ?? 'fp32'] ?? ''}.onnx`
      const cacheDir = await resolveLoadCacheDir(modelId, weights)
      const env = envOf(transformers)
      if (cacheDir && env) {
        // Assigned before pipeline() — after the first load the value is
        // already baked into the resolved paths and changing it does nothing.
        env.cacheDir = cacheDir
      }
      // Downloads off: the loader itself is told not to fetch anything.
      const opts = { ...(dtype ? { dtype } : {}), ...(downloadsOffByEnv() ? { local_files_only: true } : {}) }
      const pipeline = transformers.pipeline as (task: string, model: string, o?: object) => Promise<unknown>
      const pipe = await pipeline('feature-extraction', modelId, Object.keys(opts).length ? opts : undefined)
      loadedKeys.add(key)
      return pipe
    })()
    // A failed load is not cached: the next call tries again.
    pending.catch(() => { if (pipelineCache.get(key) === pending) pipelineCache.delete(key) })
    pipelineCache.set(key, pending)
  }
  return await pending
}

/** Reset the shared pipeline cache. Test-only. */
export function _resetTransformersPipelineCache(): void {
  pipelineCache.clear()
  loadedKeys.clear()
}

export function makeTransformersAdapter(config: TransformersAdapterConfig): EmbedderAdapter {
  const pooling: Pooling = config.pooling
  const normalize = config.normalize ?? true

  async function embedOne(text: string): Promise<Float32Array> {
    const pipe = (await loadPipeline(config.modelId, config.dtype)) as (
      input: string | string[],
      opts: { pooling: Pooling; normalize: boolean },
    ) => Promise<{ data: Float32Array | number[] }>
    const result = await pipe(text, { pooling, normalize })
    const arr = result.data instanceof Float32Array ? result.data : new Float32Array(result.data)
    if (arr.length !== config.dim) {
      throw new Error(
        `Embedder "${config.name}" returned ${arr.length}-dim vector, expected ${config.dim}`,
      )
    }
    return arr
  }

  return {
    name: config.name,
    dim: config.dim,
    modelId: config.modelId,
    embed: embedOne,
    isLoaded: () => loadedKeys.has(keyOf(config.modelId, config.dtype)),
    modelPresent: () => modelPresence(config.modelId, `model${DTYPE_SUFFIX[config.dtype ?? 'fp32'] ?? ''}.onnx`),
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      // The transformers pipeline supports batched input, but in practice the
      // batched-output reshape depends on the runtime version. Iterating
      // gives stable order semantics — speed-critical batches are rare in
      // PLUR's recall path.
      const out: Float32Array[] = []
      for (const t of texts) out.push(await embedOne(t))
      return out
    },
  }
}
