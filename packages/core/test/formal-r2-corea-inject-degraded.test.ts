/**
 * R2-Retrieval NEEDS-FILE, applied by R2-CoreA (spec/formal/findings/r2-retrieval.md
 * §6b): `injectHybrid` silently degraded to keyword-only injection when the
 * embedder failed — `embed()` swallows the error, the catch was silent, and the
 * InjectionResult said nothing. Now it is logged (once per process) and reported
 * as `mode: 'hybrid-degraded'` + `embedder_error`, mirroring HybridSearchResult
 * (not a `warnings` line, which is rendered into every prompt). Embeddings the
 * USER turned off report `bm25-only`, not a fault.
 *
 * The embedder is a vi.mock stub that throws; no model is loaded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/embedders/index.js', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return {
    ...real,
    getEmbedder: () => ({
      name: 'crashing-stub',
      dim: 384,
      embed: async () => { throw new Error('model crashed') },
    }),
  }
})

import { Plur } from '../src/index.js'
import { resetEmbedder, setEmbeddingsEnabled } from '../src/embeddings.js'

describe('injectHybrid reports a failed embedder', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2corea-inj-'))
    setEmbeddingsEnabled(true)
    resetEmbedder()
  })
  afterEach(() => {
    setEmbeddingsEnabled(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('an embedder failure is reported as hybrid-degraded', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('Deploys go out on Tuesdays after the standup', { scope: 'global' })
    const res = await plur.injectHybrid('when do deploys go out', { remote: false } as any)
    expect(res.mode).toBe('hybrid-degraded')
    expect(res.embedder_error).toMatch(/model crashed/)
  })

  it('embeddings turned off by the user are not flagged', async () => {
    setEmbeddingsEnabled(false, 'user opted out')
    const plur = new Plur({ path: dir })
    await plur.learn('Deploys go out on Tuesdays after the standup', { scope: 'global' })
    const res = await plur.injectHybrid('when do deploys go out', { remote: false } as any)
    expect(res.mode).toBe('bm25-only')
    expect(res.embedder_error).toBeUndefined()
  })
})
