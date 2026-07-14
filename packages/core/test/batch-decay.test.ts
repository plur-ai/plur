import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { applyBatchDecay, strengthToStatus } from '../src/decay.js'
import { readHistory } from '../src/history.js'
import { Plur } from '../src/index.js'
import { loadEngrams, saveEngrams } from '../src/engrams.js'
import type { Engram } from '../src/schemas/engram.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-batch-decay-'))
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
      last_accessed: '2026-01-01',
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

describe('strengthToStatus', () => {
  it('maps strength ranges to correct statuses', () => {
    expect(strengthToStatus(0.8)).toBe('active')
    expect(strengthToStatus(0.51)).toBe('active')
    expect(strengthToStatus(0.5)).toBe('fading')
    expect(strengthToStatus(0.4)).toBe('fading')
    expect(strengthToStatus(0.31)).toBe('fading')
    expect(strengthToStatus(0.3)).toBe('dormant')
    expect(strengthToStatus(0.2)).toBe('dormant')
    expect(strengthToStatus(0.11)).toBe('dormant')
    expect(strengthToStatus(0.1)).toBe('retirement_candidate')
    expect(strengthToStatus(0.05)).toBe('retirement_candidate')
    expect(strengthToStatus(0.0)).toBe('retirement_candidate')
  })
})

describe('applyBatchDecay', () => {
  let historyRoot: string

  beforeEach(() => {
    historyRoot = tmpDir()
  })

  afterEach(() => {
    fs.rmSync(historyRoot, { recursive: true, force: true })
  })

  it('decays engrams not accessed recently', () => {
    const engrams = [
      makeEngram({
        id: 'ENG-2026-0101-001',
        activation: {
          retrieval_strength: 0.7,
          storage_strength: 1.0,
          frequency: 5,
          last_accessed: '2025-06-01',
        },
      }),
    ]

    const now = new Date('2026-04-22')
    const { result, modified } = applyBatchDecay(engrams, historyRoot, { now })

    expect(result.total).toBe(1)
    expect(result.decayed).toBe(1)
    expect(result.skipped).toBe(0)
    expect(modified.length).toBe(1)
    expect(modified[0].activation.retrieval_strength).toBeLessThan(0.7)
  })

  it('skips scope-matched engrams', () => {
    const engrams = [
      makeEngram({
        id: 'ENG-2026-0101-001',
        scope: 'project:myapp',
        activation: {
          retrieval_strength: 0.7,
          storage_strength: 1.0,
          frequency: 5,
          last_accessed: '2025-06-01',
        },
      }),
    ]

    const now = new Date('2026-04-22')
    const { result, modified } = applyBatchDecay(engrams, historyRoot, {
      now,
      contextScope: 'project:myapp',
    })

    expect(result.skipped).toBe(1)
    expect(result.decayed).toBe(0)
    expect(modified.length).toBe(0)
  })

  it('logs status transitions to history', () => {
    // Start at 0.55 (active), decay heavily so it crosses into fading
    const engrams = [
      makeEngram({
        id: 'ENG-2026-0101-001',
        activation: {
          retrieval_strength: 0.55,
          storage_strength: 1.0,
          frequency: 5,
          last_accessed: '2024-01-01',
        },
      }),
    ]

    const now = new Date('2026-04-22')
    const { result } = applyBatchDecay(engrams, historyRoot, { now })

    expect(result.transitions.length).toBeGreaterThan(0)

    // Check history was written
    const events = readHistory(historyRoot, '2026-04')
    const transitionEvents = events.filter(e => e.event === 'engram_updated')
    expect(transitionEvents.length).toBeGreaterThan(0)
    expect(transitionEvents[0].data.reason).toBe('decay_status_transition')
  })

  it('strength never goes below floor (0.05)', () => {
    const engrams = [
      makeEngram({
        id: 'ENG-2026-0101-001',
        activation: {
          retrieval_strength: 0.1,
          storage_strength: 1.0,
          frequency: 0,
          last_accessed: '2020-01-01',
        },
      }),
    ]

    const now = new Date('2026-04-22')
    const { modified } = applyBatchDecay(engrams, historyRoot, { now })

    expect(modified[0].activation.retrieval_strength).toBeGreaterThanOrEqual(0.05)
  })

  it('returns valid BatchDecayResult structure', () => {
    const engrams = [
      makeEngram({
        id: 'ENG-2026-0101-001',
        activation: {
          retrieval_strength: 0.7,
          storage_strength: 1.0,
          frequency: 5,
          last_accessed: '2025-06-01',
        },
      }),
      makeEngram({
        id: 'ENG-2026-0101-002',
        status: 'retired',
        activation: {
          retrieval_strength: 0.3,
          storage_strength: 1.0,
          frequency: 0,
          last_accessed: '2025-01-01',
        },
      }),
    ]

    const now = new Date('2026-04-22')
    const { result } = applyBatchDecay(engrams, historyRoot, { now })

    expect(result).toHaveProperty('total')
    expect(result).toHaveProperty('decayed')
    expect(result).toHaveProperty('skipped')
    expect(result).toHaveProperty('transitions')
    expect(typeof result.total).toBe('number')
    expect(typeof result.decayed).toBe('number')
    expect(typeof result.skipped).toBe('number')
    expect(Array.isArray(result.transitions)).toBe(true)
    // Retired engrams should not be processed
    expect(result.total).toBe(1)
  })

  it('applies emotional_weight modifier to decay rate', () => {
    // High emotional weight = slower decay
    const highEmotion = makeEngram({
      id: 'ENG-2026-0101-001',
      episodic: {
        emotional_weight: 10,
        confidence: 5,
      },
      activation: {
        retrieval_strength: 0.7,
        storage_strength: 1.0,
        frequency: 5,
        last_accessed: '2025-06-01',
      },
    })

    // Low emotional weight = faster decay
    const lowEmotion = makeEngram({
      id: 'ENG-2026-0101-002',
      episodic: {
        emotional_weight: 1,
        confidence: 5,
      },
      activation: {
        retrieval_strength: 0.7,
        storage_strength: 1.0,
        frequency: 5,
        last_accessed: '2025-06-01',
      },
    })

    const now = new Date('2026-04-22')
    const { modified: highMod } = applyBatchDecay([highEmotion], historyRoot, { now })
    const { modified: lowMod } = applyBatchDecay([lowEmotion], historyRoot, { now })

    // High emotional weight should decay less (higher remaining strength)
    expect(highMod[0].activation.retrieval_strength).toBeGreaterThan(
      lowMod[0].activation.retrieval_strength
    )
  })

  it('does not decay engrams accessed today', () => {
    const engrams = [
      makeEngram({
        id: 'ENG-2026-0101-001',
        activation: {
          retrieval_strength: 0.7,
          storage_strength: 1.0,
          frequency: 5,
          last_accessed: '2026-04-22',
        },
      }),
    ]

    const now = new Date('2026-04-22')
    const { result, modified } = applyBatchDecay(engrams, historyRoot, { now })

    // 0 days since access = no decay applied (strength unchanged)
    expect(result.decayed).toBe(0)
    expect(modified.length).toBe(0)
  })
})

