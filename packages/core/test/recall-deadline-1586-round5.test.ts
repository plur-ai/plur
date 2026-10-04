/**
 * #1586 audit round 5 (PR #1587).
 *
 *   R3      a recall cut by the deadline keeps the vectors it computed, so a
 *           store without an embedding cache becomes hybrid across recalls;
 *           an opted-in long-lived process fills the cache in the background.
 *   L-learn every embedding path (learn-time ones included) honours the
 *           offline switches: no fetch.
 *   L-gemma the EmbeddingGemma adapter reports a missing model.
 *   presence the model counts as present only with its tokenizer files too.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import * as emb from '../src/embeddings.js'
import { _resetTransformersPipelineCache } from '../src/embedders/transformers-base.js'

const dirs: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

const ENV_KEYS = ['PLUR_MODEL_CACHE_DIR', 'HF_HOME', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_MODEL_DOWNLOAD', 'PLUR_EMBEDDER'] as const
const savedEnv: Record<string, string | undefined> = {}
let wasDisabled = false

beforeEach(() => {
  wasDisabled = emb.embedderStatus().disabled
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
})

afterEach(async () => {
  vi.unstubAllGlobals()
  ;(emb as any)._resetBackgroundModelLoad?.()
  _resetTransformersPipelineCache()
  emb.resetEmbedder()
  emb.setEmbeddingsEnabled(!wasDisabled)
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A deterministic stand-in embedder that takes `ms` per text. */
function slowEmbedder(ms: number): void {
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
  })
}

async function storeWith(n: number): Promise<{ plur: Plur; dir: string }> {
  const dir = tmp('plur-1587-r5-')
  writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
  const plur = new Plur({ path: dir })
  for (let i = 0; i < n; i++) await plur.learn(`release checklist item number ${i} covers step ${i * 7} of the rollout`)
  return { plur, dir }
}

const cachedCount = (dir: string): number => {
  const p = join(dir, '.embeddings-cache.json')
  if (!existsSync(p)) return 0
  return Object.keys(JSON.parse(readFileSync(p, 'utf8')).entries ?? {}).length
}

describe('R3 — a cut-off recall keeps the vectors it computed', () => {
  it('each cut-off recall caches strictly more, and the store becomes fully hybrid', async () => {
    const { plur, dir } = await storeWith(24)
    emb.setEmbeddingsEnabled(true)
    slowEmbedder(40) // ~1 s to embed the whole store; the deadline is 300 ms
    const first = await plur.recallHybridWithMeta('release checklist rollout', { deadline_ms: 300, remote: false })
    expect(first.results_complete).toBe(false)
    await new Promise(r => setTimeout(r, 150)) // the abandoned leg saves what it has
    const n1 = cachedCount(dir)
    expect(n1).toBeGreaterThan(0)
    await plur.recallHybridWithMeta('release checklist rollout', { deadline_ms: 300, remote: false })
    await new Promise(r => setTimeout(r, 150))
    const n2 = cachedCount(dir)
    expect(n2).toBeGreaterThan(n1)
    let last = first
    for (let i = 0; i < 12 && !(last.results_complete && last.mode === 'hybrid'); i++) {
      last = await plur.recallHybridWithMeta('release checklist rollout', { deadline_ms: 300, remote: false })
      await new Promise(r => setTimeout(r, 150))
    }
    expect(last.mode).toBe('hybrid')
    expect(last.results_complete).toBe(true)
  }, 30_000)

  it('an opted-in long-lived process fills the cache in the background, once', async () => {
    const { plur, dir } = await storeWith(24)
    emb.setEmbeddingsEnabled(true)
    slowEmbedder(20)
    emb.allowBackgroundModelLoad(true)
    await plur.recallHybridWithMeta('release checklist rollout', { deadline_ms: 100, remote: false })
    await plur.recallHybridWithMeta('release checklist rollout', { deadline_ms: 100, remote: false })
    // No further recalls: the background fill alone completes the cache.
    const until = Date.now() + 8000
    while (cachedCount(dir) < 24 && Date.now() < until) await new Promise(r => setTimeout(r, 100))
    expect(cachedCount(dir)).toBe(24)
    expect((plur as any)._embeddingFillStarts).toBe(1)
  }, 15_000)
})

describe('L-learn — every embedding path honours the offline switches', () => {
  for (const [key, value] of [['HF_HUB_OFFLINE', '1'], ['TRANSFORMERS_OFFLINE', '1'], ['PLUR_MODEL_DOWNLOAD', 'off']] as const) {
    it(`${key}=${value}: learn (near-duplicate check) and recall make no fetch`, async () => {
      const dir = tmp('plur-1587-r5-learn-')
      writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
      const plur = new Plur({ path: dir })
      await plur.learn('the deploy checklist lives in the release runbook')
      process.env.PLUR_MODEL_CACHE_DIR = tmp('plur-1587-r5-models-')
      process.env[key] = value
      emb.setEmbeddingsEnabled(true)
      emb.resetEmbedder()
      let fetches = 0
      vi.stubGlobal('fetch', (() => { fetches++; return new Promise(() => { /* never */ }) }) as unknown as typeof fetch)
      const learn = plur.learn('the deploy checklist lives in the release runbook folder')
      await Promise.race([learn, new Promise(r => setTimeout(r, 3000))])
      const near = plur.nearDuplicates('the deploy checklist lives in the release runbook').catch(() => null)
      await Promise.race([near, new Promise(r => setTimeout(r, 3000))])
      await new Promise(r => setTimeout(r, 200))
      expect(fetches).toBe(0)
    }, 15_000)
  }
})

describe('L-gemma and presence', () => {
  it('EmbeddingGemma with an empty cache is reported missing, not unknown', async () => {
    process.env.PLUR_MODEL_CACHE_DIR = tmp('plur-1587-r5-models-')
    process.env.PLUR_EMBEDDER = 'embedding-gemma'
    emb.setEmbeddingsEnabled(true)
    emb.resetEmbedder()
    expect(await emb.semanticModelState()).toBe('missing')
  })

  it('weights without the tokenizer files do not count as present', async () => {
    const cache = tmp('plur-1587-r5-models-')
    process.env.PLUR_MODEL_CACHE_DIR = cache
    mkdirSync(join(cache, 'Xenova', 'bge-small-en-v1.5', 'onnx'), { recursive: true })
    writeFileSync(join(cache, 'Xenova', 'bge-small-en-v1.5', 'onnx', 'model.onnx'), 'x')
    emb.setEmbeddingsEnabled(true)
    emb.resetEmbedder()
    expect(await emb.semanticModelState()).toBe('missing')
    for (const f of ['tokenizer.json', 'tokenizer_config.json', 'config.json']) {
      writeFileSync(join(cache, 'Xenova', 'bge-small-en-v1.5', f), '{}')
    }
    expect(await emb.semanticModelState()).toBe('cached')
  })
})
