import type { Engram } from './schemas/engram.js'
import { confidenceDecay, daysSince, decayedStrength } from './decay.js'

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
 * Feedback's pull in recall: a third of the legacy factor's distance from 1
 * (at most ×1.1 up, ×0.83 down). The full factor moved memories with positive
 * feedback past the right answers on a real store copy (one hard-set target
 * out of the top 10, 2026-11-25); the owner chose a smaller nudge.
 */
export function recallFeedbackFactor(engram: Pick<Engram, 'feedback_signals'>): number {
  return 1 + (feedbackFactor(engram) - 1) / 3
}

/**
 * Feedback applied to a finished ranking: each item's place is turned into an
 * RRF-style score (1 / (60 + rank)), multiplied by its recall feedback factor,
 * and re-sorted. Working on places rather than raw scores keeps a reranked order
 * comparable and bounds feedback to a nudge: ×1.1 lifts an item a few places,
 * never past a much stronger match. With no feedback on any item the order is
 * returned unchanged (same array).
 */
export function applyFeedbackOrder<T>(ranked: T[], engramOf: (item: T) => Pick<Engram, 'feedback_signals'>): T[] {
  if (!ranked.some(r => feedbackFactor(engramOf(r)) !== 1)) return ranked
  const key = new Map(ranked.map((r, i) => [r, recallFeedbackFactor(engramOf(r)) / (60 + i + 1)]))
  return [...ranked].sort((a, b) => key.get(b)! - key.get(a)!)
}

/**
 * A memory's strength after fading, as the legacy scorer computes it: a pack
 * row or a locked memory keeps its stored strength; any other fades with
 * disuse, plus the confidence decay for memories without recent positive
 * feedback.
 */
export function fadedStrength(engram: Engram): number {
  const isPack = (engram as { _pack?: string })._pack !== undefined
  const locked = (engram as { commitment?: string }).commitment === 'locked'
  const stored = engram.activation?.retrieval_strength ?? 1
  let rs = isPack || locked ? stored : decayedStrength(stored, daysSince(engram.activation?.last_accessed ?? ''))
  if (!isPack) {
    const fb = engram.feedback_signals
    const lastPositive = fb && fb.positive > 0 ? engram.activation?.last_accessed ?? null : null
    rs = confidenceDecay(rs, lastPositive, (engram as { commitment?: string }).commitment as never, undefined)
  }
  return rs
}

