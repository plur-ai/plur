// src/confidence.ts

/**
 * Minimal interface for confidence computation.
 * Accepts any object with these optional fields — works with Engram,
 * AgentEngram, WireEngram, or any subset.
 */
interface ConfidenceInput {
  feedback_signals?: { positive: number; negative: number; neutral: number }
  consolidated?: boolean
}

/**
 * Compute a confidence score (0.0-1.0) from feedback signals.
 *
 * Uses sigmoid of net feedback ratio, dampened by sample size.
 * No feedback → 0.5 (neutral). Heavy positive → approaches 1.0.
 * Small sample sizes are dampened toward 0.5.
 */
export function computeConfidence(input: ConfidenceInput): number {
  const fb = input.feedback_signals ?? { positive: 0, negative: 0, neutral: 0 }
  const total = fb.positive + fb.negative + fb.neutral

  if (total === 0) return 0.5

  // Net ratio: -1.0 (all negative) to +1.0 (all positive)
  const netRatio = (fb.positive - fb.negative) / total

  // Sample-size dampening: adjustedRatio approaches netRatio as total grows
  // At total=1: dampening=0.5, at total=5: dampening=0.83, at total=20: dampening=0.95
  const dampening = 1 - 1 / (total + 1)
  const adjustedRatio = netRatio * dampening

  // Sigmoid: maps [-1,1] to [0,1]
  const steepness = 2.0
  const base = 1 / (1 + Math.exp(-steepness * adjustedRatio))

  // Consolidation bonus
  const consolidationBonus = input.consolidated ? 0.05 : 0

  return Math.min(1.0, Math.max(0.0, base + consolidationBonus))
}

/**
 * Compute a composite meta-confidence score (0.0-1.0) for a META- engram
 * based on the richness of its evidence, domain coverage, structural depth,
 * and validation ratio.
 *
 * Weights:
 *   - evidenceCount (capped at 5): 25%
 *   - domainCount   (capped at 3): 35%
 *   - structuralDepth (capped at 3): 20%
 *   - validationRatio (0.0–1.0): 20%
 */
export function computeMetaConfidence(
  evidenceCount: number,
  domainCount: number,
  structuralDepth: number,
  validationRatio: number,
): number {
  const evidenceSignal = Math.min(evidenceCount / 5, 1.0) * 0.25
  const domainSignal = Math.min(domainCount / 3, 1.0) * 0.35
  const depthSignal = Math.min(structuralDepth / 3, 1.0) * 0.20
  const validationSignal = validationRatio * 0.20
  return evidenceSignal + domainSignal + depthSignal + validationSignal
}

/** Convert numeric confidence to human-readable band */
export function confidenceBand(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.7) return 'high'
  if (score >= 0.4) return 'medium'
  return 'low'
}
