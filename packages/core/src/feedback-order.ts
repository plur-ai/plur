import type { Engram } from './schemas/engram.js'

/**
 * The multiplier feedback puts on a ranking score: up to ×1.3 for net
 * positive feedback (+0.05 each), down to ×0.5 for net negative (−0.1 each).
 * Shared by the legacy scorer and recall's ranking.
 */
export function feedbackFactor(engram: Pick<Engram, 'feedback_signals'>): number {
  const fb = engram.feedback_signals
  if (!fb) return 1
  const net = fb.positive - fb.negative
  if (net > 0) return 1 + Math.min(net * 0.05, 0.3)
  if (net < 0) return Math.max(1 + net * 0.1, 0.5)
  return 1
}

/**
 * Feedback applied to a finished ranking: each item's place is turned into an
 * RRF-style score (1 / (60 + rank)), multiplied by its feedback factor, and
 * re-sorted. Working on places rather than raw scores keeps a reranked order
 * comparable and bounds feedback to a nudge: ×1.3 lifts an item a few places,
 * never past a much stronger match. With no feedback on any item the order is
 * returned unchanged (same array).
 */
export function applyFeedbackOrder<T>(ranked: T[], engramOf: (item: T) => Pick<Engram, 'feedback_signals'>): T[] {
  if (!ranked.some(r => feedbackFactor(engramOf(r)) !== 1)) return ranked
  const key = new Map(ranked.map((r, i) => [r, feedbackFactor(engramOf(r)) / (60 + i + 1)]))
  return [...ranked].sort((a, b) => key.get(b)! - key.get(a)!)
}
