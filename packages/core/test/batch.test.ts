import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { learnBatch } from '../src/learn-async.js'
import type { LearnAsyncDeps } from '../src/learn-async.js'
import type { Engram } from '../src/schemas/engram.js'

/**
 * plur_learn_batch (batch API, #281 item #3): persist many engrams in one call,
 * sharing the same dedup + policy pipeline as single learn. These tests cover
 * the three behaviors the MCP tool relies on: batch write, dedup across the
 * batch, and partial-failure isolation.
 */

describe('learnBatch: batch write', () => {
  let plur: Plur
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-batch-'))
    // Disable local embeddings so dedup uses the fast BM25 path — keeps the
    // test deterministic and avoids one-time model warmup. Dedup logic itself
    // stays enabled (this is exactly single-learn's policy path).
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('writes every novel statement and returns one id per success', async () => {
    const res = await plur.learnBatch([
      { statement: 'Deploy target is the nightshift server' },
      { statement: 'Org files live under 0-personal/org' },
      { statement: 'The weekly review runs on Sundays' },
    ])

    expect(res.results).toHaveLength(3)
    expect(res.stats.added).toBe(3)
    expect(res.stats.failed).toBe(0)
    expect(res.failures).toEqual([])

    const ids = res.results.map(r => r.engram.id)
    expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(3) // ids are unique
    // Every returned id is actually persisted and retrievable.
    for (const id of ids) expect(plur.getById(id)).toBeTruthy()
  })
})

describe('learnBatch: dedup within the batch', () => {
  let plur: Plur
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-batch-dedup-'))
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('resolves a statement duplicating an earlier batch item to NOOP', async () => {
    const res = await plur.learnBatch([
      { statement: 'API responses use snake_case keys' },
      { statement: 'The rate limit is 100 requests per minute' },
      { statement: 'API responses use snake_case keys' }, // exact duplicate of item 0
    ])

    expect(res.results).toHaveLength(3)
    expect(res.stats.added).toBe(2)
    expect(res.stats.noops).toBe(1)
    expect(res.stats.failed).toBe(0)

    // The NOOP points back at the engram created for the first occurrence —
    // dedup happened against the item persisted earlier in the same batch.
    const noop = res.results.find(r => r.decision === 'NOOP')
    expect(noop).toBeDefined()
    expect(noop!.engram.id).toBe(res.results[0].engram.id)
  })
})

describe('learnBatch: partial-failure isolation', () => {
  // A fake deps whose write throws for one statement, so we can assert the
  // batch keeps going and records the failure against its input index.
  const makeDeps = (): LearnAsyncDeps => ({
    hashDedup: () => null,
    recallHybrid: async () => [],
    recall: () => [],
    learn: (statement: string) => {
      if (statement.includes('BOOM')) throw new Error('simulated write failure')
      return { id: 'ENG-2026-0101-777', statement } as unknown as Engram
    },
    getById: () => null,
    engramsPath: '/tmp/plur-batch-fail-engrams.yaml',
    rootPath: '/tmp/plur-batch-fail',
    dedupConfig: { enabled: false }, // straight to deps.learn, no recall/LLM
    isLlmAvailable: () => false,
    recordLlmSuccess: () => {},
    recordLlmFailure: () => {},
    syncIndex: () => {},
  })

  // #281 — a partial-failure batch must let a caller map each INPUT to its
  // engram. `results` is COMPACTED (failed statements absent), so before the fix
  // `ids: results.map(...)` (mcp/src/tools.ts) shifted every id after a failure
  // left and mis-attributed it. Fix: each result carries its `input_index`, so a
  // caller reconstructs the input→engram mapping regardless of compaction.
  it('a caller can map each input to its engram even when a middle item fails (#281)', async () => {
    const res = await learnBatch(makeDeps(), [
      { statement: 'good one' },       // input 0
      { statement: 'this will BOOM' }, // input 1 — fails
      { statement: 'good two' },       // input 2
    ])

    // The failure side already carries the input index.
    expect(res.stats.added).toBe(2)
    expect(res.stats.failed).toBe(1)
    expect(res.failures).toHaveLength(1)
    expect(res.failures[0].index).toBe(1)
    expect(res.failures[0].statement).toBe('this will BOOM')

    // The fix: every successful result carries its input_index, so input 2 (C)
    // is recoverable as input 2 — not shifted to results[1] by compaction.
    const byInput = new Map(res.results.map(r => [r.input_index, r.engram.statement]))
    expect(byInput.get(0)).toBe('good one')
    expect(byInput.get(2)).toBe('good two')   // NOT mis-attributed to input 1
    expect(byInput.has(1)).toBe(false)         // the failed input has no result
  })

  it('reports an all-failed batch without throwing', async () => {
    const res = await learnBatch(makeDeps(), [
      { statement: 'BOOM one' },
      { statement: 'BOOM two' },
    ])

    expect(res.results).toHaveLength(0)
    expect(res.stats.added).toBe(0)
    expect(res.stats.failed).toBe(2)
    expect(res.failures.map(f => f.index)).toEqual([0, 1])
  })
})
