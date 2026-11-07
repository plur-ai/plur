// security audit 2026-11-06 (H-x03-1): pinned revisions and sha256-checked model files; transformers.js is a double, files are dummies pinned via the test seam.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const REV = 'c0ffee0000000000000000000000000000000001'

type Call = { cls: string; id: string; opts: Record<string, unknown> }
const calls: Call[] = []
const fakeEnv: { cacheDir?: string | null; localModelPath?: string; allowLocalModels?: boolean } = {}
/** Files the fake "download" writes into the pinned folder during a load. */
let downloads: Record<string, string> | null = null

function fakeFromPretrained(cls: string, result: unknown) {
  return {
    from_pretrained: async (id: string, opts: Record<string, unknown> = {}) => {
      calls.push({ cls, id, opts })
      if (downloads && fakeEnv.cacheDir) {
        for (const [f, body] of Object.entries(downloads)) {
          const p = join(fakeEnv.cacheDir, id, String(opts.revision ?? 'main'), f)
          mkdirSync(dirname(p), { recursive: true })
          writeFileSync(p, body)
        }
      }
      return result
    },
  }
}

const fakeModel = Object.assign(async () => ({
  sentence_embedding: { data: new Float32Array(768) },
  logits: { data: new Float32Array([0.5]), dims: [1, 1] },
}), { dispose: async () => {} })

vi.mock('@huggingface/transformers', () => ({
  env: fakeEnv,
  AutoTokenizer: fakeFromPretrained('AutoTokenizer', async () => ({})),
  AutoModel: fakeFromPretrained('AutoModel', fakeModel),
  AutoModelForSequenceClassification: fakeFromPretrained('AutoModelForSequenceClassification', fakeModel),
  // Not callable, unlike the real pipeline: embed() fails after the load,
  // which is all these tests need (the load's options and its checks).
  FeatureExtractionPipeline: class { constructor(public o: unknown) {} },
  pipeline: async () => { throw new Error('pipeline() must not be used: it resolves files from the unpinned main branch') },
}))

const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_MODEL_DOWNLOAD', 'PLUR_MODEL_CACHE_DIR', 'HF_HOME'] as const
const saved: Record<string, string | undefined> = {}
let cache: string

/** Dummy files for a model with weights `weights`. */
function dummyFiles(weights: string, extra: string[] = []): Record<string, string> {
  const files: Record<string, string> = {
    [`onnx/${weights}`]: `weights for ${weights}`,
    'config.json': JSON.stringify({ model_type: 'bert' }),
    'tokenizer.json': '{"tokenizer":true}',
    'tokenizer_config.json': '{"tokenizer_config":true}',
  }
  for (const e of extra) files[`onnx/${e}`] = `chunk ${e}`
  return files
}

function seed(root: string, files: Record<string, string>): void {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true })
    writeFileSync(join(root, f), body)
  }
}

async function freshCore() {
  vi.resetModules()
  const pins = await import('../src/embedders/model-pins.js')
  const base = await import('../src/embedders/transformers-base.js')
  return { pins, base }
}

const pinOf = (files: Record<string, string>) => ({ revision: REV, files: Object.fromEntries(Object.entries(files).map(([f, b]) => [f, sha(b)])) })

function pinDummy(pins: { _setModelPinsForTesting: (p: Record<string, { revision: string; files: Record<string, string> }> | undefined) => void }, modelId: string, files: Record<string, string>) {
  pins._setModelPinsForTesting({ [modelId]: pinOf(files) })
}

beforeEach(() => {
  calls.length = 0
  downloads = null
  for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k] }
  cache = mkdtempSync(join(tmpdir(), 'plur-pin-cache-'))
  process.env.PLUR_MODEL_CACHE_DIR = cache
  delete fakeEnv.cacheDir
  fakeEnv.localModelPath = join(cache, '.no-local-models') + '/'
  fakeEnv.allowLocalModels = true
})

afterEach(() => {
  for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  rmSync(cache, { recursive: true, force: true })
})

