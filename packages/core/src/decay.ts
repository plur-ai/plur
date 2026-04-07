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

/** Bump retrieval strength when accessed (reactivation) */
export function reactivate(currentStrength: number): number {
  return Math.min(1.0, currentStrength + 0.1)
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
