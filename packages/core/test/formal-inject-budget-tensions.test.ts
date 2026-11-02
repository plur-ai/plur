/**
 * `TensionScanResult.skipped` (tensions.ts) counts and names every pair a
 * configured gate removed: snapshot pairs (`snapshot_pairs: 'skip'`, only
 * reachable with `temporal_domains` configured) and measured-under pairs.
 * Structural skips (already-recorded pairs, supersedes links, closed validity
 * windows) are not counted.
 */
import { describe, it, expect } from 'vitest'
import { getCandidatePairsDetailed, scanForTensions } from '../src/tensions.js'
import type { Engram } from '../src/schemas/engram.js'

function eng(id: string, statement: string, domain: string, extra: Record<string, unknown> = {}): Engram {
  return {
    id, statement, domain, version: 2, status: 'active', consolidated: false, type: 'behavioral',
    scope: 'global', visibility: 'private',
    activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-05-16' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], content_hash: id,
    commitment: 'leaning', engram_version: 1, episode_ids: [], polarity: null,
    ...extra,
  } as unknown as Engram
}

const NONE = { measured_under: 0, measured_under_pairs: [], snapshot: 0, snapshot_pairs: [] }

describe('tension scan skip accounting', () => {
  const a = eng('ENG-2026-0407-001', 'The ceasefire in the strait holds', 'war-analysis.hormuz')
  const b = eng('ENG-2026-0409-001', 'The ceasefire in the strait has collapsed', 'war-analysis.hormuz')

  it('a snapshot pair skipped by policy is counted and named in skipped', () => {
    const r = getCandidatePairsDetailed([a, b], { temporal_domains: ['war-analysis'] })
    expect(r.pairs).toHaveLength(0)
    expect(r.skipped).toEqual({ ...NONE, snapshot: 1, snapshot_pairs: ['ENG-2026-0407-001:ENG-2026-0409-001'] })
  })

  it('the scan result reports the snapshot skip without calling the judge', async () => {
    let calls = 0
    const llm = async () => { calls++; return 'CONTRADICTS: yes\nCONFIDENCE: 0.99\nREASON: opposite' }
    const r = await scanForTensions([a, b], llm, { temporal_domains: ['war-analysis'] })
    expect(calls).toBe(0)
    expect(r.skipped.snapshot).toBe(1)
    expect(r.skipped.snapshot_pairs).toEqual(['ENG-2026-0407-001:ENG-2026-0409-001'])
  })

  it("'floor' mode judges the snapshot pair, so nothing is counted", () => {
    const r = getCandidatePairsDetailed([a, b], { temporal_domains: ['war-analysis'], snapshot_pairs: 'floor' })
    expect(r.pairs).toHaveLength(1)
    expect(r.skipped).toEqual(NONE)
  })

  it('structural skips stay uncounted: recorded pairs, supersedes links, closed windows', () => {
    const recorded = getCandidatePairsDetailed([a, b], { exclude_pairs: new Set(['ENG-2026-0407-001:ENG-2026-0409-001']) })
    expect(recorded.pairs).toHaveLength(0)
    expect(recorded.skipped).toEqual(NONE)
    const sup = eng('ENG-2026-0409-001', 'The ceasefire in the strait has collapsed', 'war-analysis.hormuz',
      { relations: { supersedes: ['ENG-2026-0407-001'] } })
    expect(getCandidatePairsDetailed([a, sup]).skipped).toEqual(NONE)
    const closed = eng('ENG-2026-0409-001', 'The ceasefire in the strait has collapsed', 'war-analysis.hormuz',
      { temporal: { valid_until: '2026-01-01' } })
    const r = getCandidatePairsDetailed([a, closed], { now: '2026-06-01' })
    expect(r.pairs).toHaveLength(0)
    expect(r.skipped).toEqual(NONE)
  })

  it('good case: without temporal domains the same pair is a candidate', () => {
    const r = getCandidatePairsDetailed([a, b])
    expect(r.pairs).toHaveLength(1)
  })
})
