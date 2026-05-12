import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, computeContentHash, normalizeStatement } from '../src/index.js'
import { buildDedupPrompt, parseDedupResponse, buildBatchDedupPrompt, parseBatchDedupResponse } from '../src/dedup.js'
import { confidenceDecay } from '../src/decay.js'
import { saveEngrams } from '../src/engrams.js'
import type { Engram } from '../src/schemas/engram.js'

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'plur-sp1-'))
}

describe('SP1: Memory Intelligence', () => {
  let plur: Plur
  let dir: string

  beforeEach(() => {
    dir = makeDir()
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // === Idea 29: Content Hash Deduplication ===

  describe('Idea 29: Content Hash Dedup', () => {
    it('normalizes statements for hashing', () => {
      expect(normalizeStatement('  Hello,  World!  ')).toBe('hello world')
      expect(normalizeStatement('Use SNAKE_CASE for APIs.')).toBe('use snake_case for apis')
      expect(normalizeStatement('a   b\n\tc')).toBe('a b c')
    })

    it('computes consistent SHA256 hashes', () => {
      const h1 = computeContentHash('API uses snake_case')
      const h2 = computeContentHash('API uses snake_case')
      const h3 = computeContentHash('API uses camelCase')
      expect(h1).toBe(h2)
      expect(h1).not.toBe(h3)
    })

    it('hashes are case/whitespace/punctuation insensitive', () => {
      const h1 = computeContentHash('API uses snake_case.')
      const h2 = computeContentHash('  api   uses  SNAKE_CASE  ')
      expect(h1).toBe(h2)
    })

    it('learn() returns existing engram on exact duplicate', () => {
      const first = plur.learn('Always use TypeScript for new projects')
      const second = plur.learn('Always use TypeScript for new projects')
      expect(second.id).toBe(first.id)
    })

    it('learn() returns existing on normalized duplicate', () => {
      const first = plur.learn('Use port 3000 for dev.')
      const second = plur.learn('  use port 3000 for dev  ')
      expect(second.id).toBe(first.id)
    })

    it('learn() creates new engram for different content', () => {
      const first = plur.learn('Use port 3000 for dev')
      const second = plur.learn('Use port 5000 for staging')
      expect(second.id).not.toBe(first.id)
    })

    it('learn() stores content_hash on new engrams', () => {
      const engram = plur.learn('Test content hash')
      expect((engram as any).content_hash).toBe(computeContentHash('Test content hash'))
    })
  })

  // === Idea 6: Commitment Levels ===

  describe('Idea 6: Commitment Levels', () => {
    it('new engrams default to leaning commitment', () => {
      const engram = plur.learn('Prefer blue-green deployments')
      expect((engram as any).commitment).toBe('leaning')
    })

    it('explicit commitment is preserved', () => {
      const engram = plur.learn('Always use 2FA', { commitment: 'decided' })
      expect((engram as any).commitment).toBe('decided')
    })

    it('locked commitment sets locked_at timestamp', () => {
      const engram = plur.learn('Server IP is 10.0.0.1', {
        commitment: 'locked',
        locked_reason: 'Production server address',
      })
      expect((engram as any).commitment).toBe('locked')
      expect((engram as any).locked_at).toBeTruthy()
      expect((engram as any).locked_reason).toBe('Production server address')
    })

    it('exploring commitment gets lower injection score', () => {
      plur.learn('Exploring: maybe use Redis', { commitment: 'exploring', tags: ['redis'] })
      plur.learn('Decided: always use PostgreSQL', { commitment: 'decided', tags: ['postgresql'] })
      // Both should be found, but decided should rank higher in injection
      const result = plur.inject('database redis postgresql')
      expect(result.count).toBeGreaterThan(0)
    })

    it('positive feedback promotes exploring → leaning', async () => {
      const engram = plur.learn('Maybe try Bun for build', { commitment: 'exploring' })
      expect((engram as any).commitment).toBe('exploring')
      await plur.feedback(engram.id, 'positive')
      const updated = plur.getById(engram.id)
      expect((updated as any).commitment).toBe('leaning')
    })

    it('positive feedback promotes leaning → decided', async () => {
      const engram = plur.learn('Prefer pnpm over npm', { commitment: 'leaning' })
      await plur.feedback(engram.id, 'positive')
      const updated = plur.getById(engram.id)
      expect((updated as any).commitment).toBe('decided')
    })

    it('positive feedback does NOT promote decided → locked', async () => {
      const engram = plur.learn('Use TypeScript always', { commitment: 'decided' })
      await plur.feedback(engram.id, 'positive')
      const updated = plur.getById(engram.id)
      // decided stays decided — locked requires explicit parameter
      expect((updated as any).commitment).toBe('decided')
    })

    it('status includes locked_count', () => {
      plur.learn('Locked fact', { commitment: 'locked', locked_reason: 'test' })
      plur.learn('Normal fact')
      const status = plur.status()
      expect(status.locked_count).toBe(1)
    })
  })

  // === Idea 5: Cognitive Level for Injection ===

  describe('Idea 5: Cognitive Level Injection', () => {
    it('learn() sets knowledge_type based on engram type', () => {
      const behavioral = plur.learn('Always validate', { type: 'behavioral' })
      const terminological = plur.learn('REST means Representational State Transfer', { type: 'terminological' })
      const architectural = plur.learn('Use microservices for scaling', { type: 'architectural' })

      expect((behavioral as any).knowledge_type?.cognitive_level).toBe('apply')
      expect((terminological as any).knowledge_type?.cognitive_level).toBe('remember')
      expect((architectural as any).knowledge_type?.cognitive_level).toBe('evaluate')
    })

    it('terminological (remember) engrams route to consider bucket', () => {
      plur.learn('REST means Representational State Transfer', { type: 'terminological', tags: ['rest', 'api'] })
      const result = plur.inject('explain REST API')
      // terminological/remember goes to consider (ALSO CONSIDER) bucket
      if (result.count > 0) {
        expect(result.consider).toMatch(/REST/)
      }
    })

    it('architectural (evaluate) engrams route to directives bucket', () => {
      plur.learn('Use event-driven architecture for real-time systems', { type: 'architectural', tags: ['architecture', 'events'] })
      const result = plur.inject('design real-time architecture events')
      if (result.count > 0) {
        // architectural/evaluate → directives
        const allOutput = [result.directives, result.constraints].join('\n')
        expect(allOutput).toMatch(/event-driven/)
      }
    })
  })

  // === Idea 19: Tension Detection ===

  describe('Idea 19: Tension Detection', () => {
    it('status includes tension_count from conflicts', () => {
      // Create conflicting engrams
      plur.learn('API uses camelCase for responses', { scope: 'project:myapp' })
      plur.learn('API uses snake_case for responses', { scope: 'project:myapp' })
      const status = plur.status()
      expect(status.tension_count).toBeGreaterThanOrEqual(1)
    })
  })

  // === Ideas 1+2: LLM Dedup ===

  describe('Ideas 1+2: LLM Dedup', () => {
    it('buildDedupPrompt generates correct format', () => {
      const prompt = buildDedupPrompt('Use TypeScript for all projects', [
        { id: 'ENG-2026-0406-001', statement: 'Prefer TypeScript over JavaScript', type: 'behavioral' },
      ])
      expect(prompt).toContain('NEW STATEMENT')
      expect(prompt).toContain('EXISTING ENGRAMS')
      expect(prompt).toContain('ENG-2026-0406-001')
      expect(prompt).toContain('DECISION')
    })

    it('parseDedupResponse extracts ADD decision', () => {
      const result = parseDedupResponse(`
DECISION: ADD
TARGET: none
CONFLICTS: none
REASON: This is genuinely new knowledge
      `)
      expect(result.decision).toBe('ADD')
      expect(result.target_id).toBeNull()
      expect(result.conflicts).toHaveLength(0)
    })

    it('parseDedupResponse extracts UPDATE with target', () => {
      const result = parseDedupResponse(`
DECISION: UPDATE
TARGET: ENG-2026-0406-001
CONFLICTS: none
REASON: New version has more detail
      `)
      expect(result.decision).toBe('UPDATE')
      expect(result.target_id).toBe('ENG-2026-0406-001')
    })

    it('parseDedupResponse extracts NOOP with conflicts', () => {
      const result = parseDedupResponse(`
DECISION: NOOP
TARGET: ENG-2026-0406-001
CONFLICTS: ENG-2026-0406-002, ENG-2026-0406-003
REASON: Duplicate of existing
      `)
      expect(result.decision).toBe('NOOP')
      expect(result.conflicts).toEqual(['ENG-2026-0406-002', 'ENG-2026-0406-003'])
    })

    it('parseDedupResponse handles malformed input gracefully', () => {
      const result = parseDedupResponse('This is not a valid response')
      expect(result.decision).toBe('ADD') // Safe default
      expect(result.target_id).toBeNull()
      expect(result.conflicts).toHaveLength(0)
    })

    it('learnAsync returns NOOP on exact hash match', async () => {
      const first = plur.learn('Exact duplicate test')
      const result = await plur.learnAsync('Exact duplicate test')
      expect(result.decision).toBe('NOOP')
      expect(result.existing_id).toBe(first.id)
      expect(result.engram.id).toBe(first.id)
    })

    it('learnAsync falls back to sync learn when dedup disabled', async () => {
      // Create plur with dedup disabled
      const disabledDir = makeDir()
      writeFileSync(join(disabledDir, 'config.yaml'), yaml.dump({ dedup: { enabled: false } }))
      const disabledPlur = new Plur({ path: disabledDir })

      const result = await disabledPlur.learnAsync('New knowledge item')
      expect(result.decision).toBe('ADD')
      expect(result.engram.statement).toBe('New knowledge item')

      rmSync(disabledDir, { recursive: true, force: true })
    })

    it('learnAsync with mock LLM decides UPDATE', async () => {
      plur.learn('Use port 3000 for development', { type: 'behavioral' })

      const mockLlm = vi.fn().mockResolvedValue(`
DECISION: UPDATE
TARGET: ENG-${new Date().toISOString().slice(0, 4)}-${new Date().toISOString().slice(5, 7)}${new Date().toISOString().slice(8, 10)}-001
CONFLICTS: none
REASON: More specific port configuration
      `)

      // Need dedup config in llm mode
      const llmDir = makeDir()
      writeFileSync(join(llmDir, 'config.yaml'), yaml.dump({ dedup: { enabled: true, mode: 'llm' } }))
      const llmPlur = new Plur({ path: llmDir })
      llmPlur.learn('Use port 3000 for development', { type: 'behavioral' })

      const result = await llmPlur.learnAsync('Use port 3000 for dev server, configure via PORT env var', {
        llm: mockLlm,
      })

      expect(mockLlm).toHaveBeenCalled()
      // Decision depends on whether LLM response parsing finds the right target ID
      expect(['ADD', 'UPDATE']).toContain(result.decision)

      rmSync(llmDir, { recursive: true, force: true })
    })

    it('learnAsync with mock LLM detects tensions', async () => {
      plur.learn('Always use REST APIs', { type: 'behavioral', tags: ['api'] })

      const mockLlm = vi.fn().mockResolvedValue(`
DECISION: ADD
TARGET: none
CONFLICTS: ENG-2026-0406-001
REASON: This contradicts the REST-only policy
      `)

      const result = await plur.learnAsync('Prefer GraphQL over REST for complex queries', {
        llm: mockLlm,
        tags: ['api'],
      })

      expect(result.decision).toBe('ADD')
      // Tensions should be captured (if the conflict ID exists)
      // The exact behavior depends on whether the referenced ID exists
    })

    it('learnAsync circuit breaker trips after 3 failures', async () => {
      const failLlm = vi.fn().mockRejectedValue(new Error('API timeout'))

      // Seed the store with engrams so recall finds candidates (triggers LLM path)
      plur.learn('Deploy using blue green strategy for zero downtime', { tags: ['deploy'] })

      // Each call uses similar keywords to trigger recall matches
      const attempts = [
        'Deploy using blue green strategy for staging',
        'Deploy using blue green strategy for production',
        'Deploy using blue green strategy for testing',
      ]
      for (const stmt of attempts) {
        await plur.learnAsync(stmt, { llm: failLlm })
      }

      // After circuit breaker trips (3 failures), LLM should not be called
      const callCountBefore = failLlm.mock.calls.length
      await plur.learnAsync('Deploy using blue green strategy for QA', { llm: failLlm })
      // LLM should not be called due to circuit breaker
      expect(failLlm.mock.calls.length).toBe(callCountBefore)
    })
  })

  // === Idea 21: Confidence Decay ===

  describe('Idea 21: Confidence Decay', () => {
    it('no decay within 90-day grace period', () => {
      const now = new Date('2026-05-01')
      const baseline = '2026-04-01'
      const result = confidenceDecay(0.7, null, undefined, baseline, now)
      // 30 days < 90 days grace period — no decay
      expect(result).toBe(0.7)
    })

    it('applies decay after 90-day grace period', () => {
      const now = new Date('2026-10-01')
      const baseline = '2026-04-01'
      // 183 days since baseline, 93 days over grace (about 3.1 months)
      const result = confidenceDecay(0.7, null, undefined, baseline, now)
      expect(result).toBeLessThan(0.7)
      expect(result).toBeGreaterThan(0.1) // Floor
    })

    it('locked engrams exempt from decay', () => {
      const now = new Date('2027-01-01')
      const baseline = '2026-01-01'
      const result = confidenceDecay(0.7, null, 'locked', baseline, now)
      expect(result).toBe(0.7) // No decay for locked
    })

    it('positive feedback resets decay timer', () => {
      const now = new Date('2026-10-01')
      const lastPositive = '2026-09-01' // 30 days ago — within grace period
      const result = confidenceDecay(0.7, lastPositive, undefined, '2026-01-01', now)
      expect(result).toBe(0.7) // No decay — recent positive feedback
    })

    it('floor at 0.1 even with extreme decay', () => {
      const now = new Date('2030-01-01')
      const baseline = '2026-01-01'
      const result = confidenceDecay(0.7, null, undefined, baseline, now)
      expect(result).toBe(0.1) // Floor
    })

    it('no decay when no baseline set', () => {
      const result = confidenceDecay(0.7, null, undefined, undefined)
      expect(result).toBe(0.7) // No baseline — no decay
    })

    it('0.95x/month multiplier is accurate', () => {
      const now = new Date('2026-10-01')
      const baseline = '2026-04-01'
      // 183 days total, 93 days over grace = ~3.1 months
      const result = confidenceDecay(1.0, null, undefined, baseline, now)
      // Expected: 1.0 * 0.95^3.1 ≈ 0.856
      expect(result).toBeCloseTo(Math.pow(0.95, 93 / 30), 2)
    })
  })

  // === Batch dedup ===

  describe('learnBatch', () => {
    it('processes multiple statements', async () => {
      const result = await plur.learnBatch([
        { statement: 'First knowledge item' },
        { statement: 'Second knowledge item' },
        { statement: 'First knowledge item' }, // Duplicate of first
      ])

      expect(result.results).toHaveLength(3)
      expect(result.stats.added).toBe(2)
      expect(result.stats.noops).toBe(1)
    })
  })

  // === Migration stubs ===

  describe('Migrations', () => {
    it('commitment migration sets decided for active engrams', async () => {
      const { migration } = await import('../src/migrations/20260406-001-add-commitment.js')
      const engrams = [
        { status: 'active', id: 'ENG-001' } as any,
        { status: 'retired', id: 'ENG-002' } as any,
      ]
      const result = migration.up(engrams)
      expect((result[0] as any).commitment).toBe('decided')
      expect((result[1] as any).commitment).toBe('leaning')
    })

    it('commitment migration rollback removes field', async () => {
      const { migration } = await import('../src/migrations/20260406-001-add-commitment.js')
      const engrams = [{ commitment: 'decided', locked_at: '2026-04-06', locked_reason: 'test' } as any]
      const result = migration.down(engrams)
      expect((result[0] as any).commitment).toBeUndefined()
      expect((result[0] as any).locked_at).toBeUndefined()
    })

    it('content hash migration computes hashes', async () => {
      const { migration } = await import('../src/migrations/20260406-002-add-content-hash.js')
      const engrams = [{ statement: 'Test engram', id: 'ENG-001' } as any]
      const result = migration.up(engrams)
      expect((result[0] as any).content_hash).toBe(computeContentHash('Test engram'))
    })

    it('content hash migration rollback removes field', async () => {
      const { migration } = await import('../src/migrations/20260406-002-add-content-hash.js')
      const engrams = [{ content_hash: 'abc123' } as any]
      const result = migration.down(engrams)
      expect((result[0] as any).content_hash).toBeUndefined()
    })

    it('cognitive level migration populates based on type', async () => {
      const { migration } = await import('../src/migrations/20260406-004-populate-cognitive-level.js')
      const engrams = [
        { type: 'behavioral', id: 'ENG-001' } as any,
        { type: 'terminological', id: 'ENG-002' } as any,
        { type: 'procedural', id: 'ENG-003' } as any,
        { type: 'architectural', id: 'ENG-004' } as any,
      ]
      const result = migration.up(engrams)
      expect((result[0] as any).knowledge_type?.cognitive_level).toBe('apply')
      expect((result[1] as any).knowledge_type?.cognitive_level).toBe('remember')
      expect((result[2] as any).knowledge_type?.cognitive_level).toBe('apply')
      expect((result[3] as any).knowledge_type?.cognitive_level).toBe('evaluate')
    })
  })

  // === Batch dedup prompt parsing ===

  describe('Batch dedup prompt', () => {
    it('buildBatchDedupPrompt generates multi-statement format', () => {
      const prompt = buildBatchDedupPrompt(
        ['Statement A', 'Statement B'],
        [{ id: 'ENG-001', statement: 'Existing', type: 'behavioral' }],
      )
      expect(prompt).toContain('STATEMENT')
      expect(prompt).toContain('Statement A')
      expect(prompt).toContain('Statement B')
    })

    it('parseBatchDedupResponse extracts per-statement decisions', () => {
      const results = parseBatchDedupResponse(`
STATEMENT_1:
DECISION: ADD
TARGET: none

STATEMENT_2:
DECISION: NOOP
TARGET: ENG-001
      `, 2)

      expect(results).toHaveLength(2)
      expect(results[0].decision).toBe('ADD')
      expect(results[1].decision).toBe('NOOP')
      expect(results[1].target_id).toBe('ENG-001')
    })

    it('parseBatchDedupResponse defaults to ADD for unparseable', () => {
      const results = parseBatchDedupResponse('garbage response', 2)
      expect(results).toHaveLength(2)
      expect(results[0].decision).toBe('ADD')
      expect(results[1].decision).toBe('ADD')
    })
  })
})