describe('the manifest pins every model PLUR can load', () => {
  it('has a 40-hex revision and a sha256 for each file the load reads', async () => {
    const { MODEL_PINS } = await import('../src/embedders/model-pins.js')
    const { EMBEDDER_NAMES, getEmbedder } = await import('../src/embedders/index.js')
    const { RERANKER_NAMES, getReranker } = await import('../src/rerankers/index.js')
    // The dtype each loader uses (bge/minilm fp32; gemma and rerankers q8).
    const weightsOf: Record<string, string> = {
      minilm: 'model.onnx', 'bge-small': 'model.onnx', 'bge-base': 'model.onnx',
      'embedding-gemma': 'model_quantized.onnx',
      'bge-reranker-v2-m3': 'model_quantized.onnx', 'ms-marco-minilm-l6': 'model_quantized.onnx',
    }
    const ids: Array<[string, string]> = []
    for (const n of EMBEDDER_NAMES) if (n !== 'openai-3-large') ids.push([n, getEmbedder(n).modelId])
    for (const n of RERANKER_NAMES) if (n !== 'off') ids.push([n, getReranker(n).modelId])
    expect(ids.length).toBe(6)
    for (const [name, id] of ids) {
      const pin = MODEL_PINS[id]
      expect(pin, `${name} (${id}) has no pin`).toBeDefined()
      expect(pin.revision).toMatch(/^[0-9a-f]{40}$/)
      const files = Object.keys(pin.files)
      for (const f of [`onnx/${weightsOf[name]}`, 'config.json', 'tokenizer.json', 'tokenizer_config.json']) {
        expect(files, `${id} misses ${f}`).toContain(f)
      }
      for (const h of Object.values(pin.files)) expect(h).toMatch(/^[0-9a-f]{64}$/)
    }
    // EmbeddingGemma's config declares one external-data chunk for its q8 weights.
    expect(Object.keys(MODEL_PINS['onnx-community/embeddinggemma-300m-ONNX'].files)).toContain('onnx/model_quantized.onnx_data')
    // Nothing pinned that no loader uses.
    expect(Object.keys(MODEL_PINS).sort()).toEqual(ids.map(([, id]) => id).sort())
  })
})

describe('the cache layout of a pinned model', () => {
  it('modelPresence and the cache choice see files in <cache>/<model>/<revision>', async () => {
    const { pins, base } = await freshCore()
    const id = 'Xenova/bge-small-en-v1.5'
    const files = dummyFiles('model.onnx')
    pinDummy(pins, id, files)
    seed(join(cache, id, REV), files)
    expect(await base.modelPresence(id, 'model.onnx')).toBe(true)
    expect(await base.resolveLoadCacheDir(id, 'model.onnx')).toBe(cache)
    // Missing one pinned file: not present.
    rmSync(join(cache, id, REV, 'tokenizer.json'))
    expect(await base.modelPresence(id, 'model.onnx')).toBe(false)
  })
})

describe('loaders pass the pinned revision', () => {
  it('every loader loads tokenizer and model at the pin, not through pipeline()', async () => {
    const { pins, base } = await freshCore()
    const { makeEmbeddingGemmaAdapter } = await import('../src/embedders/embedding-gemma.js')
    const { makeMsMarcoMiniLmL6Adapter, makeBgeRerankerV2M3Adapter } = await import('../src/rerankers/transformers-cross-encoder.js')
    const q8 = dummyFiles('model_quantized.onnx')
    const table: Array<[string, Record<string, string>, () => Promise<unknown>]> = [
      ['Xenova/bge-small-en-v1.5', dummyFiles('model.onnx'),
        () => base.makeTransformersAdapter({ name: 'bge-small', dim: 384, modelId: 'Xenova/bge-small-en-v1.5', pooling: 'cls', dtype: 'fp32' }).embed('x')],
      ['onnx-community/embeddinggemma-300m-ONNX', dummyFiles('model_quantized.onnx', ['model_quantized.onnx_data']),
        () => makeEmbeddingGemmaAdapter().embed('x', 'query')],
      ['Xenova/ms-marco-MiniLM-L-6-v2', q8, () => makeMsMarcoMiniLmL6Adapter().scoreBatch('q', ['d'])],
      ['onnx-community/bge-reranker-v2-m3-ONNX', q8, () => makeBgeRerankerV2M3Adapter().scoreBatch('q', ['d'])],
    ]
    pins._setModelPinsForTesting(Object.fromEntries(table.map(([id, files]) => [id, pinOf(files)])))
    for (const [id, files, load] of table) {
      seed(join(cache, id, REV), files)
      // The double's pipeline object is not callable, so embed() fails after the load.
      await load().catch(() => {})
      const loads = calls.filter(c => c.id === id)
      expect(loads.length, `${id} was not loaded`).toBe(2)
      for (const c of loads) expect(c.opts.revision, `${c.cls} ${id}`).toBe(REV)
    }
    expect(fakeEnv.cacheDir).toBe(cache)
  })
})

