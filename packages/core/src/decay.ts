import type { Engram } from './schemas/engram.js'
import { appendHistory, type HistoryEvent } from './history.js'

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

// === Batch Decay ===

/** Map retrieval strength to a human-readable status label. */
export function strengthToStatus(strength: number): string {
  if (strength > 0.5) return 'active'
  if (strength > 0.3) return 'fading'
  if (strength > 0.1) return 'dormant'
  return 'retirement_candidate'
}

export interface DecayTransition {
  engram_id: string
  old_strength: number
  new_strength: number
  old_status: string
  new_status: string
}

export interface BatchDecayResult {
  total: number
  decayed: number
  skipped: number
  transitions: DecayTransition[]
}

export interface BatchDecayOptions {
  contextScope?: string
  lambda?: number
  now?: Date
}

/**
 * Apply ACT-R decay to a batch of engrams.
 * Scope-matched engrams are skipped (they never decay).
 * Status transitions are logged to history.
 * Returns the result summary and the list of engrams that were modified.
 */
export function applyBatchDecay(
  engrams: Engram[],
  historyRoot: string,
  options?: BatchDecayOptions,
): { result: BatchDecayResult; modified: Engram[] } {
  const now = options?.now ?? new Date()
  const lambda = options?.lambda ?? DECAY_RATE
  const contextScope = options?.contextScope

  const active = engrams.filter(e => e.status === 'active')
  const transitions: DecayTransition[] = []
  const modified: Engram[] = []

  let decayed = 0
  let skipped = 0

  for (const engram of active) {
    // Scope-matched engrams never decay
    if (contextScope && isScopeMatched(engram.scope, contextScope)) {
      skipped++
      continue
    }

    const days = daysSince(engram.activation.last_accessed, now)
    if (days === 0) continue // Accessed today, no decay

    // Emotional weight modifier: higher emotion = slower decay
    const emotionalWeight = (engram as any).episodic?.emotional_weight ?? 5
    const effectiveLambda = lambda * (1 - emotionalWeight / 20)

    const oldStrength = engram.activation.retrieval_strength
    const newStrength = decayedStrength(oldStrength, days, effectiveLambda)

    // Only count as decayed if strength actually changed
    if (Math.abs(newStrength - oldStrength) < 1e-10) continue

    const oldStatus = strengthToStatus(oldStrength)
    const newStatus = strengthToStatus(newStrength)

    engram.activation.retrieval_strength = newStrength
    modified.push(engram)
    decayed++

    if (oldStatus !== newStatus) {
      const transition: DecayTransition = {
        engram_id: engram.id,
        old_strength: oldStrength,
        new_strength: newStrength,
        old_status: oldStatus,
        new_status: newStatus,
      }
      transitions.push(transition)

      const event: HistoryEvent = {
        event: 'engram_updated',
        engram_id: engram.id,
        timestamp: now.toISOString(),
        data: {
          reason: 'decay_status_transition',
          old_strength: oldStrength,
          new_strength: newStrength,
          old_status: oldStatus,
          new_status: newStatus,
        },
      }
      appendHistory(historyRoot, event)
    }
  }

  return {
    result: { total: active.length, decayed, skipped, transitions },
    modified,
  }
}

/** Check if an engram scope matches the context scope (exact match or child). */
function isScopeMatched(engramScope: string, contextScope: string): boolean {
  if (engramScope === contextScope) return true
  // Child scope: project:alpha/sub matches project:alpha, but project:beta does NOT match project:alpha
  if (engramScope.startsWith(contextScope + '/')) return true
  return false
}
