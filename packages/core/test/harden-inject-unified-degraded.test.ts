/**
 * Hardening H8: the unified injection ranks through `_localHybridRanking`,
 * whose result says when its meaning leg degraded (mode, embedderError,
 * degraded_reason). That state must reach the injection result instead of
 * being dropped, so a degraded ranking is reported as `hybrid-degraded`.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import * as emb from '../src/embeddings.js'

function stubEmbedder(): void {
  const vec = (text: string): Float32Array => {
    const v = new Float32Array(384)
    for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 384] += 1
    let n = 0
    for (const x of v) n += x * x
    n = Math.sqrt(n) || 1
    return v.map(x => x / n)
  }
  emb._setCachedEmbedder({
    name: 'stub-h8', dim: 384, modelId: 'test/stub-h8',
    embed: async (t: string) => vec(t), embedBatch: async (ts: string[]) => ts.map(vec),
  } as any)
}

describe('unified injection reports a degraded ranking leg (H8)', () => {
  let dir: string
  let plur: Plur
  let wasDisabled = false
  beforeEach(async () => {
    wasDisabled = emb.embedderStatus().disabled
    dir = mkdtempSync(join(tmpdir(), 'plur-harden-h8-'))
    writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
    plur = new Plur({ path: dir, autoDiscover: false })
    emb.setEmbeddingsEnabled(false, 'test: fixtures')
    await plur.learn('always run the migration dry-run before deploying', { scope: 'global', type: 'behavioral' })
    await plur.learn('deploys go out on weekday mornings only', { scope: 'global', type: 'behavioral' })
    emb.setEmbeddingsEnabled(true)
    stubEmbedder()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    emb.resetEmbedder()
    emb.setEmbeddingsEnabled(!wasDisabled)
    rmSync(dir, { recursive: true, force: true })
  })

  it('a healthy ranking leg leaves the mode hybrid', async () => {
    const res = await plur.injectHybrid('migration dry-run before deploying', { mode: 'unified' })
    expect(res.injected_ids.length).toBeGreaterThan(0)
    expect(res.mode).toBe('hybrid')
  })

  it('a degraded ranking leg makes the result hybrid-degraded with its reason', async () => {
    const real = (plur as any)._localHybridRanking.bind(plur)
    vi.spyOn(plur as any, '_localHybridRanking').mockImplementation(async (...args: unknown[]) => {
      const r = await real(...args)
      return { ...r, mode: 'hybrid-degraded', embedderError: 'reranker did not answer in time', degraded_reason: 'reranker_deadline' }
    })
    const res = await plur.injectHybrid('migration dry-run before deploying', { mode: 'unified' })
    expect(res.injected_ids.length).toBeGreaterThan(0)
    expect(res.mode).toBe('hybrid-degraded')
    expect(res.degraded_reason).toBe('reranker_deadline')
    expect(res.embedder_error).toMatch(/reranker/)
  })
})
