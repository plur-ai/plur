/**
 * Deterministic scope-suggestion ranker (#345/#346, Stage 3a). Given an engram's
 * signals (statement, domain, tags) and the registered scopes that declare a
 * `covers[]` list, score how well each scope is the home for that engram and
 * return a ranked candidate list.
 *
 * ADDITIVE ONLY. Nothing here changes where engrams are stored. `learn()` /
 * `learnRouted()` do NOT call this — the auto-route behavior flip (and the
 * un-scoped default global→local change) is the separate gated Stage 3b PR.
 * This module is a pure, side-effect-free advisor: NO LLM, NO network, fully
 * deterministic so the same inputs always produce the same ordering.
 *
 * Scoring is overlap between the engram's signals and each scope's `covers`
 * tokens, across three weighted channels:
 *
 *   - domain-prefix (highest): the engram `domain` is a dotted namespace
 *     (e.g. `plur.core.security`). A cover entry of `plur`, `plur.core`, or
 *     `plur.*` matches it as a namespace prefix. This is the strongest signal
 *     because domain is the most deliberate routing hint.
 *   - tag (medium): any `tags[]` entry equal to, or a dotted-prefix of, a cover
 *     token (or vice-versa).
 *   - statement-keyword (low): tokenize the statement and count hits against the
 *     cover tokens. Weakest because free text is noisy.
 *
 * Confidence is normalized into [0,1] by squashing the raw weighted score, so a
 * single weak keyword hit reads as low-confidence and a domain-prefix match
 * reads as high-confidence. Ties break deterministically on scope name.
 */
import type { ScopeMetadata } from './schemas/scope-metadata.js'

/** Below this confidence a scope is not a confident home for an engram. Exported
 * for Stage 3b to gate auto-routing on; NOT applied to ranking here — the ranker
 * returns every scope that scores above zero and lets the caller decide. */
export const SCOPE_MATCH_THRESHOLD = 0.5

/** Per-channel weights. domain ≫ tag > keyword by design (see module doc). */
const WEIGHT_DOMAIN = 1.0
const WEIGHT_TAG = 0.5
const WEIGHT_KEYWORD = 0.2

/** Raw score at which confidence saturates to ~1.0. A single domain-prefix hit
 * (WEIGHT_DOMAIN = 1.0) already lands near the top of the curve; stacking tag +
 * keyword hits pushes it the rest of the way. */
const SATURATION = 1.5

/** Signals carried by an engram, used to score scope fit. */
export interface ScopeSignals {
  statement: string
  domain?: string
  tags?: string[]
}

/** One ranked scope candidate. */
export interface ScopeCandidate {
  scope: string
  /** Normalized fit in [0,1], descending across the returned array. */
  confidence: number
  /** Human-readable matched signals, e.g. "domain plur.core.security ⊂ covers plur.*". */
  reason: string
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'use', 'with', 'this', 'that', 'from',
  'have', 'has', 'his', 'its', 'who', 'how', 'why', 'what', 'when', 'where',
  'will', 'into', 'than', 'then', 'them', 'they', 'your', 'about', 'which',
])

/** Lowercase, split on non-alphanumeric (keep dots so dotted tokens survive for
 * the caller, but the keyword channel splits further), drop stopwords + tokens
 * shorter than 3 chars. */
function tokenizeStatement(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .flatMap(t => t.split('.'))
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))
}

/** Normalize a cover token: lowercase, strip a trailing `.*` or `*` glob so
 * `plur.*` and `plur` compare identically as a namespace prefix. */
function normalizeCover(cover: string): string {
  return cover.toLowerCase().replace(/\.?\*$/, '')
}

/** Does `value` sit under `prefix` as a dotted namespace? `plur.core.security`
 * is under `plur` and `plur.core`; `plurple` is NOT under `plur` (segment
 * boundary, not substring). Exact equality counts. */
function isNamespacePrefix(prefix: string, value: string): boolean {
  if (!prefix) return false
  return value === prefix || value.startsWith(prefix + '.')
}

