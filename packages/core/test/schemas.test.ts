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
