/**
 * pinned_priority field: priority-weighted eviction for pinned budget overflow.
 *
 * When the pinned token sub-budget (50% of maxTokens) is exceeded, fillTokenBudget
 * selects pinned engrams in descending pinned_priority order so high-priority
 * (critical) engrams survive and low-priority ones are evicted first.
 *
 * Tiebreaker: the caller's relevance order (score desc). Engrams without pinned_priority treated as 50.
 * Origin outranks priority; hostile and malformed values are covered in pinned-priority-boundaries.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { fillTokenBudget, estimateTokens } from '../src/inject.js'
import type { ScoredEngram } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

// Minimal ScoredEngram factory — pinned_priority survives because EngramSchema
// uses .passthrough() at runtime; the type only captures declared fields,
// so we cast via `as any` when stamping the extra field.
const makeScored = (overrides: Partial<any> = {}): ScoredEngram => {
  const base = EngramSchema.parse({
    id: 'ENG-PP-001',
    statement: 'test engram',
    type: 'behavioral',
    scope: 'global',
    status: 'active',
    ...overrides,
  })
  // Stamp scoring fields that fillTokenBudget reads, plus any extra fields.
  return {
    ...base,
    ...(overrides.pinned !== undefined ? { pinned: overrides.pinned } : {}),
    ...(overrides.pinned_priority !== undefined ? { pinned_priority: overrides.pinned_priority } : {}),
    keyword_match: overrides.keyword_match ?? 1.0,
    raw_score: overrides.raw_score ?? 1.0,
    score: overrides.score ?? 1.0,
  } as ScoredEngram
}

// Build N pinned ScoredEngrams with a short statement so token cost is predictable.
const shortStatement = 'X'.repeat(60)

const makePinned = (id: string, priority?: number, retrievalStrength = 0.7): ScoredEngram =>
  makeScored({
    id,
    statement: shortStatement,
    pinned: true,
    ...(priority !== undefined ? { pinned_priority: priority } : {}),
    activation: {
      retrieval_strength: retrievalStrength,
      storage_strength: 0.5,
      frequency: 0,
      last_accessed: '2026-01-01',
    },
  })

describe('pinned_priority: eviction order within the pinned tier', () => {
  it('high-priority pinned engram is selected before low-priority one under budget pressure', () => {
    const high = makePinned('ENG-PP-HIGH', 90)
    const low  = makePinned('ENG-PP-LOW',  10)

    // Each engram costs ~50 tokens. Budget that fits exactly one.
    const singleCost = estimateTokens(high)
    const maxTokens = Math.floor(singleCost * 2.5) // fits 2 under outer cap, 1 under 50% sub-cap

    const { selected } = fillTokenBudget([low, high], maxTokens)

    // Only the high-priority engram should survive the sub-budget eviction.
    const ids = selected.map(e => e.id)
    expect(ids).toContain('ENG-PP-HIGH')
    expect(ids).not.toContain('ENG-PP-LOW')
  })

  it('selection order is priority desc: 100 → 80 → 50 → 20', () => {
    const p100 = makePinned('ENG-PP-100', 100)
    const p80  = makePinned('ENG-PP-080', 80)
    const p50  = makePinned('ENG-PP-050', 50)
    const p20  = makePinned('ENG-PP-020', 20)

    // Budget that fits 2 under the pinned sub-cap.
    const singleCost = estimateTokens(p100)
    const maxTokens = Math.floor(singleCost * 4.5) // outer: 4 fit; sub-cap 50%: 2 fit

    // Pass them in reverse order to prove we're sorting, not relying on input order.
    const { selected } = fillTokenBudget([p20, p50, p80, p100], maxTokens)

    const ids = selected.map(e => e.id)
    expect(ids).toContain('ENG-PP-100')
    expect(ids).toContain('ENG-PP-080')
    expect(ids).not.toContain('ENG-PP-050')
    expect(ids).not.toContain('ENG-PP-020')
  })

  it('relevance score (the pre-existing order) is the tiebreaker when priorities are equal — not retrieval_strength', () => {
    // The relevant pin has the weaker retrieval_strength; the irrelevant one
    // the stronger. Before #1121 pins kept the caller's score order, and
    // that order must survive: a field nobody set must not change who wins.
    const weakRS  = { ...makePinned('ENG-PP-WEAK',   50, 0.2), score: 9 }
    const strongRS = { ...makePinned('ENG-PP-STRONG', 50, 0.9), score: 0.5 }

    // Budget that fits exactly one pinned engram.
    const singleCost = estimateTokens(weakRS)
    const maxTokens = Math.floor(singleCost * 2.5) // outer: 2; sub-cap: 1

    const { selected } = fillTokenBudget([weakRS, strongRS], maxTokens)

    const ids = selected.map(e => e.id)
    expect(ids).toContain('ENG-PP-WEAK')
    expect(ids).not.toContain('ENG-PP-STRONG')
  })

  it('engram without pinned_priority is treated as priority 50 (neutral)', () => {
    // p90 should beat the default-50 engram; the default-50 engram should beat p10.
    const p90      = makePinned('ENG-PP-090',     90)
    const noField  = makePinned('ENG-PP-NOFIELD', undefined) // implicit 50
    const p10      = makePinned('ENG-PP-010',     10)

    const singleCost = estimateTokens(p90)
    // Budget that fits 2 under the sub-cap, so p90 and noField survive, p10 is evicted.
    const maxTokens = Math.floor(singleCost * 4.5) // outer: 4; sub-cap 50%: 2

    const { selected } = fillTokenBudget([p10, noField, p90], maxTokens)

    const ids = selected.map(e => e.id)
    expect(ids).toContain('ENG-PP-090')
    expect(ids).toContain('ENG-PP-NOFIELD')
    expect(ids).not.toContain('ENG-PP-010')
  })

  it('all pinned engrams fit when budget is sufficient (no eviction)', () => {
    const engrams = [
      makePinned('ENG-PP-A', 100),
      makePinned('ENG-PP-B', 50),
      makePinned('ENG-PP-C', 1),
    ]
    // Generous budget — all three must appear.
    const { selected, tokens_used } = fillTokenBudget(engrams, 10_000)

    expect(selected.length).toBe(3)
    expect(tokens_used).toBeGreaterThan(0)
    expect(tokens_used).toBeLessThanOrEqual(5_000) // sub-cap is 50%
  })

  it('unpinned engrams are unaffected by pinned_priority sorting', () => {
    const unpinnedA = makeScored({ id: 'ENG-UP-A', statement: shortStatement, score: 2.0 })
    const unpinnedB = makeScored({ id: 'ENG-UP-B', statement: shortStatement, score: 1.0 })
    const pinnedHigh = makePinned('ENG-PP-HIGH2', 100)

    const { selected } = fillTokenBudget([unpinnedA, unpinnedB, pinnedHigh], 10_000)

    const ids = selected.map(e => e.id)
    // All three should appear; pinned_priority does not accidentally remove unpinned ones.
    expect(ids).toContain('ENG-UP-A')
    expect(ids).toContain('ENG-UP-B')
    expect(ids).toContain('ENG-PP-HIGH2')
  })

  it('tokens_used stays within the pinned sub-budget (50% cap)', () => {
    // Same budget-cap invariant as the existing test, now with priority ordering.
    const shortStmt = 'Y'.repeat(80)
    const pinned = Array.from({ length: 20 }, (_, i) =>
      makeScored({
        id: `ENG-PP-CAP-${String(i).padStart(3, '0')}`,
        statement: shortStmt,
        pinned: true,
        pinned_priority: 100 - i, // descending so highest-index is evicted first
        keyword_match: 1.0,
        raw_score: 1.0,
        score: 1.0,
      })
    )

    const maxTokens = 600
    const { tokens_used, selected } = fillTokenBudget(pinned, maxTokens)

    expect(tokens_used).toBeLessThanOrEqual(maxTokens * 0.5)
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThan(20)

    // The survivors must all have higher priority than the evicted ones.
    const selectedIds = new Set(selected.map(e => e.id))
    const evicted = pinned.filter(e => !selectedIds.has(e.id))
    const minSelectedPriority = Math.min(
      ...selected.map(e => (e as any).pinned_priority ?? 50)
    )
    const maxEvictedPriority = Math.max(
      ...evicted.map(e => (e as any).pinned_priority ?? 50)
    )
    expect(minSelectedPriority).toBeGreaterThanOrEqual(maxEvictedPriority)
  })
})

describe('pinned_priority: schema and learn() integration', () => {
  it('EngramSchema accepts pinned_priority in [1, 100]', () => {
    const e = EngramSchema.parse({
      id: 'ENG-PP-SCH-001',
      statement: 'test',
      type: 'behavioral',
      scope: 'global',
      status: 'active',
      pinned: true,
      pinned_priority: 75,
    })
    expect((e as any).pinned_priority).toBe(75)
  })

  it('EngramSchema rejects pinned_priority outside [1, 100]', () => {
    for (const bad of [0, 101, -1]) {
      expect(() =>
        EngramSchema.parse({
          id: 'ENG-PP-SCH-002',
          statement: 'test',
          type: 'behavioral',
          scope: 'global',
          status: 'active',
          pinned: true,
          pinned_priority: bad,
        })
      ).toThrow()
    }
  })

  it('EngramSchema accepts absent pinned_priority (undefined)', () => {
    const e = EngramSchema.parse({
      id: 'ENG-PP-SCH-003',
      statement: 'test',
      type: 'behavioral',
      scope: 'global',
      status: 'active',
      pinned: true,
    })
    expect((e as any).pinned_priority).toBeUndefined()
  })

  it('learn() stores pinned_priority on the engram', async () => {
    const { Plur } = await import('../src/index.js')
    const { mkdtempSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = mkdtempSync(join(tmpdir(), 'plur-pinned-priority-'))
    try {
      const plur = new Plur({ path: dir })
      const engram = await plur.learn('Critical rule — never skip this', {
        type: 'behavioral',
        pinned: true,
        pinned_priority: 95,
      })
      expect((engram as any).pinned_priority).toBe(95)

      // Recall from disk to confirm persistence.
      const recalled = await plur.recall('critical rule never skip', { limit: 5 })
      const stored = recalled.find(e => e.id === engram.id)!
      expect((stored as any).pinned_priority).toBe(95)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('learn() clamps pinned_priority to [1, 100] at write time', async () => {
    const { Plur } = await import('../src/index.js')
    const { mkdtempSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = mkdtempSync(join(tmpdir(), 'plur-pinned-priority-clamp-'))
    try {
      const plur = new Plur({ path: dir })
      // 150 should be clamped to 100 (Math.min(100, 150)).
      const engram = await plur.learn('Over-ranged priority engram', {
        type: 'behavioral',
        pinned: true,
        pinned_priority: 150,
      })
      expect((engram as any).pinned_priority).toBe(100)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('inject() respects pinned_priority: high-priority engram survives tight budget', async () => {
    const { Plur } = await import('../src/index.js')
    const { mkdtempSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = mkdtempSync(join(tmpdir(), 'plur-pinned-priority-inject-'))
    try {
      const plur = new Plur({ path: dir })
      // Learn many bulky pinned engrams at low priority to fill the sub-budget.
      const bulkyText = 'A'.repeat(200)
      for (let i = 0; i < 8; i++) {
        await plur.learn(`Low-priority rule ${i}: ${bulkyText}`, {
          type: 'behavioral',
          pinned: true,
          pinned_priority: 10,
        })
      }
      // Then learn a critical one at the highest priority.
      const critical = await plur.learn('Critical rule — must survive any budget', {
        type: 'behavioral',
        pinned: true,
        pinned_priority: 99,
      })

      // Use a modest budget: only a few pinned engrams can fit.
      const result = await plur.inject('deploy rules', { budget: 1200 })
      expect(result.injected_ids).toContain(critical.id)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
