import type { Engram } from './schemas/engram.js'

const DECAY_RATE = 0.05
const FLOOR = 0.05
const MS_PER_DAY = 86_400_000

/**
 * Core decay formula — exponential decay toward FLOOR (0.05), from above only.
 *
 * A strength above the floor decays toward it and never below it. A strength
 * AT or BELOW the floor is returned unchanged: decay never raises a strength.
 * Feedback can push a strength to 0.0, below this floor, and applying the
 * formula there would let an engram voted down to zero regain strength by
 * being left alone.
 */
export function decayedStrength(
  retrievalStrength: number,
  daysSinceAccess: number,
  lambda: number = DECAY_RATE,
): number {
  if (retrievalStrength <= FLOOR) return retrievalStrength
  return FLOOR + (retrievalStrength - FLOOR) * Math.exp(-lambda * daysSinceAccess)
}

/**
 * Calculate days since last access from ISO date string.
 *
 * An unparseable date counts as 0 days — "no known elapsed time". Returning
 * NaN would make the injection score NaN, so an engram with a malformed
 * timestamp (the schema accepts any string) would silently never be injected.
 */
export function daysSince(lastAccessed: string, now?: Date): number {
  const last = new Date(lastAccessed)
  const current = now || new Date()
  const elapsed = current.getTime() - last.getTime()
  if (!Number.isFinite(elapsed)) return 0
  return Math.max(0, Math.floor(elapsed / MS_PER_DAY))
}

/**
 * The amount a passive retrieval would add to `retrieval_strength` under the
 * legacy reactivation rule.
 *
 * @deprecated Retrieval no longer moves `retrieval_strength` — see
 * {@link reactivate}. Kept exported for consumers that still reference the
 * legacy value.
 */
export const LEGACY_REACTIVATION_STRENGTH_DELTA = 0.1

/**
 * Reactivation on access: returns the strength UNCHANGED. `retrieval_strength` moves only
 * on deliberate feedback, so incidental fetches cannot outvote it or saturate it; traffic
 * is counted in `activation.frequency`. Recall still refreshes `last_accessed`, which
 * drives decay.
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
 * Confidence decay for engrams without recent positive feedback.
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
  // An unparseable reference is no reference: NaN would pass through
  // `Math.max(FLOOR, NaN)`, break the 0.1 floor and poison the injection score.
  if (!Number.isFinite(referenceDate.getTime()) || !Number.isFinite(current.getTime())) return retrievalStrength

  const daysSinceRef = Math.max(0, Math.floor((current.getTime() - referenceDate.getTime()) / MS_PER_DAY))
  if (daysSinceRef <= GRACE_PERIOD_DAYS) return retrievalStrength

  const daysOverGrace = daysSinceRef - GRACE_PERIOD_DAYS
  const monthsOverGrace = daysOverGrace / 30
  const multiplier = Math.pow(MONTHLY_MULTIPLIER, monthsOverGrace)
  const decayed = retrievalStrength * multiplier

  return Math.max(CONFIDENCE_DECAY_FLOOR, decayed)
}

