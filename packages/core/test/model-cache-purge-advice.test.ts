/**
 * Security audit 2026-11-06 (hardening): the corrupt-model-cache advice told
 * users to delete ~/.cache/huggingface/hub/models--<org>--<name>/, but PLUR
 * loads models from <cacheDir>/<modelId> (PLUR_MODEL_CACHE_DIR, HF_HOME or the
 * transformers.js package cache). Following the advice deleted nothing PLUR
 * uses (or something else entirely) and left the corrupt model in place.
 * The advice now names PLUR's real folder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { applyReranker } from '../src/hybrid-search.js'
import { resetRerankerStatus, modelCacheFolder } from '../src/rerankers/index.js'
import type { RerankerAdapter } from '../src/rerankers/types.js'

const MODEL = 'dummy-org/dummy-reranker-ONNX'

describe('corrupt model cache advice names PLUR\'s cache (security audit 2026-11-06)', () => {
  let root: string
  let prevCache: string | undefined
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-purge-'))
    prevCache = process.env.PLUR_MODEL_CACHE_DIR
    process.env.PLUR_MODEL_CACHE_DIR = join(root, 'models')
    resetRerankerStatus()
  })
  afterEach(() => {
    if (prevCache === undefined) delete process.env.PLUR_MODEL_CACHE_DIR
    else process.env.PLUR_MODEL_CACHE_DIR = prevCache
    resetRerankerStatus()
    rmSync(root, { recursive: true, force: true })
  })

  it('the reranker warning names <cacheDir>/<modelId>, not the HF hub cache', async () => {
    const broken: RerankerAdapter = {
      name: 'dummy-reranker',
      modelId: MODEL,
      async score() { throw new Error('Protobuf parsing failed.') },
      async scoreBatch() { throw new Error('Protobuf parsing failed.') },
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const engram = { id: 'a', statement: 'foo', type: 'terminological', status: 'active', created_at: new Date().toISOString(),
        activation: { base_activation: 0.5, retrieval_strength: 0.5, frequency: 0, last_accessed: new Date().toISOString() } } as any
      await applyReranker([engram], 'foo', { reranker: broken })
      const text = spy.mock.calls.map(c => c.map(String).join(' ')).join('\n')
      expect(text).toContain(join(root, 'models', MODEL))
      expect(text).not.toContain('huggingface/hub')
    } finally {
      spy.mockRestore()
    }
  })

  it('modelCacheFolder follows the override', () => {
    expect(modelCacheFolder(MODEL)).toBe(join(root, 'models', MODEL))
  })
})
