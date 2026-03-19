import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

describe('Plur', () => {
  let plur: Plur
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-integration-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('learn and recall', () => {
    const engram = plur.learn('API uses snake_case', { scope: 'project:myapp', type: 'behavioral' })
    expect(engram.id).toMatch(/^ENG-/)
    const results = plur.recall('API naming convention snake')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].statement).toContain('snake_case')
  })

  it('inject returns scored engrams within budget', () => {
    plur.learn('Always use blue-green deploy strategies', { scope: 'global' })
    plur.learn('Database for myapp is PostgreSQL', { scope: 'project:myapp' })
    const result = plur.inject('deploy myapp database', { budget: 500, scope: 'project:myapp' })
    expect(result.count).toBeGreaterThan(0)
    expect(result.tokens_used).toBeLessThanOrEqual(500)
  })

  it('feedback strengthens engrams', () => {
    const engram = plur.learn('Use feature flags', { scope: 'global' })
    plur.feedback(engram.id, 'positive')
    plur.feedback(engram.id, 'positive')
    const recalled = plur.recall('feature flags')
    expect(recalled[0].feedback_signals?.positive).toBe(2)
  })

  it('forget retires engrams', () => {
    const engram = plur.learn('Wrong info about something specific', { scope: 'global' })
    plur.forget(engram.id, 'incorrect')
    const recalled = plur.recall('Wrong info specific')
    expect(recalled).toHaveLength(0)
  })

  it('capture and timeline', () => {
    plur.capture('Fixed auth bug', { agent: 'claude-code' })
    plur.capture('Deployed to staging', { agent: 'openclaw', channel: 'telegram' })
    const episodes = plur.timeline()
    expect(episodes).toHaveLength(2)
    const filtered = plur.timeline({ agent: 'openclaw' })
    expect(filtered).toHaveLength(1)
  })

  it('ingest extracts engrams from content', () => {
    const candidates = plur.ingest(
      'We decided to use PostgreSQL for ACID compliance. Always run migrations before deploy.',
      { source: 'conversation', extract_only: true }
    )
    expect(candidates.length).toBeGreaterThan(0)
  })

  it('status returns system info', () => {
    const status = plur.status()
    expect(status.engram_count).toBe(0)
    plur.learn('Test engram', { scope: 'global' })
    const status2 = plur.status()
    expect(status2.engram_count).toBe(1)
  })

  it('conflict detection warns on learn', () => {
    plur.learn('API uses camelCase for responses', { scope: 'project:myapp' })
    const conflicting = plur.learn('API uses snake_case for responses', { scope: 'project:myapp' })
    // Conflicting engram should still be saved (conflicts are surfaced, not blocked)
    expect(conflicting.id).toMatch(/^ENG-/)
    // The relations.conflicts field should reference the first engram
    expect(conflicting.relations?.conflicts?.length).toBeGreaterThan(0)
  })

  it('inject returns empty result when no engrams match', () => {
    const result = plur.inject('completely unrelated topic xyz123')
    expect(result.count).toBe(0)
    expect(result.directives).toBe('')
    expect(result.consider).toBe('')
    expect(result.tokens_used).toBe(0)
  })

  it('learn returns engram with correct type', () => {
    const engram = plur.learn('Always use PostgreSQL for persistence', {
      type: 'architectural',
      scope: 'project:api',
      domain: 'database',
    })
    expect(engram.type).toBe('architectural')
    expect(engram.scope).toBe('project:api')
    expect(engram.domain).toBe('database')
  })

  it('recall filters by scope', () => {
    plur.learn('Use Redis for caching', { scope: 'project:alpha' })
    plur.learn('Use Redis for caching', { scope: 'project:beta' })
    plur.learn('Use Redis for caching', { scope: 'global' })
    const results = plur.recall('Redis caching', { scope: 'project:alpha' })
    // Should include global + project:alpha, not project:beta
    for (const r of results) {
      expect(['global', 'project:alpha']).toContain(r.scope)
    }
  })

  it('recall respects limit option', () => {
    for (let i = 0; i < 5; i++) {
      plur.learn(`Use pattern ${i} for testing purposes`, { scope: 'global' })
    }
    const results = plur.recall('pattern testing', { limit: 3 })
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('feedback throws on unknown id', () => {
    expect(() => plur.feedback('ENG-9999-01-001', 'positive')).toThrow('Engram not found')
  })

  it('forget throws on unknown id', () => {
    expect(() => plur.forget('ENG-9999-01-001', 'test')).toThrow('Engram not found')
  })

  it('status includes storage root', () => {
    const status = plur.status()
    expect(status.storage_root).toBe(dir)
  })

  it('ingest saves engrams when not extract_only', () => {
    plur.ingest(
      'We decided to use TypeScript for all new projects.',
      { source: 'conversation', scope: 'global' }
    )
    const status = plur.status()
    expect(status.engram_count).toBeGreaterThan(0)
  })

  it('inject formats directives as readable strings', () => {
    plur.learn('Always validate inputs', { scope: 'global' })
    const result = plur.inject('validate user input')
    if (result.count > 0) {
      expect(result.directives).toMatch(/\[ENG-/)
    }
  })
})
