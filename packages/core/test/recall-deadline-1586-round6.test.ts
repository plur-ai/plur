/**
 * #1586 audit round 6 (PR #1587).
 *
 *   G1  a model in the library's default cache is still found when
 *       PLUR_MODEL_CACHE_DIR / HF_HOME point at an empty cache.
 *   G2  external-data files declared by the model's config are part of the
 *       presence check.
 *   L3  presence is checked per file, in every place the loader looks.
 *   L1  two processes adding different vectors both keep them.
 *   L2  a cut-off recall does not rewrite the whole cache on the reply path.
 *   L4  no background fill for a remote embedder.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { Plur } from '../src/index.js'
import * as emb from '../src/embeddings.js'
import * as tb from '../src/embedders/transformers-base.js'

const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const CHILD = fileURLToPath(new URL('./helpers/embedding-cache-saver-child.mjs', import.meta.url))

const dirs: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

const ENV_KEYS = ['PLUR_MODEL_CACHE_DIR', 'HF_HOME', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_MODEL_DOWNLOAD', 'PLUR_EMBEDDER'] as const
const savedEnv: Record<string, string | undefined> = {}
let wasDisabled = false
let savedLocal: { localModelPath?: string } = {}

beforeEach(async () => {
  wasDisabled = emb.embedderStatus().disabled
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
  const t = await import('@huggingface/transformers') as unknown as { env: { localModelPath: string } }
  savedLocal = { localModelPath: t.env.localModelPath }
})

afterEach(async () => {
  vi.unstubAllGlobals()
  ;(tb as any)._setDefaultModelCacheDir?.(undefined)
  ;(emb as any)._resetBackgroundModelLoad?.()
  tb._resetTransformersPipelineCache()
  emb.resetEmbedder()
  emb.setEmbeddingsEnabled(!wasDisabled)
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  const t = await import('@huggingface/transformers') as unknown as { env: { localModelPath: string } }
  t.env.localModelPath = savedLocal.localModelPath as string
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const GEMMA = 'onnx-community/embeddinggemma-300m-ONNX'
const BGE = 'Xenova/bge-small-en-v1.5'

function provision(root: string, modelId: string, weights: string, config: object = {}, extra: string[] = []): void {
  const m = join(root, modelId)
  mkdirSync(join(m, 'onnx'), { recursive: true })
  writeFileSync(join(m, 'onnx', weights), 'w')
  for (const f of extra) writeFileSync(join(m, 'onnx', f), 'd')
  writeFileSync(join(m, 'config.json'), JSON.stringify(config))
  writeFileSync(join(m, 'tokenizer.json'), '{}')
  writeFileSync(join(m, 'tokenizer_config.json'), '{}')
}

function countingFetch(): { calls: () => number } {
  let n = 0
  vi.stubGlobal('fetch', (() => { n++; return new Promise(() => { /* never */ }) }) as unknown as typeof fetch)
  return { calls: () => n }
}

describe('G1 — a model in the default cache is found when the override cache is empty', () => {
  it('EmbeddingGemma: present, loaded from the default cache, nothing fetched', async () => {
    const defaultCache = tmp('plur-1587-r6-default-')
    provision(defaultCache, GEMMA, 'model_quantized.onnx')
    expect(typeof (tb as any)._setDefaultModelCacheDir).toBe('function')
    ;(tb as any)._setDefaultModelCacheDir(defaultCache)
    process.env.HF_HOME = tmp('plur-1587-r6-hfhome-') // empty
    process.env.PLUR_EMBEDDER = 'embedding-gemma'
    emb.setEmbeddingsEnabled(true)
    emb.resetEmbedder()
    const f = countingFetch()
    expect(await emb.semanticModelState()).toBe('cached')
    expect(await (tb as any).resolveLoadCacheDir(GEMMA, 'model_quantized.onnx')).toBe(defaultCache)
    expect(f.calls()).toBe(0)
  })
})

describe('G2 — external-data files are part of the presence check', () => {
  it('a declared model_quantized.onnx_data must be on disk; offline, nothing is fetched', async () => {
    const cache = tmp('plur-1587-r6-cache-')
    const config = { 'transformers.js_config': { use_external_data_format: { 'model_quantized.onnx': 1 } } }
    provision(cache, GEMMA, 'model_quantized.onnx', config)
    process.env.PLUR_MODEL_CACHE_DIR = cache
    process.env.PLUR_EMBEDDER = 'embedding-gemma'
    process.env.HF_HUB_OFFLINE = '1'
    emb.setEmbeddingsEnabled(true)
    emb.resetEmbedder()
    const f = countingFetch()
    expect(await emb.semanticModelState()).toBe('missing')
    expect(await emb.embed('anything')).toBeNull()
    expect(f.calls()).toBe(0)
    writeFileSync(join(cache, GEMMA, 'onnx', 'model_quantized.onnx_data'), 'd')
    expect(await emb.semanticModelState()).toBe('cached')
  })
})

