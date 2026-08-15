/**
 * Tests for the `measured_under` field on engrams (#869).
 *
 * Two motivating incidents:
 *   - max_tokens 16384 from a bench run asserted for operation context (needed 64k)
 *   - 87% wall-clock from local-git asserted as a general ratio (inverts on GitLab)
 *
 * Both had the same shape: evidence gathered under configuration A, asserted
 * for configuration B, with the difference invisible in the stored artifact.
 *
 * `measured_under` makes the measurement context explicit so:
 *   - Callers can see the conditions attached to numeric claims
 *   - Tension-aware retrieval (#203) can store differing-condition measurements
 *     as refinements rather than contradictions
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { EngramSchema, MeasuredUnderSchema } from '../src/schemas/engram.js'

// ── Schema validation ────────────────────────────────────────────────────────

describe('MeasuredUnderSchema', () => {
  it('accepts a fully populated object', () => {
    const result = MeasuredUnderSchema.safeParse({
      model: 'claude-opus-4',
      source_type: 'bench',
      hardware: 'M3-Pro-36GB',
      dataset: 'LongMemEval-S',
      date: '2026-08-11',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.model).toBe('claude-opus-4')
      expect(result.data.source_type).toBe('bench')
      expect(result.data.date).toBe('2026-08-11')
    }
  })

  it('accepts a partial object — all sub-fields are optional', () => {
    expect(MeasuredUnderSchema.safeParse({ source_type: 'local-git' }).success).toBe(true)
    expect(MeasuredUnderSchema.safeParse({}).success).toBe(true)
  })

  it('passes through unknown keys for forward compatibility', () => {
    const result = MeasuredUnderSchema.safeParse({ model: 'gpt-4o', future_field: 'ok' })
    expect(result.success).toBe(true)
    if (result.success) expect((result.data as any).future_field).toBe('ok')
  })
})

describe('EngramSchema with measured_under', () => {
  it('parses an engram with measured_under present', () => {
    const engram = EngramSchema.parse({
      id: 'ENG-2026-08-11-001',
      statement: 'max_tokens 16384 causes timeouts on 64k operations',
      type: 'behavioral',
      scope: 'global',
      status: 'active',
      measured_under: {
        model: 'claude-opus-4',
        source_type: 'bench',
        hardware: 'M3-Pro-36GB',
        date: '2026-08-11',
      },
    })
    expect(engram.measured_under?.model).toBe('claude-opus-4')
    expect(engram.measured_under?.source_type).toBe('bench')
  })

  it('parses an engram without measured_under — field is absent, not null', () => {
    const engram = EngramSchema.parse({
      id: 'ENG-2026-08-11-002',
      statement: 'Always commit before pushing',
      type: 'behavioral',
      scope: 'global',
      status: 'active',
    })
    expect(engram.measured_under).toBeUndefined()
  })
})

// ── Plur.learn() integration ─────────────────────────────────────────────────

describe('measured_under (#869)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-measured-under-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trip: learn with measured_under, recall preserves the field', async () => {
    const mu = {
      model: 'claude-opus-4-8',
      source_type: 'bench',
      hardware: 'M3-Pro',
      dataset: 'swe-bench-verified',
      date: '2026-08-11',
      notes: 'max_tokens capped at 16384 for this run',
    }
    const engram = await plur.learn(
      'max_tokens 16384 is sufficient for bench run',
      { measured_under: mu, type: 'architectural' }
    )

    expect(engram.measured_under).toEqual(mu)

    // Reload via getById — YAML round-trip
    const reloaded = await plur.getById(engram.id)
    expect(reloaded?.measured_under).toEqual(mu)

    // Also appears in recall results
    const results = await plur.recall('max_tokens bench')
    const found = results.find(r => r.id === engram.id)
    expect(found).toBeDefined()
    expect((found as any).measured_under).toEqual(mu)
  })

  it('round-trip: partial measured_under (only some sub-fields)', async () => {
    const engram = await plur.learn(
      '87% of wall-clock on local-git runs',
      { measured_under: { source_type: 'local-git', date: '2026-08-11' } }
    )

    const reloaded = await plur.getById(engram.id)
    expect(reloaded?.measured_under?.source_type).toBe('local-git')
    expect(reloaded?.measured_under?.date).toBe('2026-08-11')
    expect(reloaded?.measured_under?.model).toBeUndefined()
  })

  it('backward compat: existing engrams without measured_under recall successfully', async () => {
    const engram = await plur.learn('Always run tests before deploying', { type: 'procedural' })
    expect(engram.measured_under).toBeUndefined()

    const reloaded = await plur.getById(engram.id)
    expect(reloaded?.measured_under).toBeUndefined()

    const results = await plur.recall('tests deploying')
    expect(results.some(r => r.id === engram.id)).toBe(true)
  })

  it('measured_under is optional — omitting it does not affect the write', async () => {
    const e1 = await plur.learn('Use TypeScript', { type: 'architectural' })
    const e2 = await plur.learn('Use Jest for tests', { type: 'procedural', measured_under: { source_type: 'bench' } })

    expect(e1.measured_under).toBeUndefined()
    expect(e2.measured_under?.source_type).toBe('bench')
  })
})
