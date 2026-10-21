/**
 * TEAM-5 siblings (audit 6, N4): once PLUR has inferred it is offline (the npm
 * update check could not connect), NO automatic model or tokenizer download
 * may start: not for EmbeddingGemma, and not for the transformers
 * cross-encoder rerankers either. No offline variable is set: a machine with
 * no internet does not say so.
 *
 * Requests are intercepted at the transport: the global fetch, the fetch that
 * transformers.js captured at import (`env.fetch`, which a global stub alone
 * does not replace), sockets and DNS. A model already on disk still loads,
 * from disk only, with no request.
 */
import dns from 'node:dns'
import net from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getEmbedder } from '../src/embedders/index.js'
import { _resetEmbeddingGemmaCache, EMBEDDING_GEMMA_MODEL_ID } from '../src/embedders/embedding-gemma.js'
import {
  _resetTransformersPipelineCache, _setDefaultModelCacheDir, envOf, importTransformers, modelPresence,
} from '../src/embedders/transformers-base.js'
import {
  _resetCrossEncoderCaches, makeBgeRerankerV2M3Adapter, makeMsMarcoMiniLmL6Adapter, MS_MARCO_MINILM_L6_MODEL_ID,
} from '../src/rerankers/transformers-cross-encoder.js'
import { checkForUpdate, clearVersionCache, settleVersionChecks, updateCheckOffline } from '../src/version-check.js'

const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER', 'PLUR_MODEL_DOWNLOAD', 'PLUR_MODEL_CACHE_DIR', 'HF_HOME'] as const

const dirs: string[] = []
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d }
const settle = (ms: number) => new Promise(r => setTimeout(r, ms))

type Env = { fetch?: unknown; cacheDir?: string | null }

