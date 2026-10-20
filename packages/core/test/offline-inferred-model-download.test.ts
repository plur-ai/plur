/**
 * TEAM-5, owner decision 2026-10-19: when the update check cannot connect, the
 * process is offline, and PLUR starts no further network work of its own. That
 * includes the embedding model: with an empty model cache, a later semantic
 * operation must not try to download it (audit 5, F7). No offline variable is
 * set: a machine with no internet does not say so.
 *
 * With the model already on disk, everything still works locally.
 */
import dns from 'node:dns'
import net from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Plur } from '../src/index.js'
import * as emb from '../src/embeddings.js'
import { getEmbedder } from '../src/embedders/index.js'
import { _resetTransformersPipelineCache, _setDefaultModelCacheDir } from '../src/embedders/transformers-base.js'
import { checkForUpdate, clearVersionCache, settleVersionChecks, updateCheckOffline } from '../src/version-check.js'

const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER', 'PLUR_MODEL_DOWNLOAD', 'PLUR_MODEL_CACHE_DIR', 'HF_HOME'] as const

const dirs: string[] = []
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d }
const settle = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('after a failed update check, no automatic model download', () => {
  const attempts: string[] = []
  const saved = {
    fetch: globalThis.fetch,
    connect: net.Socket.prototype.connect,
    lookup: dns.lookup,
    env: {} as Record<string, string | undefined>,
    disabled: false,
  }

  beforeEach(() => {
    attempts.length = 0
    saved.disabled = emb.embedderStatus().disabled
    for (const k of VARS) { saved.env[k] = process.env[k]; delete process.env[k] }
    globalThis.fetch = (async (input: unknown) => {
      attempts.push(`fetch ${String((input as { url?: string })?.url ?? input)}`)
      throw new TypeError('fetch failed: the network is blocked in this test')
    }) as typeof globalThis.fetch
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
  })

  afterEach(async () => {
    await settleVersionChecks()
    await settle(50)
    globalThis.fetch = saved.fetch
    net.Socket.prototype.connect = saved.connect
    ;(dns as { lookup: unknown }).lookup = saved.lookup
    for (const k of VARS) { if (saved.env[k] === undefined) delete process.env[k]; else process.env[k] = saved.env[k] }
    clearVersionCache()
    emb._resetBackgroundModelLoad()
    _resetTransformersPipelineCache()
    _setDefaultModelCacheDir(undefined)
    emb.resetEmbedder()
    emb.setEmbeddingsEnabled(!saved.disabled)
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  async function seededPlur(): Promise<Plur> {
    const dir = tmp('plur-offline-model-')
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    const plur = new Plur({ path: dir })
    await plur.learn('the deploy checklist lives in the release runbook', { scope: 'global' })
    await plur.learn('rotate the staging certificates every quarter', { scope: 'global' })
    return plur
  }

  /** Embeddings on, the real default adapter, and an empty model cache. */
  function modelMissing(): void {
    process.env.PLUR_MODEL_CACHE_DIR = tmp('plur-offline-models-')
    _setDefaultModelCacheDir(tmp('plur-offline-default-'))
    emb.setEmbeddingsEnabled(true)
    emb.resetEmbedder()
  }

  async function failedRegistryCheck(): Promise<number> {
    await checkForUpdate('@plur-ai/example', '1.0.0')
    expect(updateCheckOffline(), 'the failed check should mark the process offline').toBe(true)
    expect(attempts.length).toBeGreaterThan(0)
    return attempts.length
  }

  it('the default model loader makes no transport attempt for an uncached model', async () => {
    modelMissing()
    const before = await failedRegistryCheck()
    await expect(getEmbedder('bge-small').embed('which checklist covers deploys')).rejects.toThrow()
    await settle(100)
    expect(attempts.slice(before), `the model loader tried the network after the failed check: ${JSON.stringify(attempts)}`).toEqual([])
  }, 30_000)

  it('a long-lived process: semantic search and learn after the failed check start no download', async () => {
    const plur = await seededPlur()
    modelMissing()
    emb.allowBackgroundModelLoad(true)
    const before = await failedRegistryCheck()
    const res = await plur.recallHybridWithMeta('deploy checklist', { deadline_ms: 3000, remote: false })
    expect(res.engrams.some(e => e.statement.includes('deploy checklist')), 'keyword results still come back').toBe(true)
    await plur.learn('the restore drill runs every quarter', { scope: 'global' })
    await plur.injectHybrid('restore drill and deploy checklist', { deadline_ms: 3000, remote: false })
    await settle(300)
    expect(emb.backgroundModelLoadAttempts(), 'no background model load is started offline').toBe(0)
    expect(attempts.slice(before), `PLUR tried the network after the failed check: ${JSON.stringify(attempts)}`).toEqual([])
  }, 30_000)

  it('control: without a failed check, the same long-lived process does start the download', async () => {
    const plur = await seededPlur()
    modelMissing()
    emb.allowBackgroundModelLoad(true)
    await plur.recallHybridWithMeta('deploy checklist', { deadline_ms: 3000, remote: false })
    await settle(1000)
    expect(emb.backgroundModelLoadAttempts()).toBe(1)
    expect(attempts.length, 'online, the missing model is fetched (the test can see a download)').toBeGreaterThan(0)
  }, 30_000)

  it('with the model on disk, semantic search still works after the failed check, locally', async (ctx) => {
    emb.setEmbeddingsEnabled(true)
    emb.resetEmbedder()
    const present = await getEmbedder('bge-small').modelPresent?.()
    if (present !== true) ctx.skip()
    const plur = await seededPlur()
    emb.setEmbeddingsEnabled(true)
    emb.resetEmbedder()
    const before = await failedRegistryCheck()
    const res = await plur.recallHybridWithMeta('which runbook has the deploy checklist', { deadline_ms: 20_000, remote: false })
    expect(res.engrams.some(e => e.statement.includes('deploy checklist'))).toBe(true)
    expect((res as { degraded_reason?: string }).degraded_reason).toBeUndefined()
    expect(attempts.slice(before)).toEqual([])
  }, 60_000)
})
