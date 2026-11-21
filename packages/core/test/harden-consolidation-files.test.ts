/**
 * Hardening H6 and H9: the consolidation side files.
 *
 * H6: the paraphrase queue (`consolidate-queue.jsonl`) is appended on every
 * learn that finds a near-copy and was never bounded. It is capped (deduped by
 * pair, oldest dropped) and read only from its tail.
 *
 * H9: the nightly state file is written atomically and a failure is logged,
 * not swallowed; a failed `consolidated_into` history append is logged too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { logger } from '../src/logger.js'
import {
  CONSOLIDATE_QUEUE_FILE, CONSOLIDATE_STATE_FILE, CONSOLIDATE_QUEUE_MAX_BYTES, blockKeyFor,
  type ConsolidationPlan, type PlanCluster,
} from '../src/consolidate.js'
import { computeContentHash } from '../src/content-hash.js'

const line = (id: string, nb: string) => JSON.stringify({ at: '2026-11-01T00:00:00.000Z', id, neighbour_id: nb, score: 0.95, scope: 'global' })

describe('consolidation side files (H6, H9)', () => {
  let dir: string
  let plur: Plur
  const queue = () => join(dir, CONSOLIDATE_QUEUE_FILE)
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-harden-consolidate-'))
    writeFileSync(join(dir, 'config.yaml'), 'backend: yaml\nindex: false\nembeddings:\n  enabled: false\n')
    plur = new Plur({ path: dir, autoDiscover: false })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('the queue stays under its cap when an append finds it over (H6)', () => {
    const filler = Array.from({ length: 30_000 }, (_, i) => line(`ENG-2026-0101-${i}`, `ENG-2026-0102-${i}`)).join('\n') + '\n'
    writeFileSync(queue(), filler)
    expect(statSync(queue()).size).toBeGreaterThan(CONSOLIDATE_QUEUE_MAX_BYTES)
    const n = (plur as any)._queueParaphrases('ENG-NEW-1', 'global', [{ id: 'ENG-NEW-2', score: 0.99, scope: 'global' }])
    expect(n).toBe(1)
    expect(statSync(queue()).size).toBeLessThanOrEqual(CONSOLIDATE_QUEUE_MAX_BYTES)
    // The newest entry is kept.
    expect(readFileSync(queue(), 'utf8')).toContain('ENG-NEW-1')
  })

  it('the queue keeps one entry per pair, whichever way round (H6)', () => {
    const dup = Array.from({ length: 12_000 }, (_, i) => (i % 2 ? line('ENG-A', 'ENG-B') : line('ENG-B', 'ENG-A'))).join('\n') + '\n'
    writeFileSync(queue(), dup)
    ;(plur as any)._queueParaphrases('ENG-A', 'global', [{ id: 'ENG-B', score: 0.99, scope: 'global' }])
    const lines = readFileSync(queue(), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
  })

  it('reading the queue is bounded to its tail (H6)', () => {
    const old = Array.from({ length: 40_000 }, (_, i) => line(`ENG-OLD-${i}`, 'ENG-OLD-X')).join('\n') + '\n'
    writeFileSync(queue(), old + line('ENG-RECENT-1', 'ENG-RECENT-2') + '\n')
    const ids: string[] = (plur as any)._readConsolidateQueue()
    expect(ids).toContain('ENG-RECENT-1')
    expect(ids).not.toContain('ENG-OLD-0')
  })

  const nightlyPlan = (): ConsolidationPlan => ({
    kind: 'plur.consolidate.plan', version: 1, plan_id: 'P-H9', created_at: '2026-11-21T03:00:00.000Z', updated_at: '2026-11-21T03:00:00.000Z',
    mode: 'nightly', threshold: 0.9, seed: 's', seed_source: 'date',
    nightly: { date: '2026-11-21', changed_since: null, sampled_ids: [], queued_ids: [], carried_in_ids: [], carried_ids: [], max_changes: 5 },
    stats: { rows: 0, eligible: 0, excluded: {}, without_vector: 0, candidate_pairs: 0, clusters_found: 0, mixed_polarity: 0, protected: 0 },
    clusters: [], progress: { decided: 0, pending: 0, complete: true, model_calls: 0, model_errors: 0 },
  } as unknown as ConsolidationPlan)

  it('the nightly state is written atomically (H9)', () => {
    ;(plur as any)._finishNightlyPlan(nightlyPlan())
    expect(JSON.parse(readFileSync(join(dir, CONSOLIDATE_STATE_FILE), 'utf8')).last_plan_id).toBe('P-H9')
    expect(readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([])
  })

  it('a failed nightly state write is logged, not swallowed (H9)', () => {
    mkdirSync(join(dir, CONSOLIDATE_STATE_FILE)) // cannot be replaced by a file
    const warn = vi.spyOn(logger, 'warning')
    ;(plur as any)._finishNightlyPlan(nightlyPlan())
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/nightly state/i)
  })

  it('a failed consolidated_into history append is logged (H9)', async () => {
    const a = await plur.learn('Use pnpm, not npm, in this repository', { scope: 'global' })
    const b = await plur.learn('This repository uses pnpm instead of npm', { scope: 'global' })
    const cluster = {
      id: 'K-0001', scope: 'global', block: blockKeyFor(a),
      members: [a, b].map(e => ({ id: e.id, statement: e.statement, statement_hash: computeContentHash(e.statement), pinned: false, locked: false, polarity: 'do', retrieval_strength: 0 })),
      min_similarity: 0.95, polarity: 'do', protected_reasons: [], requires_owner_approval: false, approved: false, decision: 'merge',
    } as unknown as PlanCluster
    const real = (plur as any)._appendHistory.bind(plur)
    vi.spyOn(plur as any, '_appendHistory').mockImplementation((ev: any) => {
      if (ev.event === 'consolidated_into') throw new Error('EIO: history disk full')
      return real(ev)
    })
    const warn = vi.spyOn(logger, 'warning')
    const res = await (plur as any)._applyConsolidationCluster({ plan_id: 'P-H9' }, cluster, 'Use pnpm in this repository', new Date())
    expect(res.merged_id).toBeDefined()
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/consolidated_into/)
  })
})
