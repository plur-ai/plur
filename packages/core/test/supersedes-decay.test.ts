import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { applyBatchDecay } from '../src/decay.js'
import type { Engram } from '../src/schemas/engram.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-supersedes-decay-'))
}

function makeEngram(overrides: Partial<Engram> & { id: string }): Engram {
  return {
    version: 2,
    status: 'active',
    consolidated: false,
    type: 'behavioral',
    scope: 'global',
    visibility: 'private',
    statement: 'test engram',
    activation: {
      retrieval_strength: 0.7,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2025-01-01',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    associations: [],
    derivation_count: 1,
    tags: [],
    pack: null,
    abstract: null,
    derived_from: null,
    polarity: null,
    engram_version: 1,
    episode_ids: [],
    ...overrides,
  } as Engram
}

describe('supersedes chain — accelerated decay (#481)', () => {
  let historyRoot: string

  beforeEach(() => { historyRoot = tmpDir() })
  afterEach(() => { fs.rmSync(historyRoot, { recursive: true, force: true }) })

  it('superseded engram decays faster than non-superseded engram', () => {
    const now = new Date('2026-07-04')
    const lastAccessed = '2025-01-01'

    const superseded = makeEngram({
      id: 'ENG-2026-0101-001',
      activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: lastAccessed },
      relations: {
        broader: [], narrower: [], related: [], conflicts: [],
        supersedes: [],
        superseded_by: ['ENG-2026-0101-002'],
      } as any,
    })

    const tip = makeEngram({
      id: 'ENG-2026-0101-002',
      activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: lastAccessed },
      relations: {
        broader: [], narrower: [], related: [], conflicts: [],
        supersedes: ['ENG-2026-0101-001'],
        superseded_by: [],
      } as any,
    })

    const { modified } = applyBatchDecay([superseded, tip], historyRoot, { now })

    const modifiedSuperseded = modified.find(e => e.id === 'ENG-2026-0101-001')
    const modifiedTip = modified.find(e => e.id === 'ENG-2026-0101-002')

    expect(modifiedSuperseded).toBeDefined()
    expect(modifiedTip).toBeDefined()
    // Superseded engram should have lower strength (faster decay)
    expect(modifiedSuperseded!.activation.retrieval_strength).toBeLessThan(
      modifiedTip!.activation.retrieval_strength
    )
  })

  it('superseded engram with high recall_count (frequency >= 5) does NOT get accelerated decay', () => {
    const now = new Date('2026-07-04')
    const lastAccessed = '2025-01-01'

    const supersededHighRecall = makeEngram({
      id: 'ENG-2026-0101-003',
      activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 5, last_accessed: lastAccessed },
      relations: {
        broader: [], narrower: [], related: [], conflicts: [],
        supersedes: [],
        superseded_by: ['ENG-2026-0101-004'],
      } as any,
    })

    const tip = makeEngram({
      id: 'ENG-2026-0101-004',
      activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: lastAccessed },
      relations: {
        broader: [], narrower: [], related: [], conflicts: [],
        supersedes: ['ENG-2026-0101-003'],
        superseded_by: [],
      } as any,
    })

    const { modified } = applyBatchDecay([supersededHighRecall, tip], historyRoot, { now })

    const modifiedHighRecall = modified.find(e => e.id === 'ENG-2026-0101-003')
    const modifiedTip = modified.find(e => e.id === 'ENG-2026-0101-004')

    expect(modifiedHighRecall).toBeDefined()
    expect(modifiedTip).toBeDefined()
    // High-recall superseded engram should decay at the SAME rate as the tip (no acceleration)
    expect(modifiedHighRecall!.activation.retrieval_strength).toBeCloseTo(
      modifiedTip!.activation.retrieval_strength, 5
    )
  })
})
