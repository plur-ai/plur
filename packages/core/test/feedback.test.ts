/**
 * The feedback mutation, as a unit.
 *
 * It existed as three hand-written copies inside `Plur.feedback` — primary
 * store, secondary stores, packs — and they had drifted: only the primary copy
 * promoted `commitment`. These tests exist mainly so that cannot happen again,
 * which is why several of them assert arithmetic that looks too simple to test.
 * The bug was never that the arithmetic was hard; it was that there were three
 * of it.
 */
import { describe, it, expect } from 'vitest'
import {
  applyFeedbackSignal, nextCommitment,
  POSITIVE_STRENGTH_DELTA, NEGATIVE_STRENGTH_DELTA,
} from '../src/feedback.js'
import type { Engram } from '../src/schemas/engram.js'

// `commitment` is widened to `string` on purpose: these tests cover values
// outside core's enum (a deployment may add `draft`), and `Partial<Engram>`
// would narrow it straight back to the enum.
const mk = (over: Omit<Partial<Engram>, 'commitment'> & { commitment?: string } = {}): Engram & { commitment?: string } => ({
  id: 'ENG-2026-0729-001',
  statement: 'a statement',
  type: 'behavioral',
  scope: 'global',
  status: 'active',
  activation: { retrieval_strength: 0.5, storage_strength: 1, frequency: 0, last_accessed: '2026-01-01' },
  created: '2026-01-01',
  ...over,
} as never)

describe('nextCommitment', () => {
  it('advances one step toward decided', () => {
    expect(nextCommitment('exploring')).toBe('leaning')
    expect(nextCommitment('leaning')).toBe('decided')
  })

  it('stops at decided and never reaches locked', () => {
    // Locking is a human act. No quantity of positive feedback substitutes.
    expect(nextCommitment('decided')).toBe('decided')
    expect(nextCommitment('locked')).toBe('locked')
  })

  it('seeds an unset commitment at leaning', () => {
    expect(nextCommitment(undefined)).toBe('leaning')
  })

  it('leaves an unrecognised commitment alone', () => {
    // A deployment may extend the enum — `draft` stages an engram in a review
    // queue. Promoting it here would publish unreviewed content on a thumbs-up.
    expect(nextCommitment('draft')).toBe('draft')
    expect(nextCommitment('something-else')).toBe('something-else')
  })
})

describe('applyFeedbackSignal', () => {
  it('counts the signal', () => {
    const e = mk()
    applyFeedbackSignal(e, 'positive', '2026-07-29')
    applyFeedbackSignal(e, 'positive', '2026-07-29')
    applyFeedbackSignal(e, 'negative', '2026-07-29')
    applyFeedbackSignal(e, 'neutral', '2026-07-29')
    expect(e.feedback_signals).toEqual({ positive: 2, negative: 1, neutral: 1 })
  })

  it('initialises counters when the engram has none', () => {
    const e = mk()
    delete (e as { feedback_signals?: unknown }).feedback_signals
    applyFeedbackSignal(e, 'neutral', '2026-07-29')
    expect(e.feedback_signals).toEqual({ positive: 0, negative: 0, neutral: 1 })
  })

  it('moves strength by the documented deltas', () => {
    const up = mk({ activation: { retrieval_strength: 0.5, storage_strength: 1, frequency: 0, last_accessed: '2026-01-01' } })
    applyFeedbackSignal(up, 'positive', '2026-07-29')
    expect(up.activation.retrieval_strength).toBeCloseTo(0.5 + POSITIVE_STRENGTH_DELTA, 10)

    const down = mk({ activation: { retrieval_strength: 0.5, storage_strength: 1, frequency: 0, last_accessed: '2026-01-01' } })
    applyFeedbackSignal(down, 'negative', '2026-07-29')
    expect(down.activation.retrieval_strength).toBeCloseTo(0.5 - NEGATIVE_STRENGTH_DELTA, 10)
  })

  it('clamps to [0, 1]', () => {
    const hi = mk({ activation: { retrieval_strength: 0.99, storage_strength: 1, frequency: 0, last_accessed: '2026-01-01' } })
    applyFeedbackSignal(hi, 'positive', '2026-07-29')
    expect(hi.activation.retrieval_strength).toBe(1)

    const lo = mk({ activation: { retrieval_strength: 0.05, storage_strength: 1, frequency: 0, last_accessed: '2026-01-01' } })
    applyFeedbackSignal(lo, 'negative', '2026-07-29')
    expect(lo.activation.retrieval_strength).toBe(0)
  })

  it('leaves strength untouched on neutral', () => {
    const e = mk()
    applyFeedbackSignal(e, 'neutral', '2026-07-29')
    expect(e.activation.retrieval_strength).toBe(0.5)
  })

  it('re-anchors last_accessed when it changed strength, and not otherwise', () => {
    // Read-time decay is measured from last_accessed, so a strength bump that
    // does not move the anchor is swallowed on the next read. Neutral changes
    // no strength, so advancing the anchor would make "no opinion" a liveness
    // ping and keep a dying engram alive.
    const pos = mk()
    applyFeedbackSignal(pos, 'positive', '2026-07-29')
    expect(pos.activation.last_accessed).toBe('2026-07-29')

    const neg = mk()
    applyFeedbackSignal(neg, 'negative', '2026-07-29')
    expect(neg.activation.last_accessed).toBe('2026-07-29')

    const neu = mk()
    applyFeedbackSignal(neu, 'neutral', '2026-07-29')
    expect(neu.activation.last_accessed).toBe('2026-01-01')
  })

  it('promotes commitment on positive only', () => {
    const pos = mk({ commitment: 'exploring' })
    applyFeedbackSignal(pos, 'positive', '2026-07-29')
    expect(pos.commitment).toBe('leaning')

    for (const signal of ['negative', 'neutral'] as const) {
      const e = mk({ commitment: 'exploring' })
      applyFeedbackSignal(e, signal, '2026-07-29')
      expect(e.commitment, `${signal} must not promote`).toBe('exploring')
    }
  })

  it('does not promote a review-queue draft out of review', () => {
    const e = mk({ commitment: 'draft' })
    applyFeedbackSignal(e, 'positive', '2026-07-29')
    expect(e.commitment, 'a thumbs-up must not publish unreviewed content').toBe('draft')
    // The rest of the signal still applies — it is staged, not ignored.
    expect(e.feedback_signals?.positive).toBe(1)
    expect(e.activation.retrieval_strength).toBeCloseTo(0.55, 10)
  })
})
