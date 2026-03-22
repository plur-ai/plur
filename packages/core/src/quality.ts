import type { Engram } from './schemas/engram.js'

/**
 * Compute engram quality score (0-1).
 *
 * Measures how well-formed, grounded, and useful an engram is.
 * Higher quality engrams rank higher in injection and marketplace.
 *
 * Components:
 *   content     (0.30) — statement quality, rationale, dual coding
 *   grounding   (0.20) — knowledge anchors, associations, entities
 *   usage       (0.20) — proven usefulness (hit/miss tracking)
 *   feedback    (0.15) — human validation signals
 *   completeness(0.15) — schema enrichment depth
 */
export function computeQualityScore(engram: Engram): number {
  const content = contentScore(engram)
  const grounding = groundingScore(engram)
  const usage = usageScore(engram)
  const feedback = feedbackScore(engram)
  const completeness = completenessScore(engram)

  return Math.min(1.0, content * 0.30 + grounding * 0.20 + usage * 0.20 + feedback * 0.15 + completeness * 0.15)
}

/** Statement quality: length, rationale, contraindications, dual coding. */
function contentScore(e: Engram): number {
  let score = 0
  if (e.statement.length >= 25 && e.statement.length <= 500) score += 0.3
  else if (e.statement.length >= 10) score += 0.15
  if (e.rationale) score += 0.3
  if (e.contraindications && e.contraindications.length > 0) score += 0.2
  if (e.dual_coding) score += 0.2
  return Math.min(1.0, score)
}

/** Evidence and anchoring: knowledge anchors, associations, entities. */
function groundingScore(e: Engram): number {
  let score = 0
  if (e.knowledge_anchors.length > 0) score += 0.4
  if (e.associations.length > 0) score += 0.3
  if (e.source_patterns && e.source_patterns.length > 0) score += 0.15
  if (e.entities && e.entities.length > 0) score += 0.15
  return Math.min(1.0, score)
}

/** Proven usefulness via automatic hit/miss tracking. */
function usageScore(e: Engram): number {
  if (!e.usage) return 0.5 // Untested — neutral
  if (e.usage.injections === 0) return 0.5
  const hitRate = e.usage.hits / Math.max(e.usage.injections, 1)
  return Math.min(1.0, hitRate * 1.5)
}

/** Human validation: net positive feedback. */
function feedbackScore(e: Engram): number {
  const total = e.feedback_signals.positive + e.feedback_signals.negative + e.feedback_signals.neutral
  if (total === 0) return 0.5 // No feedback — neutral
  const net = e.feedback_signals.positive - e.feedback_signals.negative
  return 0.5 + (net / total) * 0.5
}

/** Schema enrichment depth: how many optional fields are populated. */
function completenessScore(e: Engram): number {
  let filled = 0
  let total = 7
  if (e.knowledge_type) filled++
  if (e.domain) filled++
  if (e.entities && e.entities.length > 0) filled++
  if (e.temporal) filled++
  if (e.episodic) filled++
  if (e.provenance) filled++
  if (e.dual_coding) filled++
  return filled / total
}

/**
 * Compute exchange fitness score (0-1) for marketplace listings.
 * Extends quality with social proof and environmental diversity.
 */
export function computeExchangeFitness(engram: Engram): number {
  const quality = computeQualityScore(engram)
  const exchange = engram.exchange

  if (!exchange) return quality * 0.4 // No exchange data — just quality

  const diversityNorm = Math.min(1.0, exchange.environmental_diversity / 10)
  const adoptionNorm = Math.min(1.0, exchange.adoption_count / 100)
  const ageNorm = Math.min(1.0, daysSinceCreation(engram) / 365)
  const contradictionPenalty = 1 - exchange.contradiction_rate

  return (
    quality * 0.40 +
    diversityNorm * 0.25 +
    adoptionNorm * 0.20 +
    ageNorm * 0.10 +
    contradictionPenalty * 0.05
  )
}

function daysSinceCreation(e: Engram): number {
  const created = e.temporal?.learned_at || e.activation.last_accessed
  const days = (Date.now() - new Date(created).getTime()) / (1000 * 60 * 60 * 24)
  return Math.max(0, days)
}
