import type { Engram } from './schemas/engram.js'

const DECAY_RATE = 0.05
const FLOOR = 0.05
const MS_PER_DAY = 86_400_000

/** Core decay formula — exponential decay with floor. Never reaches zero. */
export function decayedStrength(
  retrievalStrength: number,
  daysSinceAccess: number,
  lambda: number = DECAY_RATE,
): number {
  return FLOOR + (retrievalStrength - FLOOR) * Math.exp(-lambda * daysSinceAccess)
}

/** Calculate days since last access from ISO date string */
export function daysSince(lastAccessed: string, now?: Date): number {
  const last = new Date(lastAccessed)
  const current = now || new Date()
  return Math.max(0, Math.floor((current.getTime() - last.getTime()) / MS_PER_DAY))
}

/** Should this engram be auto-injected into context? Scope-matched always inject. */
export function shouldInject(
  engram: { retrieval_strength: number; scope: string; last_accessed?: string },
  context: { task?: string; scope?: string },
  threshold: number = 0.15,
): boolean {
  const scope = engram.scope || 'global'
  const contextScope = context.scope || ''

  // Scope-matched engrams ALWAYS inject (ignore decay)
  if (contextScope && scope === contextScope) return true
  if (contextScope && scope !== 'global' && scope.startsWith(contextScope.split(':')[0] + ':')) return true

  // Global engrams: apply decay threshold
  const days = engram.last_accessed ? daysSince(engram.last_accessed) : 0
  const effective = decayedStrength(engram.retrieval_strength, days)
  return effective >= threshold
}

/**
 * How much a passive retrieval used to add to `retrieval_strength`.
 *
 * Exported as a named constant because it was never one, and that was half the
 * problem (#846): `POSITIVE_STRENGTH_DELTA` and `NEGATIVE_STRENGTH_DELTA` are
 * public values precisely so consumers do not re-type them, while the one
 * constant a downstream consumer needed in order to reason about what a
 * feedback delta is WORTH was an unnamed literal inside this function. PLUR
 * Enterprise hand-copied it and guarded the copy by measuring core empirically.
 *
 * @deprecated Retrieval no longer moves `retrieval_strength` — see
 * {@link reactivate}. Kept exported so a consumer that hand-copied the old
 * value can find this note.
 */
export const LEGACY_REACTIVATION_STRENGTH_DELTA = 0.1

/**
 * Reactivation on access.
 *
 * Returns the strength UNCHANGED (#846). Retrieval used to add +0.10 here while
 * a deliberate ★ added +0.05 and a ✗ subtracted 0.10 — so a rating was worth
 * half of being incidentally fetched, and a "this is wrong" was EXACTLY
 * cancelled by the next recall that happened to return the engram.
 *
 * That mattered because `retrieval_strength` reads as "how well-regarded is
 * this": it is what `min_strength` filters on, what `scoreEngram` multiplies
 * into injection ranking, and what admin surfaces present. It actually encoded
 * "how often has this been fetched" — a self-reinforcing loop in which the
 * quality term was structurally unable to outvote the traffic term, and which
 * saturated at 1.0 after three recalls, after which no feedback in either
 * direction was visible in the value at all.
 *
 * The fix is separation, not a new ratio: traffic already has a home in
 * `activation.frequency`, which counts retrieval events, works, and shows 62
 * distinct values across a real store. `retrieval_strength` now moves ONLY on
 * deliberate feedback, so the two signals stop fighting over one field and a
 * ranker can weigh them explicitly.
 *
 * Recency is unaffected: `_reactivateResults` still refreshes `last_accessed`
 * on every recall, and decay is driven by that — so a frequently-recalled
 * engram still resists decay without its strength being inflated.
 */
export function reactivate(currentStrength: number): number {
  return currentStrength
}

/** Co-access decay for associations (spreading activation) */
export function decayedCoAccessStrength(
  strength: number,
  daysSinceUpdate: number,
  lambda: number = 0.01,
): number {
  const floor = 0.02
  return floor + (strength - floor) * Math.exp(-lambda * daysSinceUpdate)
}

/**
 * Idea 21 (SP1): Confidence decay for engrams without recent positive feedback.
 * If no positive feedback in 90 days AND not locked: apply 0.95x/month multiplier.
 * Floor at 0.1. Locked engrams exempt.
 */
export function confidenceDecay(
  retrievalStrength: number,
  lastPositiveFeedbackDate: string | null,
  commitment: string | undefined,
  decayBaseline: string | undefined,
  now?: Date,
): number {
  if (commitment === 'locked') return retrievalStrength

  const CONFIDENCE_DECAY_FLOOR = 0.1
  const GRACE_PERIOD_DAYS = 90
  const MONTHLY_MULTIPLIER = 0.95

  const current = now || new Date()

  let referenceDate: Date
  if (lastPositiveFeedbackDate) {
    referenceDate = new Date(lastPositiveFeedbackDate)
  } else if (decayBaseline) {
    referenceDate = new Date(decayBaseline)
  } else {
    return retrievalStrength
  }

  const daysSinceRef = Math.max(0, Math.floor((current.getTime() - referenceDate.getTime()) / MS_PER_DAY))
  if (daysSinceRef <= GRACE_PERIOD_DAYS) return retrievalStrength

  const daysOverGrace = daysSinceRef - GRACE_PERIOD_DAYS
  const monthsOverGrace = daysOverGrace / 30
  const multiplier = Math.pow(MONTHLY_MULTIPLIER, monthsOverGrace)
  const decayed = retrievalStrength * multiplier

  return Math.max(CONFIDENCE_DECAY_FLOOR, decayed)
}

