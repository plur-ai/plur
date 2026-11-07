// security audit 2026-11-06: corrupt-cache advice names PLUR's <cacheDir>/<modelId>, not the HF hub cache.
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