describe('after a failed update check, no automatic Gemma or reranker download', () => {
  const attempts: string[] = []
  let tEnv: Env
  const saved = {
    fetch: globalThis.fetch,
    envFetch: undefined as unknown,
    envCacheDir: undefined as string | null | undefined,
    connect: net.Socket.prototype.connect,
    lookup: dns.lookup,
    env: {} as Record<string, string | undefined>,
  }

  const blocked = (via: string) => (async (input: unknown) => {
    attempts.push(`${via} ${String((input as { url?: string })?.url ?? input)}`)
    throw new TypeError('fetch failed: the network is blocked in this test')
  }) as typeof globalThis.fetch

  beforeEach(async () => {
    attempts.length = 0
    for (const k of VARS) { saved.env[k] = process.env[k]; delete process.env[k] }
    tEnv = envOf(await importTransformers()) as Env
    saved.envFetch = tEnv.fetch
    saved.envCacheDir = tEnv.cacheDir
    globalThis.fetch = blocked('fetch')
    tEnv.fetch = blocked('env.fetch')
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      attempts.push(`socket ${JSON.stringify(args[0])}`)
      throw new Error('connect blocked')
    } as typeof net.Socket.prototype.connect
    ;(dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
      attempts.push(`dns ${host}`)
      const cb = rest.find(r => typeof r === 'function') as ((e: Error) => void) | undefined
      cb?.(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }))
    }
    clearVersionCache()
    _resetEmbeddingGemmaCache()
    _resetCrossEncoderCaches()
    _resetTransformersPipelineCache()
  })

  afterEach(async () => {
    await settleVersionChecks()
    await settle(50)
    globalThis.fetch = saved.fetch
    tEnv.fetch = saved.envFetch
    tEnv.cacheDir = saved.envCacheDir
    net.Socket.prototype.connect = saved.connect
    ;(dns as { lookup: unknown }).lookup = saved.lookup
    for (const k of VARS) { if (saved.env[k] === undefined) delete process.env[k]; else process.env[k] = saved.env[k] }
    clearVersionCache()
    _resetEmbeddingGemmaCache()
    _resetCrossEncoderCaches()
    _resetTransformersPipelineCache()
    _setDefaultModelCacheDir(undefined)
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** An empty model cache: both the override and the library default. */
  function emptyCache(): void {
    const cache = tmp('plur-offline-sib-models-')
    process.env.PLUR_MODEL_CACHE_DIR = cache
    _setDefaultModelCacheDir(tmp('plur-offline-sib-default-'))
    tEnv.cacheDir = cache
  }

  /** A cache in which `modelId` is complete on disk (files present; the
   *  weights are not a real model, so the load itself may still fail). */
  function cacheWith(modelId: string, weights: string): void {
    const cache = tmp('plur-offline-sib-present-')
    const root = join(cache, modelId)
    mkdirSync(join(root, 'onnx'), { recursive: true })
    writeFileSync(join(root, 'config.json'), JSON.stringify({ model_type: 'bert' }))
    writeFileSync(join(root, 'tokenizer.json'), '{}')
    writeFileSync(join(root, 'tokenizer_config.json'), '{}')
    writeFileSync(join(root, 'onnx', weights), 'not a real model')
    process.env.PLUR_MODEL_CACHE_DIR = cache
    _setDefaultModelCacheDir(tmp('plur-offline-sib-default-'))
    tEnv.cacheDir = cache
  }

  async function failedRegistryCheck(): Promise<number> {
    await checkForUpdate('@plur-ai/example', '1.0.0')
    expect(updateCheckOffline(), 'the failed check should mark the process offline').toBe(true)
    expect(attempts.length).toBeGreaterThan(0)
    return attempts.length
  }

  const after = (before: number) => attempts.slice(before)

  it('EmbeddingGemma: an uncached model makes no transport attempt after the failed check', async () => {
    emptyCache()
    const before = await failedRegistryCheck()
    const refused = await getEmbedder('embedding-gemma').embed('which checklist covers deploys').then(() => 'loaded', (e: Error) => e.message)
    await settle(100)
    expect(after(before), `EmbeddingGemma tried the network after the failed check: ${JSON.stringify(attempts)}`).toEqual([])
    expect(refused, 'refused before transformers.js is asked').toMatch(/not on disk/)
  }, 30_000)

  it('ms-marco reranker: an uncached model makes no transport attempt after the failed check', async () => {
    emptyCache()
    const before = await failedRegistryCheck()
    const refused = await makeMsMarcoMiniLmL6Adapter().scoreBatch('release', ['release checklist']).then(() => 'loaded', (e: Error) => e.message)
    await settle(100)
    expect(after(before), `the reranker tried the network after the failed check: ${JSON.stringify(attempts)}`).toEqual([])
    expect(refused, 'refused before transformers.js is asked').toMatch(/not on disk/)
  }, 30_000)

  it('bge reranker: an uncached model makes no transport attempt after the failed check', async () => {
    emptyCache()
    const before = await failedRegistryCheck()
    const refused = await makeBgeRerankerV2M3Adapter().scoreBatch('release', ['release checklist']).then(() => 'loaded', (e: Error) => e.message)
    await settle(100)
    expect(after(before), `the reranker tried the network after the failed check: ${JSON.stringify(attempts)}`).toEqual([])
    expect(refused, 'refused before transformers.js is asked').toMatch(/not on disk/)
  }, 30_000)

  it('control: without a failed check, the uncached reranker does try to download (the test can see it)', async () => {
    emptyCache()
    await expect(makeMsMarcoMiniLmL6Adapter().scoreBatch('release', ['release checklist'])).rejects.toThrow()
    expect(attempts.length, 'online, a missing model is fetched').toBeGreaterThan(0)
  }, 30_000)

  it('control: a model on disk is not refused after the failed check, and nothing is fetched (Gemma, reranker)', async () => {
    cacheWith(EMBEDDING_GEMMA_MODEL_ID, 'model_quantized.onnx')
    expect(await modelPresence(EMBEDDING_GEMMA_MODEL_ID, 'model_quantized.onnx')).toBe(true)
    const before = await failedRegistryCheck()
    const gemma = await getEmbedder('embedding-gemma').embed('deploys').then(() => 'ok', (e: Error) => e.message)
    expect(gemma, 'the guard lets a model on disk through').not.toMatch(/not on disk/)
    cacheWith(MS_MARCO_MINILM_L6_MODEL_ID, 'model_quantized.onnx')
    const rr = await makeMsMarcoMiniLmL6Adapter().scoreBatch('release', ['checklist']).then(() => 'ok', (e: Error) => e.message)
    expect(rr, 'the guard lets a model on disk through').not.toMatch(/not on disk/)
    await settle(100)
    expect(after(before), `a model on disk is loaded from disk only: ${JSON.stringify(attempts)}`).toEqual([])
  }, 30_000)

})