describe('L3 — presence per file, wherever the loader looks', () => {
  it('weights under localModelPath plus tokenizer and config in the cache count as present', async () => {
    const cache = tmp('plur-1587-r6-cache-')
    const local = tmp('plur-1587-r6-local-')
    mkdirSync(join(local, BGE, 'onnx'), { recursive: true })
    writeFileSync(join(local, BGE, 'onnx', 'model.onnx'), 'w')
    mkdirSync(join(cache, BGE), { recursive: true })
    for (const fl of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) writeFileSync(join(cache, BGE, fl), '{}')
    process.env.PLUR_MODEL_CACHE_DIR = cache
    const t = await import('@huggingface/transformers') as unknown as { env: { localModelPath: string } }
    t.env.localModelPath = local
    emb.setEmbeddingsEnabled(true)
    emb.resetEmbedder()
    expect(await emb.semanticModelState()).toBe('cached')
  })
})

describe('L1 — concurrent savers keep each other\'s vectors', () => {
  function runChild(job: object): Promise<number> {
    return new Promise(resolve => {
      const c = spawn(process.execPath, [CHILD, JSON.stringify({ dist: DIST, ...job })], { stdio: ['ignore', 'ignore', 'pipe'] })
      c.on('exit', code => resolve(code ?? 1))
    })
  }

  it('two processes adding different vectors at the same time: both sides survive', async () => {
    const dir = tmp('plur-1587-r6-l1-')
    const cachePath = join(dir, '.embeddings-cache.json')
    const embedder = { name: 'race-test', dim: 4 }
    const codes = await Promise.all([
      runChild({ cachePath, embedder, prefix: 'a', count: 40 }),
      runChild({ cachePath, embedder, prefix: 'b', count: 40 }),
    ])
    expect(codes).toEqual([0, 0])
    const read = (await import('../src/embeddings.js') as any)._readEmbeddingCacheEntries
    expect(typeof read).toBe('function')
    const entries = read(cachePath, embedder)
    const ids = Object.keys(entries)
    expect(ids.filter(i => i.startsWith('a-'))).toHaveLength(40)
    expect(ids.filter(i => i.startsWith('b-'))).toHaveLength(40)
  }, 60_000)

  it('a save that cannot take the lock in time is skipped, not blocked', async () => {
    const dir = tmp('plur-1587-r6-l1b-')
    const cachePath = join(dir, '.embeddings-cache.json')
    const { makeToken } = await import('../src/store/async-lock.js')
    writeFileSync(`${cachePath}.lock`, makeToken()) // a live holder
    const save = (emb as any)._appendEmbeddingCacheEntries
    expect(typeof save).toBe('function')
    const t0 = Date.now()
    expect(save(cachePath, { name: 'x', dim: 4 }, { a: { hash: 'h', embedding: [0, 0, 0, 1] } })).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

/** A deterministic stand-in embedder that takes `ms` per text. */
function slowEmbedder(ms: number, extra: Record<string, unknown> = {}): void {
  const vec = (text: string): Float32Array => {
    const v = new Float32Array(384)
    for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 384] += 1
    let n = 0
    for (const x of v) n += x * x
    n = Math.sqrt(n) || 1
    return v.map(x => x / n)
  }
  emb._setCachedEmbedder({
    name: 'slow-test', dim: 384, modelId: 'test/slow',
    embed: (t: string) => new Promise<Float32Array>(r => setTimeout(() => r(vec(t)), ms)),
    embedBatch: async (ts: string[]) => ts.map(vec),
    ...extra,
  } as any)
}

async function storeWith(n: number, prefix = 'release checklist item'): Promise<{ plur: Plur; dir: string }> {
  const dir = tmp('plur-1587-r6-store-')
  writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
  const plur = new Plur({ path: dir })
  for (let i = 0; i < n; i++) await plur.learn(`${prefix} number ${i} covers step ${i * 7} of the rollout`)
  return { plur, dir }
}

describe('L2 — a cut-off recall writes only what changed', () => {
  it('the main cache file is not rewritten at the deadline; the new vectors still persist', async () => {
    const { plur, dir } = await storeWith(30)
    emb.setEmbeddingsEnabled(true)
    slowEmbedder(1)
    const warm = await plur.recallHybridWithMeta('release checklist rollout', { deadline_ms: 10_000, remote: false })
    expect(warm.mode).toBe('hybrid')
    const main = join(dir, '.embeddings-cache.json')
    const before = statSync(main).mtimeMs
    emb.setEmbeddingsEnabled(false)
    for (let i = 0; i < 20; i++) await plur.learn(`deploy runbook entry ${i} explains canary step ${i}`)
    emb.setEmbeddingsEnabled(true)
    slowEmbedder(40)
    await new Promise(r => setTimeout(r, 20))
    const cut = await plur.recallHybridWithMeta('deploy runbook canary', { deadline_ms: 250, remote: false })
    expect(cut.results_complete).toBe(false)
    await new Promise(r => setTimeout(r, 100))
    expect(statSync(main).mtimeMs).toBe(before)
    const read = (emb as any)._readEmbeddingCacheEntries
    expect(typeof read).toBe('function')
    expect(Object.keys(read(main, { name: 'slow-test', dim: 384 })).length).toBeGreaterThan(30)
  }, 30_000)
})

describe('L4 — no background fill for a remote embedder', () => {
  it('an embedder marked remote is not filled in the background', async () => {
    const { plur } = await storeWith(12)
    emb.setEmbeddingsEnabled(true)
    slowEmbedder(30, { remote: true })
    emb.allowBackgroundModelLoad(true)
    await plur.recallHybridWithMeta('release checklist rollout', { deadline_ms: 80, remote: false })
    expect((plur as any)._embeddingFillStarts).toBe(0)
  }, 15_000)
})
