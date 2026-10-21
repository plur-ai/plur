/**
 * Cached-model controls for offline-inferred-model-download-siblings.test.ts,
 * in their own file (a fresh process): transformers.js memoizes its
 * tokenizer-file lookups per process, so a lookup that failed in an earlier
 * test would leak into these.
 *
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getEmbedder } from '../src/embedders/index.js'
import { _resetEmbeddingGemmaCache, EMBEDDING_GEMMA_MODEL_ID } from '../src/embedders/embedding-gemma.js'
import {
  _resetTransformersPipelineCache, _setDefaultModelCacheDir, envOf, importTransformers, modelPresence,
} from '../src/embedders/transformers-base.js'
import {
  _resetCrossEncoderCaches, makeMsMarcoMiniLmL6Adapter, MS_MARCO_MINILM_L6_MODEL_ID,
} from '../src/rerankers/transformers-cross-encoder.js'
import { checkForUpdate, clearVersionCache, settleVersionChecks, updateCheckOffline } from '../src/version-check.js'

const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER', 'PLUR_MODEL_DOWNLOAD', 'PLUR_MODEL_CACHE_DIR', 'HF_HOME'] as const

const settle = (ms: number) => new Promise(r => setTimeout(r, ms))

type Env = { fetch?: unknown; cacheDir?: string | null }

describe('after a failed update check, a cached Gemma or reranker model still works locally', () => {
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
  })

  /** The model cache this run was given (PLUR_MODEL_CACHE_DIR as the runner
   *  set it, else the library default). A control whose model is not there
   *  is skipped, as in offline-inferred-model-download.test.ts. */
  function useRunnerCache(): void {
    if (saved.env.PLUR_MODEL_CACHE_DIR) process.env.PLUR_MODEL_CACHE_DIR = saved.env.PLUR_MODEL_CACHE_DIR
    tEnv.cacheDir = saved.envCacheDir
  }

  async function failedRegistryCheck(): Promise<number> {
    await checkForUpdate('@plur-ai/example', '1.0.0')
    expect(updateCheckOffline(), 'the failed check should mark the process offline').toBe(true)
    expect(attempts.length).toBeGreaterThan(0)
    return attempts.length
  }

  const after = (before: number) => attempts.slice(before)

  it('control: the real cached reranker still scores after the failed check, with no request', async (ctx) => {
    useRunnerCache()
    if ((await modelPresence(MS_MARCO_MINILM_L6_MODEL_ID, 'model_quantized.onnx')) !== true) ctx.skip()
    const before = await failedRegistryCheck()
    const scores = await makeMsMarcoMiniLmL6Adapter().scoreBatch('how do I release', ['the release checklist', 'lunch menu'])
    expect(scores).toHaveLength(2)
    expect(scores[0]).toBeGreaterThan(scores[1])
    expect(after(before)).toEqual([])
  }, 60_000)

  it('control: the real cached EmbeddingGemma still embeds after the failed check, with no request', async (ctx) => {
    useRunnerCache()
    if ((await modelPresence(EMBEDDING_GEMMA_MODEL_ID, 'model_quantized.onnx')) !== true) ctx.skip()
    const before = await failedRegistryCheck()
    const v = await getEmbedder('embedding-gemma').embed('the release checklist')
    expect(v.length).toBe(768)
    expect(after(before)).toEqual([])
  }, 120_000)
})