/** Squash a non-negative raw score into [0,1). Monotonic, saturating, so order
 * is preserved and confidences stay comparable across scopes. */
function squash(raw: number): number {
  if (raw <= 0) return 0
  return raw / (raw + SATURATION)
}

/**
 * Score one scope against the engram signals. Returns the raw weighted score and
 * the matched-signal reasons, or null when nothing overlaps.
 */
function scoreScope(
  signals: ScopeSignals,
  scope: string,
  covers: string[],
): { raw: number; reasons: string[] } | null {
  const normalizedCovers = covers.map(c => ({ raw: c, norm: normalizeCover(c) })).filter(c => c.norm.length > 0)
  if (normalizedCovers.length === 0) return null

  let raw = 0
  const reasons: string[] = []

  // --- domain-prefix channel (highest weight) ---
  const domain = signals.domain?.toLowerCase().trim()
  if (domain) {
    for (const cover of normalizedCovers) {
      // Match either direction: the cover is a prefix of the domain
      // (`plur.*` ⊃ `plur.core.security`), or the domain is a prefix of the
      // cover (`plur` engram fits a `plur.core` scope, weaker but still a hit).
      if (isNamespacePrefix(cover.norm, domain)) {
        raw += WEIGHT_DOMAIN
        reasons.push(`domain ${domain} ⊂ covers ${cover.raw}`)
        break // one domain hit per scope — domain is single-valued
      }
      if (isNamespacePrefix(domain, cover.norm)) {
        raw += WEIGHT_DOMAIN
        reasons.push(`domain ${domain} ⊃ covers ${cover.raw}`)
        break
      }
    }
  }

  // --- tag channel (medium weight) ---
  const tags = (signals.tags ?? []).map(t => t.toLowerCase().trim()).filter(Boolean)
  const matchedTags: string[] = []
  for (const tag of tags) {
    const hit = normalizedCovers.find(
      c => c.norm === tag || isNamespacePrefix(c.norm, tag) || isNamespacePrefix(tag, c.norm),
    )
    if (hit) {
      raw += WEIGHT_TAG
      matchedTags.push(`tag ${tag} ~ covers ${hit.raw}`)
    }
  }
  reasons.push(...matchedTags)

  // --- statement-keyword channel (low weight) ---
  const coverKeywords = new Set(normalizedCovers.flatMap(c => c.norm.split('.')).filter(t => t.length >= 3))
  const statementTokens = new Set(tokenizeStatement(signals.statement))
  const keywordHits: string[] = []
  for (const token of statementTokens) {
    if (coverKeywords.has(token)) {
      raw += WEIGHT_KEYWORD
      keywordHits.push(token)
    }
  }
  if (keywordHits.length > 0) {
    reasons.push(`keywords [${keywordHits.sort().join(', ')}] ∈ covers`)
  }

  if (raw <= 0) return null
  return { raw, reasons }
}

/**
 * Rank the supplied scopes by how well each is the home for an engram carrying
 * `signals`. Pure: same inputs → same output. Returns candidates sorted by
 * confidence descending, then by scope name ascending (deterministic tie-break).
 * Scopes with no `covers` or no overlap are omitted; an empty array means no
 * scope matched.
 */
export function rankScopes(
  signals: ScopeSignals,
  scopes: Array<Pick<ScopeMetadata, 'scope' | 'covers'>>,
): ScopeCandidate[] {
  const candidates: ScopeCandidate[] = []
  for (const meta of scopes) {
    const covers = meta.covers ?? []
    if (covers.length === 0) continue
    const scored = scoreScope(signals, meta.scope, covers)
    if (!scored) continue
    candidates.push({
      scope: meta.scope,
      confidence: Number(squash(scored.raw).toFixed(4)),
      reason: scored.reasons.join('; '),
    })
  }
  candidates.sort((a, b) =>
    b.confidence - a.confidence || a.scope.localeCompare(b.scope),
  )
  return candidates
}
