import { describe, it, expect } from 'vitest'
import { EngramSchema } from '../src/schemas/engram.js'
import { EpisodeSchema } from '../src/schemas/episode.js'
import { PlurConfigSchema } from '../src/schemas/config.js'
import { PackManifestSchema } from '../src/schemas/pack.js'

describe('EngramSchema', () => {
  it('validates a minimal engram with defaults', () => {
    const result = EngramSchema.safeParse({
      id: 'ENG-2026-0319-001',
      statement: 'API uses snake_case',
      type: 'behavioral',
      scope: 'global',
      status: 'active',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.version).toBe(2)
      expect(result.data.activation.retrieval_strength).toBe(0.7)
      expect(result.data.feedback_signals?.positive).toBe(0)
    }
  })

  it('rejects missing statement', () => {
    const result = EngramSchema.safeParse({ id: 'ENG-2026-0319-001', type: 'behavioral' })
    expect(result.success).toBe(false)
  })

  it('parses an insight engram (orthogonal sub-object) and defaults fate/grounding', () => {
    const result = EngramSchema.safeParse({
      id: 'ENG-2026-0614-042',
      statement: 'Wyckoff invalidation discipline recurs across losing trades',
      type: 'behavioral',
      scope: 'project:trading',
      status: 'candidate',
      knowledge_type: { memory_class: 'metacognitive', cognitive_level: 'analyze' },
      knowledge_anchors: [
        { path: '0-personal/notes/journals/2026-06-10.md', relevance: 'primary', snippet: 'closed early, ignored my own rule' },
      ],
      insight: {
        operation: 'distill',
        synthesized_at: '2026-06-14T03:00:00Z',
        source_episode_ids: ['EP-1', 'EP-2'],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      // type stays the cognitive class; insight is orthogonal
      expect(result.data.type).toBe('behavioral')
      expect(result.data.insight?.grounding).toBe('unverified') // default
      expect(result.data.insight?.fate).toBe('surfaced')        // default
      expect(result.data.insight?.surfaced_count).toBe(0)       // default
    }
  })

  it('accepts a serendipity-scored connect insight', () => {
    const result = EngramSchema.safeParse({
      id: 'ENG-2026-0614-043',
      statement: 'Trading risk discipline and health HRV recovery share a pre-commitment pattern',
      type: 'behavioral',
      scope: 'global',
      status: 'candidate',
      insight: {
        operation: 'connect',
        synthesized_at: '2026-06-14T03:00:00Z',
        grounding: 'verified',
        serendipity: { unexpectedness: 0.8, relevance: 0.6, score: 0.48 },
        fate: 'promoted',
        fate_ref: 'ENG-2026-0614-099',
        surfaced_count: 3,
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a speculative dream insight (operation=dream)', () => {
    const result = EngramSchema.safeParse({
      id: 'ENG-2026-0615-001',
      statement: 'Maybe Wyckoff accumulation phases rhyme with HRV recovery curves',
      type: 'behavioral',
      scope: 'global',
      status: 'candidate',
      insight: {
        operation: 'dream',
        synthesized_at: '2026-06-15T03:00:00Z',
        grounding: 'speculative',
        serendipity: { unexpectedness: 0.9, relevance: 0.4, score: 0.36 },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.insight?.fate).toBe('surfaced')
  })

  it('rejects promoting a speculative dream (promote-requires-grounding)', () => {
    const result = EngramSchema.safeParse({
      id: 'ENG-2026-0615-002',
      statement: 'speculative leap',
      type: 'behavioral',
      scope: 'global',
      status: 'candidate',
      insight: {
        operation: 'dream',
        synthesized_at: '2026-06-15T03:00:00Z',
        grounding: 'speculative',
        fate: 'promoted',
      },
    })
    expect(result.success).toBe(false)
  })

  it('still parses an engram with no insight sub-object (backward compat)', () => {
    const result = EngramSchema.safeParse({
      id: 'ENG-2026-0319-001',
      statement: 'API uses snake_case',
      type: 'behavioral',
      scope: 'global',
      status: 'active',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.insight).toBeUndefined()
  })

  it('rejects an invalid insight operation', () => {
    const result = EngramSchema.safeParse({
      id: 'ENG-2026-0614-044',
      statement: 'x',
      type: 'behavioral',
      scope: 'global',
      status: 'candidate',
      insight: { operation: 'hallucinate', synthesized_at: '2026-06-14T03:00:00Z' },
    })
    expect(result.success).toBe(false)
  })
})

describe('EpisodeSchema', () => {
  it('validates an episode', () => {
    const result = EpisodeSchema.safeParse({
      id: 'EP-123',
      summary: 'Fixed auth bug',
      agent: 'claude-code',
      timestamp: '2026-03-19T10:00:00Z',
    })
    expect(result.success).toBe(true)
  })
})

describe('PlurConfigSchema', () => {
  it('returns defaults for empty input', () => {
    const result = PlurConfigSchema.parse({})
    expect(result).toBeDefined()
  })
})

describe('PackManifestSchema', () => {
  it('validates with metadata field', () => {
    const result = PackManifestSchema.safeParse({
      name: 'test-pack',
      version: '1.0.0',
      metadata: { injection_policy: 'on_match' },
    })
    expect(result.success).toBe(true)
  })

  it('validates with legacy x-datacore field', () => {
    const result = PackManifestSchema.safeParse({
      name: 'test-pack',
      version: '1.0.0',
      'x-datacore': { id: 'test', injection_policy: 'on_match', engram_count: 10 },
    })
    expect(result.success).toBe(true)
  })
})
