/**
 * #1586 audit round 4 (PR #1587): no detached downloader. When the embedding
 * model is not on disk:
 *
 *   - recall answers by keyword at once, marked degraded, with the reason
 *     (`embedding_model_missing`) and the next step (`plur doctor`);
 *   - a short-lived process never downloads and never spawns a process;
 *   - a long-lived process (the MCP server) that opted in starts at most ONE
 *     in-process load, and no recall waits for it;
 *   - HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE / allowRemoteModels=false mean no
 *     network attempt; a model under localModelPath counts as present.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('child_process')>()
  // Never really start a process from a test: a stand-in that does nothing.
  return { ...orig, spawn: vi.fn(() => ({ on() { return this }, unref() {}, pid: 0 })) }
})

import * as childProcess from 'child_process'
import { Plur } from '../src/index.js'
import * as emb from '../src/embeddings.js'
import { _resetTransformersPipelineCache, _setDefaultModelCacheDir } from '../src/embedders/transformers-base.js'

const dirs: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

const ENV_KEYS = ['PLUR_MODEL_CACHE_DIR', 'HF_HOME', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE'] as const
const savedEnv: Record<string, string | undefined> = {}
let wasDisabled = false
let fetchCalls = 0
let savedTransformersEnv: { allowRemoteModels?: boolean; localModelPath?: string } = {}

beforeEach(async () => {
  wasDisabled = emb.embedderStatus().disabled
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
  fetchCalls = 0
  // Any network attempt by the model loader goes through fetch: count it and
  // never answer, so nothing is downloaded.
  vi.stubGlobal('fetch', (() => { fetchCalls++; return new Promise(() => { /* never */ }) }) as unknown as typeof fetch)
  ;(childProcess.spawn as unknown as ReturnType<typeof vi.fn>).mockClear()
  const t = await import('@huggingface/transformers') as unknown as { env: { allowRemoteModels: boolean; localModelPath: string } }
  savedTransformersEnv = { allowRemoteModels: t.env.allowRemoteModels, localModelPath: t.env.localModelPath }
})

afterEach(async () => {
  vi.unstubAllGlobals()
  ;(emb as any)._resetBackgroundModelLoad?.()
  _resetTransformersPipelineCache()
  _setDefaultModelCacheDir(undefined)
  emb.resetEmbedder()
  emb.setEmbeddingsEnabled(!wasDisabled)
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  const t = await import('@huggingface/transformers') as unknown as { env: { allowRemoteModels: boolean; localModelPath: string } }
  t.env.allowRemoteModels = savedTransformersEnv.allowRemoteModels as boolean
  t.env.localModelPath = savedTransformersEnv.localModelPath as string
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function seededPlur(): Promise<Plur> {
  const dir = tmp('plur-1587-r4-')
  writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
  const plur = new Plur({ path: dir })
  await plur.learn('the deploy checklist lives in the release runbook')
  await plur.learn('rotate the staging certificates every quarter')
  return plur
}

/** Embeddings on, the real default adapter, and an empty model cache. */
function modelMissing(): void {
  process.env.PLUR_MODEL_CACHE_DIR = tmp('plur-1587-models-')
  // Missing everywhere: the library default cache is empty too (since round 6
  // a complete model there is found, G1).
  _setDefaultModelCacheDir(tmp('plur-1587-default-'))
  emb.setEmbeddingsEnabled(true)
  emb.resetEmbedder()
}

const settle = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('a missing model, short-lived process', () => {
  it('keyword results at once, with the reason and the next step; no process spawned, no download', async () => {
    const plur = await seededPlur()
    modelMissing()
    const t0 = Date.now()
    const res = await plur.recallHybridWithMeta('deploy checklist', { deadline_ms: 3000, remote: false })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(res.engrams.some(e => e.statement.includes('deploy checklist'))).toBe(true)
    expect(res.mode).toBe('hybrid-degraded')
    expect(res.results_complete).toBe(false)
    expect((res as any).degraded_reason).toBe('embedding_model_missing')
    expect(res.embedderError ?? '').toMatch(/plur doctor/)

    const inj = await plur.injectHybrid('deploy checklist', { deadline_ms: 3000, remote: false })
    expect(inj.mode).toBe('hybrid-degraded')
    expect((inj as any).degraded_reason).toBe('embedding_model_missing')
    expect(inj.results_complete).toBe(false)

    await settle(300)
    expect(childProcess.spawn).not.toHaveBeenCalled()
    expect(fetchCalls).toBe(0)
  }, 15_000)
})

describe('a missing model, long-lived process', () => {
  it('starts at most one in-process load, and recall never waits for it', async () => {
    const plur = await seededPlur()
    modelMissing()
    const allow = (emb as any).allowBackgroundModelLoad
    expect(typeof allow).toBe('function')
    allow(true)
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now()
      const res = await plur.recallHybridWithMeta('deploy checklist', { deadline_ms: 3000, remote: false })
      expect(Date.now() - t0).toBeLessThan(2000)
      expect(res.engrams.length).toBeGreaterThan(0)
      expect((res as any).degraded_reason).toBe('embedding_model_missing')
    }
    await settle(300)
    expect((emb as any).backgroundModelLoadAttempts()).toBe(1)
    expect(childProcess.spawn).not.toHaveBeenCalled()
  }, 15_000)

  for (const offline of ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE'] as const) {
    it(`${offline}=1: no load attempt, no network`, async () => {
      const plur = await seededPlur()
      modelMissing()
      process.env[offline] = '1'
      ;(emb as any).allowBackgroundModelLoad?.(true)
      const res = await plur.recallHybridWithMeta('deploy checklist', { deadline_ms: 3000, remote: false })
      expect((res as any).degraded_reason).toBe('embedding_model_missing')
      await settle(300)
      expect((emb as any).backgroundModelLoadAttempts?.() ?? -1).toBe(0)
      expect(fetchCalls).toBe(0)
    }, 15_000)
  }

  it('allowRemoteModels=false: no load attempt, no network', async () => {
    const plur = await seededPlur()
    modelMissing()
    const t = await import('@huggingface/transformers') as unknown as { env: { allowRemoteModels: boolean } }
    t.env.allowRemoteModels = false
    ;(emb as any).allowBackgroundModelLoad?.(true)
    const res = await plur.recallHybridWithMeta('deploy checklist', { deadline_ms: 3000, remote: false })
    expect((res as any).degraded_reason).toBe('embedding_model_missing')
    await settle(300)
    expect((emb as any).backgroundModelLoadAttempts?.() ?? -1).toBe(0)
    expect(fetchCalls).toBe(0)
  }, 15_000)

  it('a model provisioned under localModelPath counts as present', async () => {
    modelMissing()
    const local = tmp('plur-1587-local-models-')
    mkdirSync(join(local, 'Xenova', 'bge-small-en-v1.5', 'onnx'), { recursive: true })
    writeFileSync(join(local, 'Xenova', 'bge-small-en-v1.5', 'onnx', 'model.onnx'), 'x')
    for (const f of ['tokenizer.json', 'tokenizer_config.json', 'config.json']) {
      writeFileSync(join(local, 'Xenova', 'bge-small-en-v1.5', f), '{}')
    }
    const t = await import('@huggingface/transformers') as unknown as { env: { localModelPath: string } }
    t.env.localModelPath = local
    expect(await emb.semanticModelState()).toBe('cached')
  })
})
