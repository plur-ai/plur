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
 * reads as high-confidence. Ties break deterministically: equal confidence
 * prefers a domain-prefix match, then scope name ascending.
 *
 * Each candidate carries two domain-channel booleans (see {@link ScopeCandidate}):
 * `domainMatch` (true for EITHER prefix direction — used for scoring/ordering)
 * and `coverContainsDomain` (true ONLY when the cover is a prefix of, or equals,
 * the engram domain — the FORWARD direction). The write-path router
 * (`_resolveUnscopedScope` in index.ts, #353 PR-6) routes a clean FORWARD domain
 * match DETERMINISTICALLY, bypassing the squash/threshold so it no longer has to
 * land EXACTLY on SCOPE_MATCH_THRESHOLD. The REVERSE direction (engram broader
 * than the cover) and weak signals (tag-only, keyword-only) stay gated by the
 * threshold — keying the bypass on `coverContainsDomain` rather than `domainMatch`
 * stops a broad/generic engram from over-routing into a narrow shared scope
 * (reaudit finding 4). The weights/threshold/squash are unchanged — the
 * deterministic bypass lives in the caller, not in this ranker.
 */
import type { ScopeMetadata } from './schemas/scope-metadata.js'

/** Below this confidence a scope is not a confident home for an engram. Exported
 * for Stage 3b to gate auto-routing on; NOT applied to ranking here — the ranker
 * returns every scope that scores above zero and lets the caller decide. The
 * auto-route gate in index.ts (`_resolveUnscopedScope`) is `>=`, so a confidence
 * that lands EXACTLY on this value clears it — see THRESHOLD_SINGLE_DOMAIN. */
export const SCOPE_MATCH_THRESHOLD = 0.5

/** Per-channel weights. domain ≫ tag > keyword by design (see module doc).
 *
 * WEIGHT_DOMAIN is 1.5 (raised from 1.0 in 0.10.0, #353/finding-11) so that a
 * LONE domain-prefix match — the strongest, most deliberate routing signal —
 * clears SCOPE_MATCH_THRESHOLD on its own: squash(1.5) = 1.5/(1.5+1.5) = 0.5000,
 * which the `>=` gate accepts (see THRESHOLD_SINGLE_DOMAIN). At the old 1.0,
 * squash(1.0) = 1.0/2.5 = 0.40 < 0.5, so a domain-only match never auto-routed —
 * the bug. domain-alone and three-tag-alone (3*0.5 = 1.5) now BOTH reach the
 * threshold by design; the `>=` gate is deliberate (not `>`). Changing
 * WEIGHT_TAG/SATURATION shifts these boundaries — see the routing tests and
 * THRESHOLD_SINGLE_DOMAIN. */
const WEIGHT_DOMAIN = 1.5
const WEIGHT_TAG = 0.5
const WEIGHT_KEYWORD = 0.2

/** Weight for a REVERSE-direction domain hit — the engram's `domain` is BROADER
 * than the cover (`domain ⊃ cover`, e.g. domain `plur` against cover `plur.core`).
 * The engram is NOT specific to the scope, so the reverse match is a weak signal:
 * it contributes WEIGHT_DOMAIN_REVERSE (NOT the full WEIGHT_DOMAIN) to the score
 * and never sets `coverContainsDomain`. A LONE reverse hit therefore squashes to
 * squash(0.5)=0.5/2.0=0.25 < SCOPE_MATCH_THRESHOLD, so a broad/generic engram
 * does NOT land in a narrow shared scope on the reverse match alone (reaudit
 * finding 4) — it must accumulate additional tag/keyword evidence to clear the
 * threshold. The FORWARD direction is unchanged at full WEIGHT_DOMAIN, so
 * THRESHOLD_SINGLE_DOMAIN and every forward routing test are untouched. */
const WEIGHT_DOMAIN_REVERSE = WEIGHT_TAG

/** Raw score at which confidence saturates to ~1.0. A single domain-prefix hit
 * (WEIGHT_DOMAIN = 1.5) lands EXACTLY on SCOPE_MATCH_THRESHOLD via squash; the
 * `>=` gate then auto-routes it. This boundary is intentionally exact — any
 * INCREASE to SATURATION or DECREASE to WEIGHT_DOMAIN breaks the lone-domain
 * auto-route (e.g. SATURATION=2.0 → single-domain confidence 1.5/3.5 = 0.43 <
 * 0.5; WEIGHT_DOMAIN=1.0 → 1.0/2.5 = 0.40 < 0.5). Stacking tag + keyword hits
 * pushes a domain match the rest of the way up the curve. */
const SATURATION = 1.5

/**
 * The confidence a LONE domain-prefix match produces, derived from the squash
 * function squash(x) = x / (x + SATURATION) with x = WEIGHT_DOMAIN:
 *
 *     THRESHOLD_SINGLE_DOMAIN = WEIGHT_DOMAIN / (WEIGHT_DOMAIN + SATURATION)
 *                             = 1.5 / (1.5 + 1.5)  =  1.5 / 3.0  =  0.5
 *
 * 0.5 is exactly representable in IEEE-754, and 1.5/3.0 evaluates to it exactly,
 * so this equals {@link SCOPE_MATCH_THRESHOLD} and the `>=` auto-route gate
 * accepts a lone-domain match. A unit test pins
 * `THRESHOLD_SINGLE_DOMAIN === SCOPE_MATCH_THRESHOLD` so a future weight/
 * saturation tweak that silently re-breaks finding #11 fails CI.
 *
 * VALID ONLY for squash(x) = x/(x+SATURATION); if the squash function changes,
 * recompute this constant against the new function.
 */
export const THRESHOLD_SINGLE_DOMAIN = WEIGHT_DOMAIN / (WEIGHT_DOMAIN + SATURATION)

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
  /**
   * True when this candidate matched via the domain-prefix channel — in EITHER
   * direction: the engram's `domain` is namespace-covered by one of the scope's
   * `covers` entries (`cover ⊃ domain`, forward), OR the engram's `domain` is
   * BROADER than the cover (`domain ⊃ cover`, reverse). Both directions add the
   * full WEIGHT_DOMAIN to the squashed `confidence`, so this flag exists for
   * scoring/ordering (the domain-preferring tie-break) — NOT as the bypass key.
   *
   * Do NOT use `domainMatch` for the deterministic auto-route bypass: the reverse
   * direction would over-route a broad/generic engram into a NARROW shared scope
   * (reaudit finding 4). Key the bypass on {@link coverContainsDomain} instead.
   */
  domainMatch: boolean
  /**
   * True ONLY for the FORWARD direction of the domain match — the scope's
   * declared coverage CONTAINS the engram's topic: a `covers` entry is a
   * namespace-prefix of, or equals, the engram's `domain` (`cover ⊃ domain` or
   * `cover === domain`). The engram is at least as specific as the scope, so it
   * genuinely belongs there.
   *
   * The caller (`_resolveUnscopedScope` in index.ts) routes a clean FORWARD
   * domain match DETERMINISTICALLY, bypassing the squash/threshold edge. The
   * REVERSE direction (`domain ⊃ cover`, engram broader than the cover) leaves
   * this `false`: it still contributes to `confidence` (so it can route via the
   * normal `>=` threshold gate) but never gets the deterministic bypass, so a
   * broad engram never deterministically lands in a narrow shared scope.
   * Weak signals (tag-only, keyword-only) also leave this `false`.
   */
  coverContainsDomain: boolean
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
): { raw: number; reasons: string[]; domainMatch: boolean; coverContainsDomain: boolean } | null {
  const normalizedCovers = covers.map(c => ({ raw: c, norm: normalizeCover(c) })).filter(c => c.norm.length > 0)
  if (normalizedCovers.length === 0) return null

  let raw = 0
  let domainMatch = false
  let coverContainsDomain = false
  const reasons: string[] = []

  // --- domain-prefix channel (highest weight) ---
  const domain = signals.domain?.toLowerCase().trim()
  if (domain) {
    for (const cover of normalizedCovers) {
      // FORWARD: the cover is a prefix of (or equals) the domain
      // (`plur.*` ⊃ `plur.core.security`). The scope's declared coverage CONTAINS
      // the engram's topic, so the engram genuinely belongs here. Only this
      // direction sets `coverContainsDomain` — the signal the deterministic
      // auto-route bypass keys on (reaudit finding 4).
      if (isNamespacePrefix(cover.norm, domain)) {
        raw += WEIGHT_DOMAIN
        domainMatch = true
        coverContainsDomain = true
        reasons.push(`domain ${domain} ⊂ covers ${cover.raw}`)
        break // one domain hit per scope — domain is single-valued
      }
      // REVERSE: the domain is a STRICT prefix of the cover (`plur` engram, scope
      // covering `plur.core`). The engram is BROADER than the scope. Still a
      // domain-channel hit for scoring, but DOWN-WEIGHTED (WEIGHT_DOMAIN_REVERSE,
      // not the full WEIGHT_DOMAIN) and it must NOT get the deterministic bypass —
      // `coverContainsDomain` stays false. So a lone reverse hit squashes below the
      // threshold and a broad/generic engram never lands in a narrow shared scope
      // (reaudit finding 4); it can still route only if additional tag/keyword
      // evidence pushes its squashed score to `>= SCOPE_MATCH_THRESHOLD` as normal.
      if (isNamespacePrefix(domain, cover.norm)) {
        raw += WEIGHT_DOMAIN_REVERSE
        domainMatch = true
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
  return { raw, reasons, domainMatch, coverContainsDomain }
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
      domainMatch: scored.domainMatch,
      coverContainsDomain: scored.coverContainsDomain,
    })
  }
  // Sort by confidence desc; on equal confidence prefer a domain-prefix match
  // (so the deterministic-bypass caller picks the genuine domain candidate over
  // a coincidentally-equal weak-signal one — e.g. a lone domain hit and a
  // three-tag hit both squash to exactly 0.5); finally break remaining ties on
  // scope name ascending for full determinism.
  candidates.sort((a, b) =>
    b.confidence - a.confidence ||
    (b.domainMatch ? 1 : 0) - (a.domainMatch ? 1 : 0) ||
    a.scope.localeCompare(b.scope),
  )
  return candidates
}
