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
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import { createReadStream, existsSync, readFileSync, statSync, mkdirSync, linkSync, copyFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import type { EmbedderAdapter } from './types.js'
import { offlineByEnv, offlineNow } from '../offline.js'
import { logger } from '../logger.js'
import { modelPin } from './model-pins.js'

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
  /** Retrieval-query instruction from the model card (see EmbedderAdapter.searchInstruction). */
  searchInstruction?: string
}

const pipelineCache = new Map<string, Promise<unknown>>()
/** Keys whose pipeline promise has resolved. */
const loadedKeys = new Set<string>()

const keyOf = (modelId: string, dtype: TransformersAdapterConfig['dtype']) => `${modelId}::${dtype ?? 'fp32'}`

/** transformers.js file-name suffix per dtype (onnx/model<suffix>.onnx). */
const DTYPE_SUFFIX: Record<string, string> = {
  fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4',
}

/** The ONNX weights file transformers.js loads for `dtype` (onnx/model<suffix>.onnx). */
export function weightsFileFor(dtype: string | undefined): string {
  return `model${DTYPE_SUFFIX[dtype ?? 'fp32'] ?? ''}.onnx`
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

/** Downloads are off by environment (#1586 rounds 4-6): the offline switch
 *  (PLUR_OFFLINE, HF_HUB_OFFLINE, TRANSFORMERS_OFFLINE; see offline.ts) or
 *  PLUR_MODEL_DOWNLOAD=off. `allowRemoteModels =
 *  false` is enforced by transformers.js itself. */
export function downloadsOffByEnv(): boolean {
  return offlineByEnv() || (process.env.PLUR_MODEL_DOWNLOAD ?? '').trim().toLowerCase() === 'off'
}

/** Downloads are off for this process: off by environment, or the process
 *  inferred it is offline after a failed connection (TEAM-5, offline.ts). A
 *  model already on disk is still loaded, from disk only. */
export function downloadsOff(): boolean {
  return offlineNow() || downloadsOffByEnv()
}

/**
 * The one guard every automatic model download goes through (TEAM-5; audit 6,
 * N4): the embedders (the shared pipeline loader below and EmbeddingGemma) and
 * the transformers cross-encoder rerankers. With downloads off, a model that
 * is not on disk is refused HERE, before transformers.js is asked for it.
 * Telling the library `local_files_only` is not enough: some of its discovery
 * steps ignore that option and look the file up remotely anyway (pipeline()
 * resolves the model's file list and fetches config.json; the tokenizer
 * loader looks up tokenizer_config.json without the caller's options). A
 * model already on disk is not refused; it is then loaded from disk only
 * (see {@link localOnlyOptions}).
 */
export async function refuseMissingModelOffline(modelId: string, weights: string, what = 'model'): Promise<void> {
  if (downloadsOff() && (await modelPresence(modelId, weights)) === false) {
    throw new Error(`${what} ${modelId} is not on disk and downloads are off (offline); nothing was fetched`)
  }
}

/** `{ local_files_only: true }` when downloads are off, else `{}`. */
export function localOnlyOptions(): { local_files_only?: true } {
  return downloadsOff() ? { local_files_only: true } : {}
}

/**
 * Every file a load of `modelId` reads, relative to the model folder (#1586
 * rounds 5-6): the weights, the tokenizer and config files, and the
 * external-data chunks the model's config declares
 * (`transformers.js_config.use_external_data_format`, resolved the way
 * transformers.js resolves it).
 */
const MAX_EXTERNAL_DATA_CHUNKS = 64

function requiredFiles(weights: string, config: unknown): string[] {
  const files = [join('onnx', weights), 'tokenizer.json', 'tokenizer_config.json', 'config.json']
  // transformers.js merges `device_config[<device>]` over the top-level
  // settings (models/session.js); in Node the device is the CPU (#1586 round
  // 7, D-4).
  const tjs = (config as { 'transformers.js_config'?: { use_external_data_format?: unknown; device_config?: Record<string, { use_external_data_format?: unknown }> } } | null)?.['transformers.js_config']
  const cpu = tjs?.device_config?.cpu
  const ext = cpu && Object.prototype.hasOwnProperty.call(cpu, 'use_external_data_format')
    ? cpu.use_external_data_format
    : tjs?.use_external_data_format
  let chunks = 0
  if (ext && typeof ext === 'object') {
    const map = ext as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(map, weights)) chunks = Number(map[weights])
    else if (Object.prototype.hasOwnProperty.call(map, 'model')) chunks = Number(map.model)
  } else if (ext) {
    chunks = Number(ext)
  }
  // Clamped (security audit 2026-11-06, hardening): the count comes from a
  // config.json in the model cache, and an absurd value made every presence
  // check build that many paths. Real models declare a handful of chunks.
  const count = Number.isFinite(chunks) ? Math.min(MAX_EXTERNAL_DATA_CHUNKS, Math.max(0, Math.floor(chunks))) : 0
  for (let i = 0; i < count; i++) {
    files.push(join('onnx', `${weights}_data${i === 0 ? '' : '_' + i}`))
  }
  return files
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/**
 * The folder transformers.js keeps a pinned model in: `<cacheDir>/<modelId>/<revision>`
 * (security audit 2026-11-06, H-x03-1). With a `revision` other than 'main'
 * its file cache keys each file as `<model>/<revision>/<file>` (hub.js,
 * buildResourcePaths), so the files of a pinned load land there, not in
 * `<cacheDir>/<modelId>` (the old, unpinned layout). Null for a model with no pin.
 */
export function pinnedModelDir(cacheDir: string, modelId: string): string | null {
  const pin = modelPin(modelId)
  return pin ? join(cacheDir, modelId, pin.revision) : null
}

/** `{ revision }` for a pinned model, passed to every transformers.js load. */
export function pinnedLoadOptions(modelId: string): { revision?: string } {
  const pin = modelPin(modelId)
  return pin ? { revision: pin.revision } : {}
}

/** Every file a load of `modelId` reads: what its config declares, plus every
 *  file pinned for it (the pin is exact for the dtype PLUR loads). */
function requiredFilesFor(modelId: string, weights: string, config: unknown): string[] {
  const files = requiredFiles(weights, config)
  const pin = modelPin(modelId)
  if (pin) for (const f of Object.keys(pin.files)) if (!files.includes(f)) files.push(f)
  return files
}

/**
 * Are all of a model's files on disk, for a load with cache `cacheDir` and
 * `localRoot` (the model folder under `localModelPath`)? Matches the loader:
 * each file is taken from the cache, else from `localModelPath` (#1586 round
 * 6, L3), so a split layout counts. In the cache a pinned model's files are
 * in its revision folder; a file still in the old layout (`<cacheDir>/<modelId>`,
 * from before models were pinned) counts too, because the load adopts it when
 * its sha256 matches the pin (see {@link verifyPinnedModel}).
 */
function completeIn(cacheDir: string | null, modelId: string, localRoot: string | null, weights: string): boolean {
  const roots: string[] = []
  if (cacheDir) {
    const pinned = pinnedModelDir(cacheDir, modelId)
    if (pinned) roots.push(pinned)
    roots.push(join(cacheDir, modelId))
  }
  if (localRoot) roots.push(localRoot)
  if (roots.length === 0) return false
  const configPath = roots.map(r => join(r, 'config.json')).find(p => existsSync(p))
  const config = configPath ? readJson(configPath) : null
  // A config.json that does not parse cannot be loaded: that location does
  // not hold a usable model (#1586 round 7, D-4), so the fallback can apply.
  if (configPath && config === null) return false
  const files = requiredFilesFor(modelId, weights, config)
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
  let dir: string | null
  if (override && completeIn(override, modelId, local, weights)) dir = override
  else if (def && def !== override && completeIn(def, modelId, local, weights)) dir = def
  else dir = override ?? def
  if (dir) lastCacheDirFor.set(modelId, dir)
  return dir
}

/** The cache directory the last load of each model resolved to. */
const lastCacheDirFor = new Map<string, string>()

/**
 * The folder holding `modelId` in PLUR's model cache — what to delete when
 * that cache is corrupt. PLUR loads models from `<cacheDir>/<modelId>`
 * (see {@link resolveLoadCacheDir}; a pinned model's files are in its
 * revision subfolder, see {@link pinnedModelDir}, so deleting this folder
 * removes both layouts), not from the Hugging Face hub cache
 * (`~/.cache/huggingface/hub/models--…`), which the purge advice used to name
 * (security audit 2026-11-06, hardening). Synchronous, for log and doctor
 * text: the directory the last load used, else the one a load would use.
 */
export function modelCacheFolder(modelId: string): string {
  const dir = lastCacheDirFor.get(modelId)
    ?? (process.env.PLUR_MODEL_CACHE_DIR || process.env.HF_HOME || defaultCacheDirSeam || libraryDefaultCacheDir || null)
  return dir
    ? join(dir, modelId)
    : `${modelId} under PLUR's model cache (PLUR_MODEL_CACHE_DIR or HF_HOME when set, otherwise the .cache folder of the installed @huggingface/transformers package)`
}

/** Is the model on disk where a load would read it? Null when there is
 *  neither a cache nor a local model path to look in. */
export async function modelPresence(modelId: string, weights: string): Promise<boolean | null> {
  const cacheDir = await resolveLoadCacheDir(modelId, weights)
  const local = await localRootFor(modelId)
  if (!cacheDir && !local) return null
  return completeIn(cacheDir, modelId, local, weights)
}

// ---------------------------------------------------------------------------
// Integrity (security audit 2026-11-06, H-x03-1). Every file a load reads is
// checked against the sha256 pinned for it (model-pins.ts) before the model
// is used: before the load for files already on disk, and again after it,
// which covers what the load downloaded. A file that does not match is never
// used. The result of a hash is remembered per file (size, mtime, ctime,
// inode), in memory and in a small marker in the revision folder, so a
// 100MB+ file is hashed once, not on every process start; any write to the
// file changes its ctime, which a caller cannot set back, so a swapped file
// is hashed again.
// ---------------------------------------------------------------------------

/** A model file whose bytes are not the pinned ones. The message says
 *  "corrupt", so the reranker classifier (rerankers/index.ts) and the doctor
 *  treat it as the corrupt-cache case and name the folder to delete. */
export class ModelIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelIntegrityError'
  }
}

