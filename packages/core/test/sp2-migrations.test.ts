import { describe, it, expect } from 'vitest'
import { migration as m003 } from '../src/migrations/20260406-003-populate-memory-class.js'
import { migration as m005 } from '../src/migrations/20260406-005-add-version-field.js'
import type { Engram } from '../src/schemas/engram.js'

function makeEngram(overrides: Partial<Engram> = {}): Engram {
  return {
    id: 'ENG-2026-0406-001',
    version: 2,
    status: 'active',
    consolidated: false,
    type: 'behavioral',
    scope: 'global',
    visibility: 'private',
    statement: 'Test statement',
    activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-04-06' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_anchors: [],
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

describe('Migration 003: Populate memory_class', () => {
  it('sets memory_class=semantic for behavioral engrams', () => {
    const engrams = [makeEngram({ type: 'behavioral' })]
    const result = m003.up(engrams)
    expect((result[0] as any).knowledge_type?.memory_class).toBe('semantic')
  })

  it('sets memory_class=procedural for procedural engrams', () => {
    const engrams = [makeEngram({ type: 'procedural' })]
    const result = m003.up(engrams)
    expect((result[0] as any).knowledge_type?.memory_class).toBe('procedural')
  })

  it('sets memory_class=semantic for terminological engrams', () => {
    const engrams = [makeEngram({ type: 'terminological' })]
    const result = m003.up(engrams)
    expect((result[0] as any).knowledge_type?.memory_class).toBe('semantic')
  })

  it('sets memory_class=semantic for architectural engrams', () => {
    const engrams = [makeEngram({ type: 'architectural' })]
    const result = m003.up(engrams)
    expect((result[0] as any).knowledge_type?.memory_class).toBe('semantic')
  })

  it('preserves existing memory_class', () => {
    const engrams = [makeEngram({
      knowledge_type: { memory_class: 'episodic', cognitive_level: 'remember' },
    })]
    const result = m003.up(engrams)
    expect((result[0] as any).knowledge_type?.memory_class).toBe('episodic')
  })

  it('down() removes knowledge_type', () => {
    const engrams = [makeEngram({
      knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    })]
    const result = m003.down(engrams)
    expect((result[0] as any).knowledge_type).toBeUndefined()
  })
})

describe('Migration 005: Add version field', () => {
  it('sets engram_version=1 on engrams without it', () => {
    const raw = makeEngram()
    delete (raw as any).engram_version
    const result = m005.up([raw])
    expect((result[0] as any).engram_version).toBe(1)
  })

  it('sets episode_ids=[] on engrams without it', () => {
    const raw = makeEngram()
    delete (raw as any).episode_ids
    const result = m005.up([raw])
    expect((result[0] as any).episode_ids).toEqual([])
  })

  it('preserves existing engram_version', () => {
    const raw = makeEngram()
    ;(raw as any).engram_version = 3
    const result = m005.up([raw])
    expect((result[0] as any).engram_version).toBe(3)
  })

  it('preserves existing episode_ids', () => {
    const raw = makeEngram()
    ;(raw as any).episode_ids = ['EP-123']
    const result = m005.up([raw])
    expect((result[0] as any).episode_ids).toEqual(['EP-123'])
  })

  it('down() removes version fields', () => {
    const raw = makeEngram()
    ;(raw as any).engram_version = 2
    ;(raw as any).previous_version_ref = { event_id: 'EVT-1', changed_at: '2026-04-06' }
    ;(raw as any).episode_ids = ['EP-1']
    const result = m005.down([raw])
    expect((result[0] as any).engram_version).toBeUndefined()
    expect((result[0] as any).previous_version_ref).toBeUndefined()
    expect((result[0] as any).episode_ids).toBeUndefined()
  })
})