describe('integrity: a file that does not match its pin is never used', () => {
  it('a tampered cached file is refused before the load, naming the file and the folder to delete', async () => {
    const { pins, base } = await freshCore()
    const id = 'Xenova/bge-small-en-v1.5'
    const files = dummyFiles('model.onnx')
    pinDummy(pins, id, files)
    seed(join(cache, id, REV), files)
    appendFileSync(join(cache, id, REV, 'onnx', 'model.onnx'), 'X')
    const err = await base.verifyPinnedModel(id, cache).catch(e => e)
    expect(err.message).toMatch(/corrupt/)
    expect(err.message).toContain(join(cache, id, REV, 'onnx', 'model.onnx'))
    expect(err.message).toContain(`Delete ${join(cache, id)}`)
    // Classified as the corrupt-cache case by the reranker/doctor path.
    const { classifyRerankerFailure } = await import('../src/rerankers/index.js')
    expect(classifyRerankerFailure(err.message)).toBe('corrupt-cache')
    // And through a loader: the model is never loaded.
    const adapter = base.makeTransformersAdapter({ name: 'bge-small', dim: 384, modelId: id, pooling: 'cls', dtype: 'fp32' })
    await expect(adapter.embed('x')).rejects.toThrow(/corrupt/)
    expect(calls.filter(c => c.id === id)).toEqual([])
  })

  it('a tampered download is refused after the load, before the model is used', async () => {
    const { pins } = await freshCore()
    const id = 'Xenova/ms-marco-MiniLM-L-6-v2'
    const files = dummyFiles('model_quantized.onnx')
    pinDummy(pins, id, files)
    downloads = { ...files, 'onnx/model_quantized.onnx': 'not the pinned weights' }
    const { makeMsMarcoMiniLmL6Adapter } = await import('../src/rerankers/transformers-cross-encoder.js')
    await expect(makeMsMarcoMiniLmL6Adapter().scoreBatch('q', ['d'])).rejects.toThrow(/onnx\/model_quantized\.onnx does not match.*corrupt/)
  })

  it('a model with no pin is refused', async () => {
    const { base } = await freshCore()
    const adapter = base.makeTransformersAdapter({ name: 'stub', dim: 384, modelId: 'example/unpinned', pooling: 'mean' })
    await expect(adapter.embed('x')).rejects.toThrow(/no integrity pin/)
    expect(calls).toEqual([])
  })
})

describe('an existing cache in the old, unpinned layout', () => {
  it('is adopted and used offline when its files match the pins, with no download', async () => {
    const { pins, base } = await freshCore()
    process.env.PLUR_OFFLINE = '1'
    const id = 'Xenova/bge-small-en-v1.5'
    const files = dummyFiles('model.onnx')
    pinDummy(pins, id, files)
    seed(join(cache, id), files) // <cache>/<model>/<file>: the pre-pin layout
    expect(await base.modelPresence(id, 'model.onnx')).toBe(true)
    const adapter = base.makeTransformersAdapter({ name: 'bge-small', dim: 384, modelId: id, pooling: 'cls', dtype: 'fp32' })
    await adapter.embed('x').catch(() => {})
    const loads = calls.filter(c => c.id === id)
    expect(loads.length).toBe(2)
    for (const c of loads) {
      expect(c.opts.revision).toBe(REV)
      expect(c.opts.local_files_only).toBe(true)
    }
    for (const f of Object.keys(files)) expect(readFileSync(join(cache, id, REV, f), 'utf8')).toBe(files[f])
  })

  it('is not used when a file does not match: offline, the load is refused', async () => {
    const { pins, base } = await freshCore()
    process.env.PLUR_OFFLINE = '1'
    const id = 'Xenova/bge-small-en-v1.5'
    const files = dummyFiles('model.onnx')
    pinDummy(pins, id, files)
    seed(join(cache, id), { ...files, 'tokenizer.json': '{"tampered":true}' })
    const adapter = base.makeTransformersAdapter({ name: 'bge-small', dim: 384, modelId: id, pooling: 'cls', dtype: 'fp32' })
    await expect(adapter.embed('x')).rejects.toThrow(/tokenizer\.json does not match.*corrupt.*Delete/)
    expect(calls).toEqual([])
  })
})
