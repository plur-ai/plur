/**
 * `TensionScanResult.skipped` (tensions.ts) counts and names measured-under
 * skips; a snapshot pair dropped by `snapshot_pairs: 'skip'` (only reachable
 * with `temporal_domains` configured) is dropped without being counted, as the
 * comment now says.
 */
import { describe, it, expect } from 'vitest'
import { getCandidatePairsDetailed } from '../src/tensions.js'
import type { Engram } from '../src/schemas/engram.js'

function eng(id: string, statement: string, domain: string): Engram {
  return {
    id, statement, domain, version: 2, status: 'active', consolidated: false, type: 'behavioral',
    scope: 'global', visibility: 'private',
    activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-05-16' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], content_hash: id,
    commitment: 'leaning', engram_version: 1, episode_ids: [], polarity: null,
  } as unknown as Engram
}

describe('tension scan skip accounting', () => {
  const a = eng('ENG-2026-0407-001', 'The ceasefire in the strait holds', 'war-analysis.hormuz')
  const b = eng('ENG-2026-0409-001', 'The ceasefire in the strait has collapsed', 'war-analysis.hormuz')

  it('a snapshot pair skipped by policy is dropped and not counted in skipped', () => {
    const r = getCandidatePairsDetailed([a, b], { temporal_domains: ['war-analysis'] })
    expect(r.pairs).toHaveLength(0)
    expect(r.skipped).toEqual({ measured_under: 0, measured_under_pairs: [] })
  })

  it('good case: without temporal domains the same pair is a candidate', () => {
    const r = getCandidatePairsDetailed([a, b])
    expect(r.pairs).toHaveLength(1)
  })
})
