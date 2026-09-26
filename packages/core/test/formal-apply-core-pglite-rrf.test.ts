/**
 * Decision I4 "rrf" (owner, 2026-09-26): `_pgliteHybridRecall` returns a real
 * top RRF score (not null), so the miss-signal classification is the same on
 * both backends — a PGLite recall WITH results is no longer classified
 * `no_results`.
 *
 * The PGLite fusion branch is reached with a stubbed query embedding and a
 * stubbed `searchVector` (no model download, no network); the YAML path is the
 * reference: same lists in, same RRF top score out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'

vi.mock('../src/embeddings.js', async (orig) => {
  const real = await orig<typeof import('../src/embeddings.js')>()
  return { ...real, embed: vi.fn(async () => new Float32Array(8).fill(0.1)) }
})

import { Plur } from '../src/index.js'
import { classifyMiss } from '../src/telemetry-miss-signal.js'

describe('Decision I4 — PGLite hybrid recall reports an RRF top score', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-apply-pgrrf-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a recall with results carries a numeric topScore and is not a no_results miss', async () => {
    const plur = new Plur({ path: dir })
    const a = await plur.learn('blue ocean strategy is a market positioning concept', { type: 'behavioral', scope: 'global' })
    const b = await plur.learn('the user prefers terse responses', { type: 'behavioral', scope: 'global' })
    // Stub adapter: the vector leg ranks b then a.
    ;(plur as any).pgliteAdapter = {
      searchVector: async () => [{ engram: b, score: 0.9 }, { engram: a, score: 0.8 }],
    }
    const result = await (plur as any)._pgliteHybridRecall('ocean strategy', 5, [a, b], undefined, {})
    expect(result.engrams.length).toBeGreaterThan(0)
    expect(result.topScore, 'PGLite fusion returned a null top score').not.toBeNull()
    // BM25 ranks a first (only lexical hit), vector ranks it second:
    // RRF(a) = 1/61 + 1/62, which beats RRF(b) = 1/61.
    expect(result.engrams[0].id).toBe(a.id)
    expect(result.topScore).toBeCloseTo(1 / 61 + 1 / 62, 12)
    expect(classifyMiss({ resultCount: result.engrams.length, topScore: result.topScore })).toBeNull()
  })
})
