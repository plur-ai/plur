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
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
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

// The revision and per-file sha256 core pins for this model (security audit 2026-11-06,
// H-x03-1), read from core's source like the id above. The model is fetched at that
// commit, never from the moving `main` branch, and every file is checked against its
// pin: core refuses a file that does not match, so a cache this script calls good must
// hold exactly the pinned bytes.
const pinsSrc = new URL('../../packages/core/src/embedders/model-pins.ts', import.meta.url)
const pinBlock = readFileSync(pinsSrc, 'utf8').split(`'${modelId}': {`)[1]?.split(/\n  \},?\n/)[0]
const revision = pinBlock?.match(/revision:\s*'([0-9a-f]{40})'/)?.[1]
if (!revision) fail(`could not find the pinned revision for ${modelId} in ${pinsSrc.pathname}`)
const pinsText = readFileSync(pinsSrc, 'utf8')
const constOf = (name) => pinsText.match(new RegExp(`const ${name}\\s*=\\s*'([0-9a-f]{64})'`))?.[1]
const pins = {}
for (const m of pinBlock.matchAll(/'([^']+)':\s*(?:'([0-9a-f]{64})'|([A-Z_]+))/g)) {
  const sha = m[2] ?? constOf(m[3])
  if (!sha) fail(`could not resolve the sha256 pinned for ${modelId} ${m[1]}`)
  pins[m[1]] = sha
}
if (!pins['onnx/model.onnx']) fail(`no pinned weights for ${modelId} in ${pinsSrc.pathname}`)

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

// As core loads it (transformers-base.ts): tokenizer and model at the pinned revision,
// wrapped in the feature-extraction pipeline. Not pipeline(), which resolves the file
// list from `main`.
const pinnedDir = join(cacheDir, modelId, revision)
const opts = { revision, ...(mode === 'verify' ? { local_files_only: true } : {}) }
let pipe
try {
  const [tokenizer, model] = await Promise.all([
    t.AutoTokenizer.from_pretrained(modelId, opts),
    t.AutoModel.from_pretrained(modelId, { ...opts, dtype: 'fp32' }),
  ])
  pipe = new t.FeatureExtractionPipeline({ task: 'feature-extraction', model, tokenizer })
} catch (e) {
  fail(`${modelId}@${revision} did not load (${mode === 'verify' ? 'downloads off' : 'downloads on'}) from ${cacheDir}: ${e?.message ?? e}`)
}
for (const [file, expected] of Object.entries(pins)) {
  const p = join(pinnedDir, file)
  if (!existsSync(p)) fail(`${modelId} loaded, but ${file} is not in ${pinnedDir}, where core looks`)
  const actual = createHash('sha256').update(readFileSync(p)).digest('hex')
  if (actual !== expected) fail(`${p} does not match the sha256 core pins for ${file} (${actual} != ${expected})`)
}
// transformers.js asks whether tokenizer_config.json exists under the unpinned key
// (core keeps a copy there for the same reason; verifyPinnedModel).
const unpinnedTc = join(cacheDir, modelId, 'tokenizer_config.json')
if (!existsSync(unpinnedTc)) copyFileSync(join(pinnedDir, 'tokenizer_config.json'), unpinnedTc)

const out = await pipe('the model cache works offline', { pooling: 'cls', normalize: true })
const v = Array.from(out.data)
const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
if (v.length !== 384 || !v.every(Number.isFinite) || Math.abs(norm - 1) > 1e-3) {
  fail(`${modelId} gave a bad embedding: ${v.length} numbers, length ${norm}`)
}
console.log(`model provisioning: ${modelId} ${mode === 'verify' ? 'loads with downloads off' : 'is in the cache'} at ${revision}, every file matching its pin (${pinnedDir})`)
