/**
 * Apply an intent routing profile to a ranked candidate list.
 *
 * Strategy: stable re-rank by composite intent score. Each engram in the
 * input list keeps its position-derived base score (so the original RRF /
 * BM25 / embedding ranking is the primary signal). We then add a small
 * multiplier-derived boost from the routing profile.
 *
 * Result: when the classifier is RIGHT, the boost surfaces the right
 * engrams. When the classifier is WRONG, the underlying ranking still
 * dominates and the wrong-intent boost only adds a small perturbation.
 *
 * This is the graceful-degradation guarantee. Multipliers are <= 1.5,
 * applied as additive contributions in [0, 1] to a base in [0, 1].
 */

import type { Engram } from '../schemas/engram.js'
import type { IntentRoutingProfile } from './route.js'
import { isEntityDomain } from './route.js'

const RECENCY_HALF_LIFE_DAYS = 30

/** Returns a value in [0, 1] — 1 if engram updated today, falling off to 0 over months. */
function recencyScore(engram: Engram): number {
  const last = engram.activation?.last_accessed
  if (!last) return 0
  const learned = engram.temporal?.learned_at ?? last
  // Use the more recent of last_accessed and learned_at — both count as recency.
  const ts = (learned > last) ? learned : last
  const parsed = Date.parse(ts)
  if (Number.isNaN(parsed)) return 0
  const days = (Date.now() - parsed) / (1000 * 60 * 60 * 24)
  if (days <= 0) return 1
  return Math.exp(-days / RECENCY_HALF_LIFE_DAYS)
}

function hasEpisodeAnchor(engram: Engram): boolean {
  return Array.isArray(engram.episode_ids) && engram.episode_ids.length > 0
}

/**
 * Re-rank `candidates` with the given routing profile.
 *
 * If the profile is the neutral baseline (all multipliers = 1.0), returns
 * the input unchanged — zero overhead on the general intent.
 */
export function applyIntentRouting(
  candidates: Engram[],
  profile: IntentRoutingProfile,
): Engram[] {
  if (candidates.length === 0) return candidates

  // Neutral fast-path: skip work when nothing would change.
  const isNeutral =
    profile.recencyBoost === 1.0 &&
    profile.episodeBoost === 1.0 &&
    profile.entityBoost === 1.0 &&
    profile.bm25Weight === 1.0 &&
    profile.vectorWeight === 1.0
  if (isNeutral) return candidates

  // Base score from original rank position: top = 1.0, falls off linearly.
  // Multiply by intent contributions to produce the final score. Keep the
  // base contribution at 1.0 so a single 1.5x boost moves ~33% of relative
  // weight — modest, by design.
  const N = candidates.length
  const scored = candidates.map((engram, i) => {
    const base = (N - i) / N // top result -> 1, bottom -> ~1/N
    let score = base

    // Recency component (multiplier — bigger = recent wins more).
    if (profile.recencyBoost !== 1.0) {
      const r = recencyScore(engram)
      // The boost is additive in r * (multiplier - 1) so old engrams are not penalized.
      score += r * (profile.recencyBoost - 1.0) * base
    }

    // Episode component.
    if (profile.episodeBoost !== 1.0 && hasEpisodeAnchor(engram)) {
      score += (profile.episodeBoost - 1.0) * base
    }

    // Entity component — engrams whose domain head is crm.*, reference.*, etc.
    if (profile.entityBoost !== 1.0 && isEntityDomain(engram.domain)) {
      score += (profile.entityBoost - 1.0) * base
    }

    return { engram, score }
  })

  // Stable sort by descending score.
  scored.sort((a, b) => b.score - a.score)
  return scored.map(s => s.engram)
}

/**
 * Classify a query and re-rank a candidate list in one call.
 *
 * Respects `intentOverride` if supplied; otherwise runs the deterministic
 * classifier. Respects the `PLUR_INTENT_ROUTING=off` env opt-out.
 */
export interface ApplyIntentOptions {
  intentOverride?: 'entity' | 'temporal' | 'event' | 'general'
}
