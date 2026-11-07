// Puts the embedding model the quality evals need into PLUR_MODEL_CACHE_DIR, and proves
// it is usable offline, BEFORE any eval runs (second audit R-07). The evals block every
// network request (helpers/setup.ts), so on a clean runner with an empty cache the real
// model could never be downloaded and the quality evals could not measure anything.
//
//   node evals/helpers/provision-model.mjs fetch    # download into the cache if missing
//   node evals/helpers/provision-model.mjs verify   # load it with downloads OFF, embed once
//
// Run `verify` as its own process after `fetch`: it is what shows the cache alone is enough.
// The model id is read from core's source, so this never drifts from what core loads.
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const fail = (msg) => { console.error(`model provisioning: ${msg}`); process.exit(1) }
const mode = process.argv[2]
if (mode !== 'fetch' && mode !== 'verify') fail('usage: provision-model.mjs fetch|verify')

const cacheDir = process.env.PLUR_MODEL_CACHE_DIR
if (!cacheDir) fail('PLUR_MODEL_CACHE_DIR is not set; the evals read the model from there')

const coreSrc = new URL('../../packages/core/src/embedders/bge-small.ts', import.meta.url)
const modelId = readFileSync(coreSrc, 'utf8').match(/BGE_SMALL_MODEL_ID\s*=\s*'([^']+)'/)?.[1]
if (!modelId) fail(`could not find BGE_SMALL_MODEL_ID in ${coreSrc.pathname}`)

// The files core checks before it loads from a cache (transformers-base.ts requiredFiles, fp32).
const files = ['onnx/model.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json']

// Core's own copy of transformers.js (pnpm does not hoist it to the repo root).
const require = createRequire(new URL('../../packages/core/package.json', import.meta.url))
const t = await import(pathToFileURL(require.resolve('@huggingface/transformers')).href)
process.env.HF_HUB_DISABLE_XET ??= '1'   // as core: Xet truncates the ONNX file (#340)
t.env.cacheDir = cacheDir
if (mode === 'verify') {
  // Downloads off; the only other source, the local-model folder, points nowhere.
  t.env.allowRemoteModels = false
  t.env.localModelPath = join(cacheDir, '.no-local-models')
} else {
  t.env.allowLocalModels = false
}

let pipe
try {
  pipe = await t.pipeline('feature-extraction', modelId, { dtype: 'fp32', ...(mode === 'verify' ? { local_files_only: true } : {}) })
} catch (e) {
  fail(`${modelId} did not load (${mode === 'verify' ? 'downloads off' : 'downloads on'}) from ${cacheDir}: ${e?.message ?? e}`)
}
const missing = files.filter(f => !existsSync(join(cacheDir, modelId, f)))
if (missing.length) fail(`${modelId} loaded, but ${missing.join(', ')} are not in ${join(cacheDir, modelId)}, where core looks`)

const out = await pipe('the model cache works offline', { pooling: 'cls', normalize: true })
const v = Array.from(out.data)
const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
if (v.length !== 384 || !v.every(Number.isFinite) || Math.abs(norm - 1) > 1e-3) {
  fail(`${modelId} gave a bad embedding: ${v.length} numbers, length ${norm}`)
}
console.log(`model provisioning: ${modelId} ${mode === 'verify' ? 'loads with downloads off' : 'is in the cache'} (${join(cacheDir, modelId)})`)
