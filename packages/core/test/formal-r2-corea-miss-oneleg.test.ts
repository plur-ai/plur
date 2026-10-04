/**
 * Follow-up to decision I3 (round 2, R2-CoreA): with embeddings off there is
 * ONE retrieval leg, so every non-empty recall's top RRF score is ≤ 1/61, below
 * the 0.025 threshold — an opted-in install reported every such recall as a
 * `low_score` miss. The threshold is calibrated for two legs; with one leg a
 * weak top hit is not evidence of a miss. `no_results` is still reported.
 *
 * `emitMissSignal` is replaced by a spy (vi.mock) — nothing is sent, no
 * install id is written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const emitted: Array<{ resultCount: number; topScore: number | null }> = []
vi.mock('../src/telemetry-miss-signal.js', async (orig) => {
  const real = await orig<typeof import('../src/telemetry-miss-signal.js')>()
  return {
    ...real,
    emitMissSignal: vi.fn(async (input: { resultCount: number; topScore: number | null }) => {
      emitted.push({ resultCount: input.resultCount, topScore: input.topScore })
      return false
    }),
  }
})

import { Plur } from '../src/index.js'
import { setEmbeddingsEnabled } from '../src/embeddings.js'

describe('miss-signal with one retrieval leg (embeddings off)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2corea-miss-'))
    emitted.length = 0
    setEmbeddingsEnabled(false, 'test: one leg')
  })
  afterEach(() => {
    setEmbeddingsEnabled(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('a non-empty BM25-only recall is not offered as a low_score miss', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('Deploys go out on Tuesdays after the standup', { scope: 'global' })
    const res = await plur.recallHybridWithMeta('when do deploys go out', { limit: 5 } as any)
    expect(res.mode).toBe('bm25-only')
    expect(res.engrams.length).toBeGreaterThan(0)
    await new Promise(r => setTimeout(r, 10))
    expect(emitted).toEqual([])
  })

  it('an empty BM25-only recall is still reported (no_results)', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('Deploys go out on Tuesdays after the standup', { scope: 'global' })
    await plur.recallHybridWithMeta('zebra quantum marmalade', { limit: 5 } as any)
    await new Promise(r => setTimeout(r, 10))
    expect(emitted.length).toBe(1)
    expect(emitted[0].resultCount).toBe(0)
  })
})