describe('Plur.batchDecay() wrapper — data preservation (#dataloss)', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-batchdecay-wrap-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // The wrapper (index.ts:3079-3094) writes back only `applyBatchDecay(...).modified`
  // — the strength-CHANGED active engrams. Every other engram (accessed today,
  // scope-skipped, sub-threshold, or retired) is absent from `modified`, so
  // `_writeEngrams(paths.engrams, modified)` overwrites the whole store with that
  // subset and DELETED them. Confirmed at the time: 5 engrams in, 2 out. There
  // was no test on the wrapper at all — applyBatchDecay's own unit tests never
  // exercised the write-back. FIXED: the wrapper now writes the full in-place-
  // mutated list. This asserts the invariant: batchDecay may change strengths
  // but must never drop an engram.
  it('preserves every engram; only decays strengths (#dataloss)', () => {
    const engramsPath = path.join(dir, 'engrams.yaml')
    const seed: Engram[] = [
      // Stale AND crosses a status boundary → guarantees transitions > 0, so the
      // wrapper's buggy write actually fires.
      makeEngram({
        id: 'ENG-2026-0101-001',
        activation: { retrieval_strength: 0.55, storage_strength: 1.0, frequency: 5, last_accessed: '2024-01-01' },
      }),
      makeEngram({
        id: 'ENG-2026-0101-002',
        activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 5, last_accessed: '2025-06-01' },
      }),
      // Accessed today (days === 0) → never enters `modified`.
      makeEngram({
        id: 'ENG-2026-0101-003',
        activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 5, last_accessed: '2026-04-22' },
      }),
      // Scope-skipped → never enters `modified`.
      makeEngram({
        id: 'ENG-2026-0101-004',
        scope: 'project:myapp',
        activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 5, last_accessed: '2025-06-01' },
      }),
      // Retired → excluded from `active` → never enters `modified`.
      makeEngram({
        id: 'ENG-2026-0101-005',
        status: 'retired',
        activation: { retrieval_strength: 0.3, storage_strength: 1.0, frequency: 0, last_accessed: '2025-01-01' },
      }),
    ]
    saveEngrams(engramsPath, seed)

    const plur = new Plur({ path: dir })
    plur.batchDecay({ contextScope: 'project:myapp', now: new Date('2026-04-22') })

    // Reload the raw store: no engram may be deleted.
    const survivors = loadEngrams(engramsPath)
    expect(survivors).toHaveLength(5)
    const ids = new Set(survivors.map(e => e.id))
    expect(ids.has('ENG-2026-0101-003')).toBe(true) // accessed-today survives
    expect(ids.has('ENG-2026-0101-004')).toBe(true) // scope-skipped survives
    expect(ids.has('ENG-2026-0101-005')).toBe(true) // retired survives

    // status() counts non-retired engrams — 4 of the 5 (retired excluded).
    expect(new Plur({ path: dir }).status().engram_count).toBe(4)
  })
})
