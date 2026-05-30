/**
 * Deterministic intent classifier for query rewriting.
 *
 * Inspired by gbrain's `src/core/search/intent.ts`. Pure regex / keyword
 * matching; no LLM call, no async, no I/O. Wrong classification routes
 * through the default profile (general) — graceful degradation.
 *
 * Intents:
 *   - entity   ("who works at X?", "Karl's email")
 *   - temporal ("yesterday", "last week", "2026-04-15")
 *   - event    ("Acme Series A", "the deploy crashed")
 *   - general  (everything else — current behavior, no ranking change)
 */

export type QueryIntent = 'entity' | 'temporal' | 'event' | 'general'

export interface IntentMatch {
  /** Detected intent. */
  intent: QueryIntent
  /** Confidence in [0, 1]. Higher means more signals fired. */
  confidence: number
  /** Human-readable reason for debug output and telemetry. */
  reason: string
}

// ─── Pattern banks ──────────────────────────────────────────────────

/** Temporal patterns — date-shaped tokens, relative time, ISO dates. */
const TEMPORAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\byesterday\b/i, label: 'yesterday' },
  { re: /\btoday\b/i, label: 'today' },
  { re: /\btomorrow\b/i, label: 'tomorrow' },
  { re: /\b(?:right )?now\b/i, label: 'now' },
  { re: /\bthis (?:morning|afternoon|evening|week|month|year|quarter)\b/i, label: 'this-period' },
  { re: /\blast (?:week|month|year|quarter|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, label: 'last-period' },
  { re: /\bnext (?:week|month|year|quarter)\b/i, label: 'next-period' },
  { re: /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|few|several) (?:days?|weeks?|months?|years?|hours?|minutes?) ago\b/i, label: 'N-ago' },
  { re: /\bsince\b/i, label: 'since' },
  { re: /\brecent(?:ly)?\b/i, label: 'recent' },
  { re: /\b\d{4}-\d{2}-\d{2}\b/, label: 'iso-date' },
  // Short month-day patterns: "Jan 5", "March 12", "Dec 2026"
  { re: /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:[a-z]*)\s+\d{1,4}\b/i, label: 'month-day' },
]

/** Event patterns — verbs of creation, occurrence, change. */
const EVENT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bhappened\b/i, label: 'happened' },
  { re: /\bannounced?\b/i, label: 'announced' },
  { re: /\blaunch(?:ed|ing)?\b/i, label: 'launched' },
  { re: /\breleas(?:ed|ing|e)\b/i, label: 'released' },
  { re: /\bdeploy(?:ed|ment)?\b/i, label: 'deploy' },
  { re: /\bcrashed?\b/i, label: 'crashed' },
  { re: /\bincident\b/i, label: 'incident' },
  { re: /\boutage\b/i, label: 'outage' },
  { re: /\bdecided?\b/i, label: 'decided' },
  { re: /\bdecision\b/i, label: 'decision' },
  { re: /\bshipped?\b/i, label: 'shipped' },
  { re: /\bmerged?\b/i, label: 'merged' },
  { re: /\bbroke\b/i, label: 'broke' },
  { re: /\bfailed?\b/i, label: 'failed' },
  // Series-A / round / event-shaped capitalized phrases
  { re: /\bseries\s+[a-z]\b/i, label: 'series-x' },
]

/** Entity-pattern keywords — contact / org metadata signals. */
const ENTITY_KEYWORDS: Array<{ re: RegExp; label: string }> = [
  { re: /\bemail(?:\s+address)?\b/i, label: 'email-keyword' },
  { re: /\bphone(?:\s+number)?\b/i, label: 'phone-keyword' },
  { re: /\bcontact(?:\s+info)?\b/i, label: 'contact-keyword' },
  { re: /\baddress\b/i, label: 'address-keyword' },
  { re: /\bcompany\b/i, label: 'company-keyword' },
  { re: /\borganization\b/i, label: 'organization-keyword' },
  { re: /\bmanager\b/i, label: 'manager-keyword' },
  { re: /\bworks?\s+(?:at|for|with)\b/i, label: 'works-at' },
]

/** Question words signalling entity intent. */
const ENTITY_QUESTION_WORDS: Array<{ re: RegExp; label: string }> = [
  { re: /\bwho\b/i, label: 'who' },
  { re: /\bwhose\b/i, label: 'whose' },
  { re: /\bwhich (?:person|company|organization|team|user)\b/i, label: 'which-person' },
]

