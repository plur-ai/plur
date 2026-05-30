/**
 * Embedder default + OpenAI tier resolution — Sprint 0 PR 5
 * (feat/embedding-gemma-default), closes plur-ai/plur#219.
 *
 * Contract:
 *   - When PLUR_EMBEDDER is unset, the factory default is "embedding-gemma".
 *   - PLUR_EMBEDDER=openai-3-large resolves to an adapter named
 *     "openai-3-large" with dim 3072 and modelId "text-embedding-3-large".
 *   - Constructing the OpenAI adapter without OPENAI_API_KEY must NOT throw
 *     (the factory only instantiates metadata; the throw fires on first
 *     embed() call). The error message must mention OPENAI_API_KEY so users
 *     get a clear pointer, not a confusing 401 surfaced from the openai SDK.
 *
 * No model loads happen in this file — only metadata + factory routing.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  DEFAULT_EMBEDDER,
  EMBEDDER_NAMES,
  getEmbedder,
  resolveEmbedderName,
  _resetEmbedderCache,
  _resetResolveWarnings,
  type EmbedderName,
} from '../src/embedders/index.js'

describe('embedder default — PR 5 (#219)', () => {
  const originalEmbedder = process.env.PLUR_EMBEDDER
  const originalKey = process.env.OPENAI_API_KEY

  afterEach(() => {
    if (originalEmbedder === undefined) delete process.env.PLUR_EMBEDDER
    else process.env.PLUR_EMBEDDER = originalEmbedder
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
    _resetEmbedderCache()
    _resetResolveWarnings()
  })

  it('DEFAULT_EMBEDDER is "embedding-gemma"', () => {
    expect(DEFAULT_EMBEDDER).toBe('embedding-gemma')
  })

  it('resolveEmbedderName() returns "embedding-gemma" when PLUR_EMBEDDER is unset', () => {
    delete process.env.PLUR_EMBEDDER
    expect(resolveEmbedderName()).toBe('embedding-gemma')
  })

  it('resolveEmbedderName() falls back to "embedding-gemma" on unknown values', () => {
    process.env.PLUR_EMBEDDER = 'gpt-banana'
    expect(resolveEmbedderName()).toBe('embedding-gemma')
  })

  it('EMBEDDER_NAMES includes "openai-3-large"', () => {
    expect(EMBEDDER_NAMES).toContain('openai-3-large')
  })

  it('PLUR_EMBEDDER=openai-3-large resolves to the OpenAI adapter', () => {
    process.env.PLUR_EMBEDDER = 'openai-3-large'
    expect(resolveEmbedderName()).toBe('openai-3-large')
  })

  it('getEmbedder("openai-3-large") reports name, dim, modelId without loading anything', () => {
    // Adapter construction is metadata-only. No env var required to get here.
    delete process.env.OPENAI_API_KEY
    const adapter = getEmbedder('openai-3-large' as EmbedderName)
    expect(adapter.name).toBe('openai-3-large')
    expect(adapter.dim).toBe(3072)
    expect(adapter.modelId).toBe('text-embedding-3-large')
  })

  it('getEmbedder("openai-3-large").embed() throws a clear error when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY
    const adapter = getEmbedder('openai-3-large' as EmbedderName)
    await expect(adapter.embed('hello world')).rejects.toThrow(/OPENAI_API_KEY/)
  })
})
