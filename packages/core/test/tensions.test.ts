import { describe, it, expect } from 'vitest'
import {
  scopesOverlap,
  domainSegmentsOverlap,
  subjectsOverlap,
  getCandidatePairs,
  buildContradictionPrompt,
  parseContradictionResponse,
} from '../src/tensions.js'
import type { Engram } from '../src/schemas/engram.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEngram(overrides: Partial<Engram> & { id: string; statement: string; scope?: string }): Engram {
  return {
    version: 2,
    status: 'active',
    consolidated: false,
    type: 'factual',
    scope: 'global',
    visibility: 'private',
    activation: {
      retrieval_strength: 0.7,
      storage_strength: 1,
      frequency: 0,
      last_accessed: '2026-05-16',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    knowledge_anchors: [],
    associations: [],
    derivation_count: 1,
    tags: [],
    content_hash: overrides.id,
    commitment: 'leaning',
    engram_version: 1,
    episode_ids: [],
    polarity: null,
    ...overrides,
  } as Engram
}

// ---------------------------------------------------------------------------
// scopesOverlap
// ---------------------------------------------------------------------------

describe('scopesOverlap', () => {
  it('global + global → overlap', () => {
    expect(scopesOverlap('global', 'global')).toBe(true)
  })

  it('global + project:plur → overlap (global is universal)', () => {
    expect(scopesOverlap('global', 'project:plur')).toBe(true)
    expect(scopesOverlap('project:plur', 'global')).toBe(true)
  })

  it('identical scopes → overlap', () => {
    expect(scopesOverlap('project:plur', 'project:plur')).toBe(true)
  })

  it('same level prefix, different value → no overlap (conservative rule)', () => {
    // Conservative rule: different projects are different namespaces — skip cross-project pairs
    expect(scopesOverlap('project:plur', 'project:datacore')).toBe(false)
  })

  it('different levels → no overlap', () => {
    // "project:" vs "group:" are distinct namespace levels
    expect(scopesOverlap('project:plur', 'group:datafund')).toBe(false)
  })

  it('global vs group → overlap', () => {
    expect(scopesOverlap('global', 'group:datafund')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// domainSegmentsOverlap
// ---------------------------------------------------------------------------

describe('domainSegmentsOverlap', () => {
  it('identical domains → overlap', () => {
    expect(domainSegmentsOverlap('plur.core', 'plur.core')).toBe(true)
  })

  it('shared prefix segment → overlap', () => {
    expect(domainSegmentsOverlap('plur.core.learn', 'plur.mcp')).toBe(true)
  })

  it('no shared segment → no overlap', () => {
    expect(domainSegmentsOverlap('trading.positions', 'plur.core')).toBe(false)
  })

  it('missing domain on one side → overlap (permissive)', () => {
    expect(domainSegmentsOverlap(undefined, 'plur.core')).toBe(true)
    expect(domainSegmentsOverlap('plur.core', undefined)).toBe(true)
  })

  it('missing domain on both sides → overlap', () => {
    expect(domainSegmentsOverlap(undefined, undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// subjectsOverlap
// ---------------------------------------------------------------------------

describe('subjectsOverlap', () => {
  it('identical subjects → overlap', () => {
    expect(subjectsOverlap(
      'The plur CLI uses BM25 for search.',
      'The plur CLI uses embeddings for search.',
    )).toBe(true)
  })

  it('shared key entity → overlap', () => {
    expect(subjectsOverlap(
      'Protocol fee is set to 1% of transaction volume.',
      'Protocol fee was increased to 2% in v3.',
    )).toBe(true)
  })

  it('completely different subjects → no overlap', () => {
    // Classic false-positive from original system: unrelated facts in same domain
    expect(subjectsOverlap(
      'Plur CLI is at v0.8.2.',
      'MemPalace is a competitor product.',
    )).toBe(false)
  })

  it('domain-adjacent but different subjects → no overlap', () => {
    expect(subjectsOverlap(
      'Engrams decay using ACT-R activation model.',
      'Sessions start with plur_session_start call.',
    )).toBe(false)
  })

  it('shared project name → overlap', () => {
    expect(subjectsOverlap(
      'Verity marketplace is built on Ethereum.',
      'Verity marketplace uses Polygon for transactions.',
    )).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getCandidatePairs (integration of the three-stage pipeline)
// ---------------------------------------------------------------------------

describe('getCandidatePairs', () => {
  it('returns pairs in same scope with overlapping subjects', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur search uses BM25 indexing.', scope: 'global' })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embedding vectors.', scope: 'global' })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(1)
    expect(pairs[0].map(e => e.id).sort()).toEqual(['E1', 'E2'])
  })

  it('skips pairs in disjoint scopes', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur search uses BM25.', scope: 'project:plur' })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embeddings.', scope: 'group:datafund' })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(0)
  })

  it('skips pairs with non-overlapping domains', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur search uses BM25.', scope: 'global', domain: 'plur.core' })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embeddings.', scope: 'global', domain: 'trading.positions' })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(0)
  })

  it('skips pairs with non-overlapping subjects', () => {
    const a = makeEngram({ id: 'E1', statement: 'Plur CLI is at v0.9.9.', scope: 'global' })
    const b = makeEngram({ id: 'E2', statement: 'MemPalace is a competitor.', scope: 'global' })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(0)
  })

  it('skips inactive engrams', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur search uses BM25.', scope: 'global' })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embeddings.', scope: 'global', status: 'retired' as any })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(0)
  })

  it('skips already-known conflict pairs', () => {
    const a = makeEngram({
      id: 'E1',
      statement: 'plur search uses BM25.',
      scope: 'global',
      relations: { conflicts: ['E2'] },
    })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embeddings.', scope: 'global' })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(0)
  })

  it('returns no pairs for empty list', () => {
    expect(getCandidatePairs([])).toHaveLength(0)
  })

  it('returns no pairs for single engram', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur uses YAML.', scope: 'global' })
    expect(getCandidatePairs([a])).toHaveLength(0)
  })

  it('global engrams pair with project-scoped engrams', () => {
    const a = makeEngram({ id: 'E1', statement: 'plur search uses BM25.', scope: 'global' })
    const b = makeEngram({ id: 'E2', statement: 'plur search uses embeddings.', scope: 'project:plur' })
    const pairs = getCandidatePairs([a, b])
    expect(pairs).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// buildContradictionPrompt
// ---------------------------------------------------------------------------

describe('buildContradictionPrompt', () => {
  it('includes both statement IDs and text', () => {
    const prompt = buildContradictionPrompt(
      { id: 'E1', statement: 'X is true.' },
      { id: 'E2', statement: 'X is false.' },
    )
    expect(prompt).toContain('E1')
    expect(prompt).toContain('E2')
    expect(prompt).toContain('X is true.')
    expect(prompt).toContain('X is false.')
  })

  it('instructs the model to use the exact response format', () => {
    const prompt = buildContradictionPrompt({ id: 'E1', statement: 'A' }, { id: 'E2', statement: 'B' })
    expect(prompt).toContain('CONTRADICTS: yes|no')
    expect(prompt).toContain('CONFIDENCE: 0.0-1.0')
    expect(prompt).toContain('REASON:')
  })
})

// ---------------------------------------------------------------------------
// parseContradictionResponse
// ---------------------------------------------------------------------------

describe('parseContradictionResponse', () => {
  it('parses a clear yes response', () => {
    const result = parseContradictionResponse(`CONTRADICTS: yes
CONFIDENCE: 0.92
REASON: Statement A says the fee is 1% while B says 2%.`)
    expect(result.is_contradiction).toBe(true)
    expect(result.confidence).toBeCloseTo(0.92)
    expect(result.reason).toContain('fee')
  })

  it('parses a clear no response', () => {
    const result = parseContradictionResponse(`CONTRADICTS: no
CONFIDENCE: 0.10
REASON: These describe different aspects of the system.`)
    expect(result.is_contradiction).toBe(false)
    expect(result.confidence).toBeCloseTo(0.10)
  })

  it('clamps confidence to [0, 1]', () => {
    const overHigh = parseContradictionResponse('CONTRADICTS: yes\nCONFIDENCE: 1.5\nREASON: x')
    expect(overHigh.confidence).toBe(1)

    const negative = parseContradictionResponse('CONTRADICTS: yes\nCONFIDENCE: -0.3\nREASON: x')
    expect(negative.confidence).toBe(0)
  })

  it('handles case-insensitive CONTRADICTS value', () => {
    const upper = parseContradictionResponse('CONTRADICTS: YES\nCONFIDENCE: 0.8\nREASON: x')
    expect(upper.is_contradiction).toBe(true)
    const lower = parseContradictionResponse('CONTRADICTS: No\nCONFIDENCE: 0.2\nREASON: x')
    expect(lower.is_contradiction).toBe(false)
  })

  it('returns safe defaults for malformed response', () => {
    const result = parseContradictionResponse('Sorry, I cannot determine this.')
    expect(result.is_contradiction).toBe(false)
    expect(result.confidence).toBe(0)
    expect(result.reason).toBe('')
  })

  it('parses reason correctly', () => {
    const result = parseContradictionResponse(
      'CONTRADICTS: yes\nCONFIDENCE: 0.85\nREASON: One says always, the other says never.',
    )
    expect(result.reason).toBe('One says always, the other says never.')
  })
})