/** Possessive token: "Karl's email", "Acme's CEO" — capitalized + apostrophe-s. */
const POSSESSIVE_RE = /\b([A-Z][a-zA-Z]+)['’]s\b/

// ─── Main classifier ────────────────────────────────────────────────

export function classifyQuery(query: string): IntentMatch {
  const q = (query ?? '').trim()
  if (q.length === 0) {
    return { intent: 'general', confidence: 0, reason: 'empty-query' }
  }

  // Tally signal hits per intent.
  const temporalHits: string[] = []
  const eventHits: string[] = []
  const entityHits: string[] = []

  for (const { re, label } of TEMPORAL_PATTERNS) {
    if (re.test(q)) temporalHits.push(label)
  }
  for (const { re, label } of EVENT_PATTERNS) {
    if (re.test(q)) eventHits.push(label)
  }
  for (const { re, label } of ENTITY_KEYWORDS) {
    if (re.test(q)) entityHits.push(label)
  }
  for (const { re, label } of ENTITY_QUESTION_WORDS) {
    if (re.test(q)) entityHits.push(label)
  }

  // Possessive ("Karl's") fires as an entity signal too.
  const possMatch = q.match(POSSESSIVE_RE)
  if (possMatch) entityHits.push(`possessive:${possMatch[1]}`)

  // ─── Decision rules — order matters ────────────────────────────────
  //
  // 1. Temporal anchors dominate when they appear with question words
  //    ("what happened yesterday" — temporal, not event).
  // 2. Strong event verbs without temporal anchors fire as event.
  // 3. Entity keywords / possessives fire as entity when no temporal.
  // 4. Otherwise general.
  //
  // Confidence scales with number of signals; capped at 1.0.

  // Resolve temporal vs event collision.
  // "Pin-point" temporal anchors (yesterday, today, specific date, N-ago)
  // dominate event verbs — the query is asking about a time window.
  // Vague temporal (this-period — "this quarter") does NOT dominate strong
  // event nouns (incident, outage, decision) because the noun is the more
  // specific routing signal.
  const pinpointTemporal = temporalHits.some(t =>
    t === 'yesterday' || t === 'today' || t === 'tomorrow' ||
    t === 'last-period' || t === 'next-period' ||
    t === 'iso-date' || t === 'month-day' || t === 'N-ago'
  )
  const vagueTemporal = temporalHits.some(t =>
    t === 'this-period' || t === 'since' || t === 'recent'
  )
  const strongEventNoun = eventHits.some(e =>
    e === 'incident' || e === 'outage' || e === 'decision' || e === 'series-x'
  )

  if (pinpointTemporal) {
    return {
      intent: 'temporal',
      confidence: clamp(0.5 + 0.15 * temporalHits.length),
      reason: `temporal signals: ${temporalHits.join(', ')}`,
    }
  }

  // Vague temporal + strong event noun => event wins.
  if (vagueTemporal && strongEventNoun) {
    return {
      intent: 'event',
      confidence: clamp(0.4 + 0.15 * eventHits.length),
      reason: `event signals (event-noun beats vague temporal): ${eventHits.join(', ')}`,
    }
  }

  // Event signal: at least one event verb AND no temporal anchor.
  if (eventHits.length > 0 && temporalHits.length === 0) {
    return {
      intent: 'event',
      confidence: clamp(0.5 + 0.15 * eventHits.length),
      reason: `event signals: ${eventHits.join(', ')}`,
    }
  }

  // Entity signal: at least one entity hit, and no pin-point temporal anchor.
  if (entityHits.length > 0 && !pinpointTemporal) {
    return {
      intent: 'entity',
      confidence: clamp(0.5 + 0.15 * entityHits.length),
      reason: `entity signals: ${entityHits.join(', ')}`,
    }
  }

  // Weak temporal (only "since" / "recent") with no other signals — still temporal.
  if (temporalHits.length > 0 && entityHits.length === 0 && eventHits.length === 0) {
    return {
      intent: 'temporal',
      confidence: clamp(0.3 + 0.15 * temporalHits.length),
      reason: `weak temporal signals: ${temporalHits.join(', ')}`,
    }
  }

  // Weak event (event verb + temporal but not strong temporal) — bias event
  // since the verb is the more specific signal.
  if (eventHits.length > 0) {
    return {
      intent: 'event',
      confidence: clamp(0.4 + 0.1 * eventHits.length),
      reason: `event signals (with weak temporal): ${eventHits.join(', ')}`,
    }
  }

  // Fallback.
  return {
    intent: 'general',
    confidence: 0.5,
    reason: 'no rules fired — default routing',
  }
}

function clamp(x: number): number {
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}