const MARKER_FILE = '.plur-verified.json'
type Marker = { version: 1; files: Record<string, { stat: string; sha256: string }> }
/** path -> `${stat}|${sha256}` known good in this process. */
const verifiedInProcess = new Map<string, string>()
let hashCount = 0

/** Test seam: how many files were hashed (the marker must keep this flat). */
export function _modelHashCount(): number { return hashCount }
/** Test seam: forget what this process verified (the on-disk marker stays). */
export function _resetVerifiedModelFiles(): void { verifiedInProcess.clear(); hashCount = 0 }

function statKey(path: string): string | null {
  try {
    const s = statSync(path)
    if (!s.isFile()) return null
    return `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`
  } catch { return null }
}

async function sha256Of(path: string): Promise<string> {
  hashCount++
  const h = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const st = createReadStream(path)
    st.on('data', (c) => h.update(c))
    st.on('error', reject)
    st.on('end', () => resolve())
  })
  return h.digest('hex')
}

function readMarker(dir: string | null): Marker {
  const m = dir ? readJson(join(dir, MARKER_FILE)) as Marker | null : null
  return m && m.version === 1 && m.files && typeof m.files === 'object' ? m : { version: 1, files: {} }
}

function writeMarker(dir: string | null, marker: Marker): void {
  if (!dir) return
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `${MARKER_FILE}.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(marker))
    renameSync(tmp, join(dir, MARKER_FILE))
  } catch { /* a read-only cache only costs a re-hash next time */ }
}

/** Does the file at `path` hash to `expected`? Uses the remembered result
 *  while the file's size, mtime, ctime and inode are unchanged. */
async function fileMatches(path: string, expected: string, marker: Marker): Promise<boolean> {
  const before = statKey(path)
  if (!before) return false
  const known = `${before}|${expected}`
  if (verifiedInProcess.get(path) === known) return true
  const rec = marker.files[path]
  if (rec && rec.stat === before && rec.sha256 === expected) {
    verifiedInProcess.set(path, known)
    return true
  }
  const actual = await sha256Of(path)
  // A file that changed while it was hashed is not vouched for.
  if (actual !== expected || statKey(path) !== before) {
    delete marker.files[path]
    verifiedInProcess.delete(path)
    return false
  }
  marker.files[path] = { stat: before, sha256: actual }
  verifiedInProcess.set(path, known)
  return true
}

/** Link (else copy) `src` to `dest` through a temporary name, keeping it only
 *  when its sha256 is `expected`. The bytes hashed are the bytes kept. */
async function adoptFile(src: string, dest: string, expected: string, marker: Marker): Promise<boolean> {
  const tmp = `${dest}.adopt.${process.pid}.tmp`
  try {
    mkdirSync(dirname(dest), { recursive: true })
    try { unlinkSync(tmp) } catch { /* none */ }
    try { linkSync(src, tmp) } catch { copyFileSync(src, tmp) }
    if (!(await fileMatches(tmp, expected, marker))) {
      unlinkSync(tmp)
      return false
    }
    const rec = marker.files[tmp]
    delete marker.files[tmp]
    verifiedInProcess.delete(tmp)
    renameSync(tmp, dest)
    // A rename keeps the inode, size and mtime but may touch ctime: re-key.
    const now = statKey(dest)
    if (rec && now) {
      marker.files[dest] = { stat: now, sha256: rec.sha256 }
      verifiedInProcess.set(dest, `${now}|${rec.sha256}`)
    }
    return true
  } catch {
    try { unlinkSync(tmp) } catch { /* none */ }
    return false
  }
}

/**
 * Check a pinned model's files before (`phase: 'before'`) and after
 * (`phase: 'after'`) transformers.js loads it from `cacheDir`.
 *
 * For each pinned file, the copy the library would read is found the way
 * hub.js looks for it (the file cache first, under the key it tries first and
 * then under `<model>/<revision>/<file>`; then `localModelPath`), and its
 * sha256 must match the pin, or a {@link ModelIntegrityError} names the file
 * and the folder to delete.
 *
 * Backward compatibility: a file only in the old layout (`<cacheDir>/<model>/<file>`,
 * written by PLUR before models were pinned) is adopted into the revision
 * folder (hard link, else copy) when it matches the pin, so an existing
 * offline install keeps working with no download. One that does not match is
 * never used: with downloads on, the load fetches the pinned file instead;
 * with downloads off, the load is refused.
 *
 * After the load every pinned file must be present and match: that is the
 * check on what was downloaded, done before the model is handed to a caller.
 */
export async function verifyPinnedModel(
  modelId: string, weights: string, cacheDir: string | null, phase: 'before' | 'after', what = 'model',
): Promise<void> {
  const pin = modelPin(modelId)
  if (!pin) {
    throw new ModelIntegrityError(`${what} ${modelId} has no integrity pin in PLUR (model-pins.ts), so its files cannot be verified; refusing to load it`)
  }
  const t = await importTransformers().catch(() => undefined)
  const env = t ? envOf(t) : undefined
  const local = await localRootFor(modelId)
  const pinnedDir = cacheDir ? join(cacheDir, modelId, pin.revision) : null
  const legacyDir = cacheDir ? join(cacheDir, modelId) : null
  const marker = readMarker(pinnedDir)
  const before = JSON.stringify(marker)
  const folder = legacyDir ?? local ?? modelCacheFolder(modelId)
  const bad = (path: string, file: string, where: string) => new ModelIntegrityError(
    `${what} ${modelId}: ${path} does not match the sha256 PLUR pins for ${file} at revision ${pin.revision} ` +
    `(integrity check failed: the model cache is corrupt or was tampered with). The file was not used. ` +
    `Delete ${where} to force a clean re-download.`,
  )
  try {
    for (const [file, expected] of Object.entries(pin.files)) {
      // hub.js checkCachedResource: the file cache under the local-path key,
      // then under `<model>/<revision>/<file>`; else, with local models
      // allowed, the file under localModelPath.
      const candidates: Array<{ path: string; where: string }> = []
      if (cacheDir && env?.localModelPath) candidates.push({ path: join(cacheDir, env.localModelPath, modelId, file), where: folder })
      if (pinnedDir) candidates.push({ path: join(pinnedDir, file), where: folder })
      if (local) candidates.push({ path: join(local, file), where: local })
      let source = candidates.find(c => statKey(c.path) !== null)
      if (!source && pinnedDir && legacyDir) {
        const old = join(legacyDir, file)
        if (statKey(old) !== null) {
          if (await adoptFile(old, join(pinnedDir, file), expected, marker)) {
            source = { path: join(pinnedDir, file), where: folder }
          } else if (phase === 'after' || downloadsOff()) {
            throw bad(old, file, folder)
          } else {
            logger.warning(`[embedders] ${old} does not match the pinned sha256 for ${modelId} ${file}; not using it, the pinned file will be downloaded instead`)
          }
        }
      }
      if (!source) {
        if (phase === 'after') {
          throw new ModelIntegrityError(`${what} ${modelId}: ${file} is not on disk after the load, so it cannot be verified (looked in ${pinnedDir ?? local ?? folder})`)
        }
        continue
      }
      if (!(await fileMatches(source.path, expected, marker))) throw bad(source.path, file, source.where)
    }
    // transformers.js' tokenizer loader asks whether tokenizer_config.json
    // exists WITHOUT the caller's revision (get_tokenizer_files), so it looks
    // under the unpinned key `<model>/tokenizer_config.json` and, when that is
    // missing, asks the network. Its contents are never read from there (the
    // load reads the pinned copy), only its existence: keep the verified copy
    // there, so a pinned model on disk loads offline with no request.
    if (pinnedDir && legacyDir && pin.files['tokenizer_config.json']) {
      const pinnedTc = join(pinnedDir, 'tokenizer_config.json')
      const legacyTc = join(legacyDir, 'tokenizer_config.json')
      if (statKey(legacyTc) === null && verifiedInProcess.has(pinnedTc)) {
        // A copy, not a link: linking would touch the pinned file's ctime.
        try { copyFileSync(pinnedTc, legacyTc) } catch { /* a lookup then asks the network */ }
      }
    }
  } finally {
    if (JSON.stringify(marker) !== before) writeMarker(pinnedDir, marker)
  }
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
      const weights = weightsFileFor(dtype)
      const cacheDir = await resolveLoadCacheDir(modelId, weights)
      const env = envOf(transformers)
      if (cacheDir && env) {
        // Assigned before the first load — after it the value is
        // already baked into the resolved paths and changing it does nothing.
        env.cacheDir = cacheDir
      }
      // Integrity first (security audit 2026-11-06, H-x03-1): the files
      // already on disk must match their pins, and old-layout files that do
      // are adopted into the pinned layout, before anything is loaded.
      await verifyPinnedModel(modelId, weights, cacheDir, 'before', 'embedding model')
      // Downloads off: the loader itself is told not to fetch anything. That
      // is not enough for a model missing from disk: some of transformers.js'
      // discovery steps ignore local_files_only and fetch config.json or look
      // up tokenizer_config.json. So a missing model is refused here, before
      // the library is asked (TEAM-5).
      await refuseMissingModelOffline(modelId, weights, 'embedding model')
      // The tokenizer and model are loaded directly at the pinned revision,
      // then wrapped in the feature-extraction pipeline exactly as
      // pipeline() does. pipeline() itself is not used: it resolves the
      // model's file list with neither the revision nor local_files_only
      // (get_pipeline_files), which fetches config.json from the moving
      // `main` branch (security audit 2026-11-06, H-x03-1).
      const T = transformers as unknown as {
        AutoTokenizer: { from_pretrained: (id: string, o?: object) => Promise<unknown> }
        AutoModel: { from_pretrained: (id: string, o?: object) => Promise<unknown> }
        FeatureExtractionPipeline: new (o: { task: string; model: unknown; tokenizer: unknown }) => unknown
      }
      const pinned = { ...pinnedLoadOptions(modelId), ...localOnlyOptions() }
      const [tokenizer, model] = await Promise.all([
        T.AutoTokenizer.from_pretrained(modelId, pinned),
        T.AutoModel.from_pretrained(modelId, { ...pinned, ...(dtype ? { dtype } : {}) }),
      ])
      try {
        // What the load downloaded is checked before the model is used.
        await verifyPinnedModel(modelId, weights, cacheDir, 'after', 'embedding model')
      } catch (err) {
        await disposeQuietly(model)
        throw err
      }
      const pipe = new T.FeatureExtractionPipeline({ task: 'feature-extraction', model, tokenizer })
      loadedKeys.add(key)
      return pipe
    })()
    // A failed load is not cached: the next call tries again.
    pending.catch(() => { if (pipelineCache.get(key) === pending) pipelineCache.delete(key) })
    pipelineCache.set(key, pending)
  }
  return await pending
}

/** Release a loaded model's ONNX session; a failure to do so is not the error to report. */
export async function disposeQuietly(model: unknown): Promise<void> {
  try { await (model as { dispose?: () => Promise<unknown> } | null)?.dispose?.() } catch { /* ignore */ }
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
    ...(config.searchInstruction ? { searchInstruction: config.searchInstruction } : {}),
    embed: embedOne,
    isLoaded: () => loadedKeys.has(keyOf(config.modelId, config.dtype)),
    modelPresent: () => modelPresence(config.modelId, weightsFileFor(config.dtype)),
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
