import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { learnBatch } from '../src/learn-async.js'
import type { LearnAsyncDeps } from '../src/learn-async.js'
import { MemoryPrimaryStore } from '../src/store/memory-primary-store.js'
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
    for (const id of ids) expect(await plur.getById(id)).toBeTruthy()
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

describe('learnBatch: in-batch near-duplicate detection (#854)', () => {
  /**
   * Regression test for the in-batch dedup blind spot (#854).
   *
   * Root cause: _syncIndex() is fire-and-forget, so the BM25/embedding index
   * does not contain statement[i] when statement[i+N] is processed. With the
   * real recall deps, learnAsync sees zero candidates for subsequent statements
   * and short-circuits to ADD — producing one engram per batch item regardless
   * of similarity.
   *
   * Fix: learnBatch now maintains a `batchAccumulator` of ADD-written engrams
   * and splices them into the recall results so the dedup step sees them even
   * before the index has flushed.
   *
   * This test uses fake deps where `recall`/`recallHybrid` return [] to
   * simulate the stale-index blind spot exactly. The LLM is supplied so the
   * dedup step reaches the LLM decision branch. The second statement (near-
   * duplicate) must be NOOP or UPDATE — not a second ADD.
   */
  it('catches a near-duplicate written earlier in the same batch (index blind spot)', async () => {
    // First engram written by deps.learn on the ADD path.
    const firstEngram = {
      id: 'ENG-2026-0854-001',
      statement: 'Always rebase before pushing to the shared branch',
      type: 'behavioral',
      domain: 'test',
      scope: 'global',
      status: 'active',
    } as unknown as Engram

    // Track written statements to drive the learn stub.
    const written: string[] = []

    const deps: LearnAsyncDeps = {
      // hashDedup: always miss — we want the full dedup path to run.
      hashDedup: async () => null,
      // Index is stale: return [] so the blind spot is reproduced exactly.
      recallHybrid: async () => [],
      recall: async () => [],
      learn: async (statement: string) => {
        written.push(statement)
        // Return firstEngram for the first ADD so the accumulator captures it.
        return written.length === 1 ? firstEngram : ({ id: 'ENG-2026-0854-002', statement } as unknown as Engram)
      },
      getById: async (id: string) => id === firstEngram.id ? firstEngram : null,
      store: new MemoryPrimaryStore(),
      engramsPath: '/tmp/plur-test-854-engrams.yaml',
      rootPath: '/tmp/plur-test-854',
      dedupConfig: { enabled: true, mode: 'llm' },
      isLlmAvailable: () => true,
      recordLlmSuccess: () => {},
      recordLlmFailure: () => {},
      offendingHitsForScope: () => [],
      syncIndex: async () => {},
    }

    // LLM returns NOOP against the accumulator-supplied candidate.
    const llm = async (_prompt: string): Promise<string> =>
      `DECISION: NOOP\nTARGET: ${firstEngram.id}\nREASON: Same advice, different wording`

    const res = await learnBatch(deps, [
      { statement: 'Always rebase before pushing to the shared branch' },
      // Near-duplicate: same meaning, different wording.
      // With the blind spot, recallHybrid/recall return [] so this becomes ADD.
      // With the fix, the accumulator supplies the first engram as a candidate.
      { statement: 'Rebase onto the shared branch before every push' },
    ], llm)

    expect(res.results).toHaveLength(2)
    // First statement is a fresh ADD.
    expect(res.results[0]!.decision).toBe('ADD')
    // Second statement must NOT be ADD — the accumulator made the first engram
    // visible to the dedup step before the index flushed (#854).
    expect(res.results[1]!.decision).not.toBe('ADD')
    expect(['NOOP', 'UPDATE', 'MERGE']).toContain(res.results[1]!.decision)
    // Stats reflect dedup working: only one net ADD.
    expect(res.stats.added).toBe(1)
    expect(res.stats.failed).toBe(0)
  })
})

describe('learnBatch: partial-failure isolation', () => {
  // A fake deps whose write throws for one statement, so we can assert the
  // batch keeps going and records the failure against its input index.
  const makeDeps = (): LearnAsyncDeps => ({
    hashDedup: async () => null,
    recallHybrid: async () => [],
    recall: async () => [],
    learn: async (statement: string) => {
      if (statement.includes('BOOM')) throw new Error('simulated write failure')
      return { id: 'ENG-2026-0101-777', statement } as unknown as Engram
    },
    getById: async () => null,
    store: new MemoryPrimaryStore(),
    engramsPath: '/tmp/plur-batch-fail-engrams.yaml',
    rootPath: '/tmp/plur-batch-fail',
    dedupConfig: { enabled: false }, // straight to deps.learn, no recall/LLM
    isLlmAvailable: () => false,
    recordLlmSuccess: () => {},
    // No secrets in these fixtures, so nothing is ever demoted. Present because
    // `demoteIfSensitive` calls it unconditionally on the dedup UPDATE/MERGE
    // path: omitting it left the fake one routing decision away from a
    // TypeError that would have read as a batch bug rather than a missing dep.
    offendingHitsForScope: () => [],
    recordLlmFailure: () => {},
    syncIndex: async () => {},
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
