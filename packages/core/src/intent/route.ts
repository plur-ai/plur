/**
 * Per-intent ranking profile.
 *
 * Modest multipliers (≤1.5×) so wrong classification cannot silently
 * destroy good rankings. The default `general` profile is the neutral
 * baseline — all multipliers = 1.0, i.e. exactly the pre-feature behavior.
 *
 * Toggle the whole feature off via env: PLUR_INTENT_ROUTING=off.
 */

import type { QueryIntent } from './classifier.js'

export interface IntentRoutingProfile {
  /** Multiplier on BM25 contribution in RRF fusion. */
  bm25Weight: number
  /** Multiplier on embedding contribution in RRF fusion. */
  vectorWeight: number
  /** Multiplier on engram recency component (boosts recent engrams). */
  recencyBoost: number
  /** Multiplier on engrams with non-empty episode_ids[]. */
  episodeBoost: number
  /** Multiplier on engrams whose domain matches entity patterns (crm.*, reference.*). */
  entityBoost: number
}

/** Neutral baseline — identical to pre-feature behavior. */
const NEUTRAL: IntentRoutingProfile = {
  bm25Weight: 1.0,
  vectorWeight: 1.0,
  recencyBoost: 1.0,
  episodeBoost: 1.0,
  entityBoost: 1.0,
}

const TEMPORAL: IntentRoutingProfile = {
  // Temporal queries are usually crisp recall of an event/note; favor BM25
  // slightly (exact-match wins). Vector still contributes.
  bm25Weight: 1.1,
  vectorWeight: 1.0,
  // Push recent engrams forward — the routing signal.
  recencyBoost: 1.5,
  episodeBoost: 1.2,
  entityBoost: 1.0,
}

const ENTITY: IntentRoutingProfile = {
  // Entity queries benefit from semantic match on names + targeted domains.
  bm25Weight: 1.0,
  vectorWeight: 1.1,
  recencyBoost: 1.0,
  episodeBoost: 1.0,
  // Boost engrams whose domain looks like crm.* / reference.* / contact.*
  entityBoost: 1.4,
}

const EVENT: IntentRoutingProfile = {
  bm25Weight: 1.0,
  vectorWeight: 1.1,
  // Events often happen recently; recency helps but episodes help more.
  recencyBoost: 1.2,
  episodeBoost: 1.4,
  entityBoost: 1.0,
}

/** Map an intent to its ranking profile. */
export function routeForIntent(intent: QueryIntent): IntentRoutingProfile {
  switch (intent) {
    case 'temporal': return TEMPORAL
    case 'entity':   return ENTITY
    case 'event':    return EVENT
    case 'general':
    default:         return NEUTRAL
  }
}

/**
 * Returns true if intent routing is globally disabled via env var.
 * Default ON (feature ships on by default — graceful degradation makes it safe).
 */
export function isIntentRoutingDisabled(): boolean {
  const v = process.env.PLUR_INTENT_ROUTING
  if (!v) return false
  return v.toLowerCase() === 'off' || v === '0' || v.toLowerCase() === 'false'
}

/**
 * Domain prefixes that count as "entity-typed" for the entityBoost.
 * Engrams in these domains get the boost when the query is entity-intent.
 */
const ENTITY_DOMAIN_PREFIXES = ['crm', 'reference', 'contact', 'contacts', 'people', 'org']

export function isEntityDomain(domain: string | undefined): boolean {
  if (!domain) return false
  const head = domain.split(/[./]/)[0]?.toLowerCase()
  if (!head) return false
  return ENTITY_DOMAIN_PREFIXES.includes(head)
}
