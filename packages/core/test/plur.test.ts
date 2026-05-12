import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
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

  it('feedback strengthens engrams', async () => {
    const engram = plur.learn('Use feature flags', { scope: 'global' })
    await plur.feedback(engram.id, 'positive')
    await plur.feedback(engram.id, 'positive')
    const recalled = plur.recall('feature flags')
    expect(recalled[0].feedback_signals?.positive).toBe(2)
  })

  it('forget retires engrams', async () => {
    const engram = plur.learn('Wrong info about something specific', { scope: 'global' })
    await plur.forget(engram.id, 'incorrect')
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

  it('conflicting statements are both saved (no auto-conflict detection)', () => {
    plur.learn('API uses camelCase for responses', { scope: 'project:myapp' })
    const conflicting = plur.learn('API uses snake_case for responses', { scope: 'project:myapp' })
    // Both engrams are saved — conflicts are surfaced via plur_tensions, not auto-detected on learn
    expect(conflicting.id).toMatch(/^ENG-/)
    // Auto-conflict detection was removed (issue #137 — produced 109K false positives)
    expect(conflicting.relations?.conflicts ?? []).toHaveLength(0)
  })

  it('same statement in a different scope is a promotion, not a duplicate (issue #136)', () => {
    const local = plur.learn('pnpm build before tests', { scope: 'global' })
    const promoted = plur.learn('pnpm build before tests', { scope: 'group:team/eng' })
    // Different scope → new engram, not a dedup hit
    expect(promoted.id).not.toBe(local.id)
    expect(promoted.id).toMatch(/^ENG-/)
    expect(promoted.scope).toBe('group:team/eng')
    expect(plur.status().engram_count).toBe(2)
  })

  it('inject returns empty result when no engrams match', () => {
    const result = plur.inject('completely unrelated topic xyz123')
    expect(result.count).toBe(0)
    expect(result.directives).toBe('')
    expect(result.constraints).toBe('')
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

  it('feedback throws on unknown id', async () => {
    await expect(plur.feedback('ENG-9999-01-001', 'positive')).rejects.toThrow('Engram not found')
  })

  it('forget throws on unknown id', async () => {
    await expect(plur.forget('ENG-9999-01-001', 'test')).rejects.toThrow('Engram not found')
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

  it('inject formats engrams into buckets as readable strings', () => {
    plur.learn('Always validate inputs', { scope: 'global' })
    const result = plur.inject('validate user input')
    if (result.count > 0) {
      const allOutput = [result.directives, result.constraints, result.consider].join('\n')
      expect(allOutput).toMatch(/\[ENG-/)
    }
  })

  it('saveMetaEngrams persists to store and skips duplicates', () => {
    const meta = {
      id: 'META-test-principle',
      version: 2,
      status: 'active',
      consolidated: false,
      type: 'behavioral',
      scope: 'global',
      visibility: 'private',
      statement: 'Test meta-engram principle',
      domain: 'meta',
      tags: ['meta-engram'],
      activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-03-29' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_anchors: [],
      associations: [],
      derivation_count: 2,
      pack: null,
      abstract: null,
      derived_from: null,
      polarity: null,
    } as any

    // Save first time
    const { saved, skipped } = plur.saveMetaEngrams([meta])
    expect(saved).toBe(1)
    expect(skipped).toBe(0)

    // Verify it's in the store
    const all = plur.list()
    const metas = all.filter(e => e.id.startsWith('META-'))
    expect(metas).toHaveLength(1)
    expect(metas[0].id).toBe('META-test-principle')

    // Save again — should skip duplicate
    const { saved: saved2, skipped: skipped2 } = plur.saveMetaEngrams([meta])
    expect(saved2).toBe(0)
    expect(skipped2).toBe(1)

    // Total should still be 1
    expect(plur.list().filter(e => e.id.startsWith('META-')).length).toBe(1)
  })

  it('updateEngram persists changes to an existing engram', () => {
    const engram = plur.learn('Original statement', { scope: 'global' })
    engram.statement = 'Updated statement'
    engram.activation.retrieval_strength = 0.99
    const updated = plur.updateEngram(engram)
    expect(updated).toBe(true)

    const recalled = plur.list()
    const found = recalled.find(e => e.id === engram.id)
    expect(found?.statement).toBe('Updated statement')
    expect(found?.activation.retrieval_strength).toBe(0.99)
  })

  it('updateEngram returns false for non-existent ID', () => {
    const fake = {
      id: 'ENG-9999-01-001',
      version: 2, status: 'active', consolidated: false,
      type: 'behavioral', scope: 'global', visibility: 'private',
      statement: 'Ghost engram',
      tags: [], domain: undefined,
      activation: { retrieval_strength: 0.5, storage_strength: 1, frequency: 0, last_accessed: '2026-03-29' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_anchors: [], associations: [],
      derivation_count: 1,
      pack: null, abstract: null, derived_from: null, polarity: null,
    } as any
    expect(plur.updateEngram(fake)).toBe(false)
  })

  it('saveMetaEngrams coexists with regular engrams', () => {
    plur.learn('Regular engram', { scope: 'global' })
    const meta = {
      id: 'META-coexist',
      version: 2,
      status: 'active',
      consolidated: false,
      type: 'behavioral',
      scope: 'global',
      visibility: 'private',
      statement: 'Meta coexistence test',
      domain: 'meta',
      tags: ['meta-engram'],
      activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-03-29' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_anchors: [],
      associations: [],
      derivation_count: 1,
      pack: null,
      abstract: null,
      derived_from: null,
      polarity: null,
    } as any
    plur.saveMetaEngrams([meta])

    const all = plur.list()
    expect(all.length).toBe(2)
    expect(all.some(e => e.id.startsWith('ENG-'))).toBe(true)
    expect(all.some(e => e.id.startsWith('META-'))).toBe(true)
  })

  it('recall excludes expired engrams (valid_until in the past)', () => {
    const engram = plur.learn('Temporary API endpoint is /v1/beta', { scope: 'global' })
    engram.temporal = { learned_at: '2026-01-01', valid_until: '2026-01-31' }
    plur.updateEngram(engram)
    const results = plur.recall('API endpoint beta')
    expect(results).toHaveLength(0)
  })

  it('recall excludes not-yet-valid engrams (valid_from in the future)', () => {
    const engram = plur.learn('New API launches with GraphQL endpoint', { scope: 'global' })
    engram.temporal = { learned_at: '2026-03-30', valid_from: '2099-01-01' }
    plur.updateEngram(engram)
    const results = plur.recall('GraphQL API endpoint')
    expect(results).toHaveLength(0)
  })

  it('recall includes engrams without temporal fields', () => {
    plur.learn('Always use HTTPS for API calls', { scope: 'global' })
    const results = plur.recall('HTTPS API calls')
    expect(results.length).toBeGreaterThan(0)
  })

  it('recall includes engrams within temporal window', () => {
    const engram = plur.learn('Current sprint focus is performance', { scope: 'global' })
    engram.temporal = { learned_at: '2026-01-01', valid_from: '2026-01-01', valid_until: '2099-12-31' }
    plur.updateEngram(engram)
    const results = plur.recall('sprint performance focus')
    expect(results.length).toBeGreaterThan(0)
  })

  it('learn rejects statements containing secrets', () => {
    expect(() => plur.learn('API key is sk-1234567890abcdefghijklmn')).toThrow('Secret detected')
  })

  it('learn allows clean statements', () => {
    const engram = plur.learn('Store API keys in environment variables', { scope: 'global' })
    expect(engram.id).toMatch(/^ENG-/)
  })

  it('learn allows secrets when allow_secrets config is true', () => {
    writeFileSync(join(dir, 'config.yaml'), 'allow_secrets: true\n')
    const permissivePlur = new Plur({ path: dir })
    const engram = permissivePlur.learn('API key is sk-1234567890abcdefghijklmn')
    expect(engram.id).toMatch(/^ENG-/)
  })

  it('ingest skips candidates containing secrets', () => {
    const candidates = plur.ingest(
      'We decided to use password = supersecretpass123 for the database. Always encrypt at rest.',
      { source: 'conversation', extract_only: true }
    )
    for (const c of candidates) {
      expect(c.statement).not.toMatch(/supersecretpass123/)
    }
  })

  it('recall creates co-access associations between co-recalled engrams', () => {
    const e1 = plur.learn('PostgreSQL is the primary database', { scope: 'global' })
    const e2 = plur.learn('PostgreSQL requires connection pooling', { scope: 'global' })
    plur.recall('PostgreSQL database')
    const all = plur.list()
    const updated1 = all.find(e => e.id === e1.id)!
    const coAccess1 = updated1.associations.filter(a => a.type === 'co_accessed')
    expect(coAccess1.length).toBeGreaterThan(0)
    expect(coAccess1[0].target).toBe(e2.id)
    expect(coAccess1[0].strength).toBe(0.3)
  })

  it('recall strengthens existing co-access associations on repeat', () => {
    const e1 = plur.learn('Redis is used for caching layer', { scope: 'global' })
    const e2 = plur.learn('Redis requires memory monitoring', { scope: 'global' })
    plur.recall('Redis caching memory')
    plur.recall('Redis caching memory')
    const all = plur.list()
    const updated1 = all.find(e => e.id === e1.id)!
    const coAccess1 = updated1.associations.filter(a => a.type === 'co_accessed')
    expect(coAccess1[0].strength).toBe(0.35) // 0.3 initial + 0.05 bump
  })

  it('co-access associations are bidirectional', () => {
    const e1 = plur.learn('Docker containers for deployment', { scope: 'global' })
    const e2 = plur.learn('Docker compose for local development', { scope: 'global' })
    plur.recall('Docker containers compose')
    const all = plur.list()
    const u1 = all.find(e => e.id === e1.id)!
    const u2 = all.find(e => e.id === e2.id)!
    expect(u1.associations.some(a => a.type === 'co_accessed' && a.target === e2.id)).toBe(true)
    expect(u2.associations.some(a => a.type === 'co_accessed' && a.target === e1.id)).toBe(true)
  })

  it('co-access associations cap at 5 per engram', () => {
    const ids: string[] = []
    for (let i = 0; i < 7; i++) {
      const e = plur.learn(`Testing pattern ${i} for validation purposes`, { scope: 'global' })
      ids.push(e.id)
    }
    plur.recall('testing pattern validation')
    const all = plur.list()
    for (const e of all) {
      const coAccess = e.associations.filter(a => a.type === 'co_accessed')
      expect(coAccess.length).toBeLessThanOrEqual(5)
    }
  })

  it('co-access strength caps at 0.95', () => {
    const e1 = plur.learn('Nginx reverse proxy configuration', { scope: 'global' })
    const e2 = plur.learn('Nginx load balancing setup', { scope: 'global' })
    // Recall many times to bump strength repeatedly
    for (let i = 0; i < 20; i++) {
      plur.recall('Nginx proxy load balancing')
    }
    const all = plur.list()
    const updated1 = all.find(e => e.id === e1.id)!
    const coAccess = updated1.associations.filter(a => a.type === 'co_accessed')
    expect(coAccess.length).toBeGreaterThan(0)
    expect(coAccess[0].strength).toBeLessThanOrEqual(0.95)
  })

  it('co-access disabled when config.injection.co_access is false', () => {
    writeFileSync(join(dir, 'config.yaml'), 'injection:\n  co_access: false\n')
    const noCoAccessPlur = new Plur({ path: dir })
    noCoAccessPlur.learn('TypeScript strict mode enabled', { scope: 'global' })
    noCoAccessPlur.learn('TypeScript compiler configuration', { scope: 'global' })
    noCoAccessPlur.recall('TypeScript strict compiler')
    const all = noCoAccessPlur.list()
    for (const e of all) {
      const coAccess = e.associations.filter(a => a.type === 'co_accessed')
      expect(coAccess.length).toBe(0)
    }
  })

  it('compact removes retired engrams from storage', async () => {
    plur.learn('Keep this one', { scope: 'global' })
    const toRetire = plur.learn('Remove this one', { scope: 'global' })
    await plur.forget(toRetire.id, 'test cleanup')
    const result = plur.compact()
    expect(result.removed).toBe(1)
    expect(result.remaining).toBe(1)
    const all = plur.list()
    expect(all).toHaveLength(1)
    expect(all[0].statement).toBe('Keep this one')
  })

  it('compact returns zero when nothing to remove', () => {
    plur.learn('Active engram', { scope: 'global' })
    const result = plur.compact()
    expect(result.removed).toBe(0)
    expect(result.remaining).toBe(1)
  })

  it('compact works on empty store', () => {
    const result = plur.compact()
    expect(result.removed).toBe(0)
    expect(result.remaining).toBe(0)
  })

  it('co-access only applies to top half of results', () => {
    const strong1 = plur.learn('Kubernetes orchestration for containers', { scope: 'global' })
    const strong2 = plur.learn('Kubernetes cluster scaling rules', { scope: 'global' })
    const weak = plur.learn('Container image builds slowly', { scope: 'global' })
    const results = plur.recall('kubernetes cluster orchestration')
    expect(results.length).toBeGreaterThanOrEqual(2)
    const all = plur.list()
    const updatedStrong1 = all.find(e => e.id === strong1.id)!
    const coAccess = updatedStrong1.associations.filter(a => a.type === 'co_accessed')
    expect(coAccess.length).toBeGreaterThan(0)
    expect(coAccess.some(a => a.target === strong2.id)).toBe(true)
  })

  // --- Step 6: New tests for Datacore migration prerequisites ---

  it('learn passes tags, knowledge_anchors, dual_coding, rationale, visibility, abstract, derived_from', () => {
    const engram = plur.learn('Always validate inputs before processing', {
      type: 'behavioral',
      scope: 'project:api',
      domain: 'validation',
      tags: ['security', 'input-validation'],
      rationale: 'Prevents injection attacks',
      visibility: 'public',
      knowledge_anchors: [{ path: '/docs/security.md', relevance: 'primary', snippet: 'All inputs must be validated' }],
      dual_coding: { example: 'zod.parse(input)', analogy: 'Like a bouncer checking IDs' },
      abstract: 'ABS-validation-001',
      derived_from: 'ENG-2026-0101-001',
    })
    expect(engram.tags).toEqual(['security', 'input-validation'])
    expect(engram.rationale).toBe('Prevents injection attacks')
    expect(engram.visibility).toBe('public')
    expect(engram.knowledge_anchors).toHaveLength(1)
    expect(engram.knowledge_anchors[0].path).toBe('/docs/security.md')
    expect(engram.knowledge_anchors[0].relevance).toBe('primary')
    expect(engram.dual_coding?.example).toBe('zod.parse(input)')
    expect(engram.dual_coding?.analogy).toBe('Like a bouncer checking IDs')
    expect(engram.abstract).toBe('ABS-validation-001')
    expect(engram.derived_from).toBe('ENG-2026-0101-001')
  })

  it('learn defaults to empty tags/anchors and private visibility when not provided', () => {
    const engram = plur.learn('Simple statement', { scope: 'global' })
    expect(engram.tags).toEqual([])
    expect(engram.knowledge_anchors).toEqual([])
    expect(engram.visibility).toBe('private')
    expect(engram.abstract).toBeNull()
    expect(engram.derived_from).toBeNull()
  })

  it('inject returns injected_ids array', () => {
    plur.learn('Always use blue-green deploy strategies', { scope: 'global' })
    plur.learn('Database for myapp is PostgreSQL', { scope: 'project:myapp' })
    const result = plur.inject('deploy myapp database', { budget: 500, scope: 'project:myapp' })
    expect(Array.isArray(result.injected_ids)).toBe(true)
    expect(result.injected_ids.length).toBe(result.count)
    for (const id of result.injected_ids) {
      expect(id).toMatch(/^ENG-/)
    }
  })

  it('inject returns empty injected_ids when no engrams match', () => {
    const result = plur.inject('completely unrelated topic xyz123')
    expect(result.injected_ids).toEqual([])
  })

  it('getById finds active engrams', () => {
    const engram = plur.learn('Test getById active', { scope: 'global' })
    const found = plur.getById(engram.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(engram.id)
    expect(found!.statement).toBe('Test getById active')
    expect(found!.status).toBe('active')
  })

  it('getById finds retired engrams', async () => {
    const engram = plur.learn('Will be retired', { scope: 'global' })
    await plur.forget(engram.id, 'test')
    const found = plur.getById(engram.id)
    expect(found).not.toBeNull()
    expect(found!.status).toBe('retired')
  })

  it('getById returns null for missing id', () => {
    const found = plur.getById('ENG-9999-0101-999')
    expect(found).toBeNull()
  })

  it('feedback works on pack engrams', async () => {
    // Create a temp pack directory with engrams
    const packsDir = join(dir, 'packs')
    mkdirSync(packsDir, { recursive: true })
    const packDir = join(packsDir, 'test-feedback-pack')
    mkdirSync(packDir)
    writeFileSync(join(packDir, 'SKILL.md'), '---\nname: test-feedback-pack\nversion: "1.0"\nx-datacore:\n  id: test-feedback-pack\n  injection_policy: on_match\n  engram_count: 1\n---\n')
    writeFileSync(join(packDir, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0101-001
    statement: "Pack engram for feedback test"
    type: behavioral
    scope: global
    status: active
    version: 2
    consolidated: false
    visibility: private
    derivation_count: 1
    pack: test-feedback-pack
    abstract: null
    derived_from: null
    polarity: null
    tags: []
    knowledge_anchors: []
    associations: []
    activation:
      retrieval_strength: 0.7
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-01-01"
    feedback_signals:
      positive: 0
      negative: 0
      neutral: 0
`)

    // Re-create Plur instance so it picks up the pack
    const plurWithPacks = new Plur({ path: dir })
    await plurWithPacks.feedback('ENG-2026-0101-001', 'positive')

    // Verify the feedback was written to the pack engrams.yaml
    const raw = yaml.load(readFileSync(join(packDir, 'engrams.yaml'), 'utf8')) as any
    const updated = raw.engrams.find((e: any) => e.id === 'ENG-2026-0101-001')
    expect(updated.feedback_signals.positive).toBe(1)
    expect(updated.activation.retrieval_strength).toBe(0.75)
  })

  it('feedback on pack engram throws for unknown id', async () => {
    await expect(plur.feedback('ENG-9999-01-001', 'positive')).rejects.toThrow('Engram not found')
  })
})
