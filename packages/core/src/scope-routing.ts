/**
 * Deterministic scope-suggestion ranker: scores how well each scope with `covers[]` fits
 * an engram. Pure — no LLM, no network; callers decide via {@link decideAutoRoute}.
 * Channels: domain-prefix (highest; dotted namespace match), tag (medium), statement
 * keyword (low; noisy). Confidence squashes the weighted score into [0,1]. Ties: domain
 * match, then deeper cover, then scope name (so keyword-only ties are alphabetical).
 * `domainMatch` is either prefix direction (scoring); `coverContainsDomain` is FORWARD only
 * and is the key for the deterministic route bypass. Reverse and weak signals stay
 * threshold-gated so a broad engram does not over-route into a narrow shared scope.
 */
import type { ScopeMetadata } from './schemas/scope-metadata.js'
import { isSharedScope } from './scope-util.js'

/** Below this confidence a scope is not a confident home for an engram. Exported
 * to gate auto-routing on; NOT applied to ranking here — the ranker
 * returns every scope that scores above zero and lets the caller decide. The
 * auto-route gate in index.ts (`_resolveUnscopedScope`) is `>=`, so a confidence
 * that lands EXACTLY on this value clears it — see THRESHOLD_SINGLE_DOMAIN. */
export const SCOPE_MATCH_THRESHOLD = 0.5

/** Default floor for DISPLAY/suggestion surfaces: a lone coincidental
 * statement keyword squashes to ≈0.1176, which is noise, not signal — showing
 * it teaches agents to distrust the suggestion tool. 0.15 sits above the
 * lone-keyword band and below the two-keyword band (≈0.2105), so real
 * multi-signal matches always survive. Consumed by `plur_suggest_scope`
 * (packages/mcp) as its fallback when neither the tool arg nor
 * `scope_routing.min_confidence` config specifies a floor. The core
 * `suggestScope` API deliberately defaults to 0 (unfiltered). Defined once
 * here alongside its sibling thresholds — retune in one place. */
export const SUGGEST_DISPLAY_MIN_CONFIDENCE = 0.15

/** Per-channel weights. domain ≫ tag > keyword by design (see module doc).
 *
 * WEIGHT_DOMAIN is 1.5 so that a LONE domain-prefix match — the strongest, most
 * deliberate routing signal — clears SCOPE_MATCH_THRESHOLD on its own:
 * squash(1.5) = 1.5/(1.5+1.5) = 0.5000, which the `>=` gate accepts (see
 * THRESHOLD_SINGLE_DOMAIN). domain-alone and three-tag-alone (3*0.5 = 1.5) BOTH
 * reach the threshold by design; the `>=` gate is deliberate (not `>`). Changing
 * WEIGHT_TAG/SATURATION shifts these boundaries — see the routing tests and
 * THRESHOLD_SINGLE_DOMAIN. */
const WEIGHT_DOMAIN = 1.5
export const WEIGHT_TAG = 0.5
const WEIGHT_KEYWORD = 0.2

/** Cap on the statement-keyword channel's total raw contribution. Keyword
 * overlap is a weak, often-coincidental signal — statement words happening to match
 * a cover's namespace tokens. It must never, on its own OR combined with a single
 * coincidental tag, clear the auto-route threshold and drop a generic engram into a
 * shared team store. Sizing: a lone tag hit is WEIGHT_TAG (0.5); to keep
 * keyword + 1 tag under the single-domain threshold raw (1.5 ⟹ squash 0.5) the cap
 * must be < 1.0. At 0.8: keyword-only squash(0.8)=0.348, keyword+1-tag
 * squash(1.3)=0.464 — both below 0.5; keyword+2-tags (1.8 ⟹ 0.545) routes, but two
 * matching tags is deliberate intent, not coincidence. Keywords still BOOST a real
 * domain/tag match toward saturation. */
const MAX_KEYWORD_RAW = 0.8

/** Weight for a REVERSE-direction domain hit — the engram's `domain` is BROADER
 * than the cover (`domain ⊃ cover`, e.g. domain `plur` against cover `plur.core`).
 * The engram is NOT specific to the scope, so the reverse match is a weak signal:
 * it contributes WEIGHT_DOMAIN_REVERSE (NOT the full WEIGHT_DOMAIN) to the score
 * and never sets `coverContainsDomain`. A LONE reverse hit therefore squashes to
 * squash(0.5)=0.5/2.0=0.25 < SCOPE_MATCH_THRESHOLD, so a broad/generic engram
 * does NOT land in a narrow shared scope on the reverse match alone — it must
 * accumulate additional tag/keyword evidence to clear the threshold. */
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
 * Confidence of a LONE domain-prefix match: squash(WEIGHT_DOMAIN) = 1.5 / (1.5 + 1.5) = 0.5,
 * exactly {@link SCOPE_MATCH_THRESHOLD}, so the `>=` gate accepts it. A unit test pins the
 * equality. VALID ONLY for squash(x) = x/(x+SATURATION) — recompute if that changes.
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
   * True when matched via the domain-prefix channel in EITHER direction: forward
   * (`cover ⊃ domain`, full WEIGHT_DOMAIN) or reverse (`domain ⊃ cover`, only
   * WEIGHT_DOMAIN_REVERSE, so a lone reverse hit squashes to 0.25). For scoring/ordering.
   * Do NOT use it for the auto-route bypass — key that on {@link coverContainsDomain}.
   */
  domainMatch: boolean
  /**
   * True ONLY for the FORWARD domain match: a `covers` entry is a namespace-prefix of, or
   * equals, the engram's `domain`. `_resolveUnscopedScope` (index.ts) routes these
   * deterministically, bypassing the threshold. Reverse and weak signals leave it `false`,
   * so a broad engram reaches a narrow shared scope only if other evidence lifts it to 0.5.
   */
  coverContainsDomain: boolean
  /**
   * Segment depth of the `covers` entry that FORWARD-matched the domain,
   * e.g. cover `plur.core` → 2, `plur` → 1; 0 when there was no forward match.
   * Used as a tie-break: between two scopes that both forward-match the same
   * domain with equal confidence, the MORE specific cover (deeper) is the better
   * home, so it wins over an alphabetical-name fallback.
   */
  coverSpecificity: number
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
  weightTagOverride?: number,
): { raw: number; reasons: string[]; domainMatch: boolean; coverContainsDomain: boolean; coverSpecificity: number } | null {
  const effectiveWeightTag = weightTagOverride ?? WEIGHT_TAG
  const normalizedCovers = covers.map(c => ({ raw: c, norm: normalizeCover(c) })).filter(c => c.norm.length > 0)
  if (normalizedCovers.length === 0) return null

  let raw = 0
  let domainMatch = false
  let coverContainsDomain = false
  // Depth (segment count) of the cover that FORWARD-matched the domain.
  // A deeper cover is a more specific home; used to break ties between two scopes
  // that both forward-match the same domain with equal confidence.
  let coverSpecificity = 0
  const reasons: string[] = []

  // --- domain-prefix channel (highest weight) ---
  const domain = signals.domain?.toLowerCase().trim()
  if (domain) {
    for (const cover of normalizedCovers) {
      // FORWARD: the cover is a prefix of (or equals) the domain
      // (`plur.*` ⊃ `plur.core.security`). The scope's declared coverage CONTAINS
      // the engram's topic, so the engram genuinely belongs here. Only this
      // direction sets `coverContainsDomain` — the signal the deterministic
      // auto-route bypass keys on.
      if (isNamespacePrefix(cover.norm, domain)) {
        raw += WEIGHT_DOMAIN
        domainMatch = true
        coverContainsDomain = true
        coverSpecificity = cover.norm.split('.').filter(Boolean).length
        reasons.push(`domain ${domain} ⊂ covers ${cover.raw}`)
        break // one domain hit per scope — domain is single-valued
      }
      // REVERSE: the domain is a STRICT prefix of the cover (`plur` engram, scope
      // covering `plur.core`). The engram is BROADER than the scope. Still a
      // domain-channel hit for scoring, but DOWN-WEIGHTED (WEIGHT_DOMAIN_REVERSE,
      // not the full WEIGHT_DOMAIN) and it must NOT get the deterministic bypass —
      // `coverContainsDomain` stays false. So a lone reverse hit squashes below the
      // threshold and a broad/generic engram never lands in a narrow shared scope;
      // it can still route only if additional tag/keyword
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
      raw += effectiveWeightTag
      matchedTags.push(`tag ${tag} ~ covers ${hit.raw}`)
    }
  }
  reasons.push(...matchedTags)

  // --- statement-keyword channel (low weight, capped) ---
  const coverKeywords = new Set(normalizedCovers.flatMap(c => c.norm.split('.')).filter(t => t.length >= 3))
  const statementTokens = new Set(tokenizeStatement(signals.statement))
  const keywordHits: string[] = []
  for (const token of statementTokens) {
    if (coverKeywords.has(token)) keywordHits.push(token)
  }
  if (keywordHits.length > 0) {
    // Cap the keyword contribution so keyword-only overlap can't reach the
    // auto-route threshold — a generic engram must not land in a shared scope on
    // word-coincidence alone. Keywords still boost a real domain/tag match.
    raw += Math.min(keywordHits.length * WEIGHT_KEYWORD, MAX_KEYWORD_RAW)
    reasons.push(`keywords [${keywordHits.sort().join(', ')}] ∈ covers`)
  }

  if (raw <= 0) return null
  return { raw, reasons, domainMatch, coverContainsDomain, coverSpecificity }
}

/** Options for {@link rankScopes} — all optional; defaults match the module constants. */
export interface RankScopesOptions {
  /** Override {@link WEIGHT_TAG} for this call. Default: 0.5. */
  weightTag?: number
  /**
   * Exclude candidates whose `confidence` is strictly below this value (default: 0
   * — return all positive-scoring candidates and let the caller decide). Useful in
   * display/suggestion contexts to suppress lone keyword hits (≈0.12) that add noise
   * without being reliable routing signals. The write-path auto-router
   * in index.ts gates via `matchThreshold` (default 0.5) independently of this option.
   */
  minConfidence?: number
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
  options?: RankScopesOptions,
): ScopeCandidate[] {
  const candidates: ScopeCandidate[] = []
  for (const meta of scopes) {
    const covers = meta.covers ?? []
    if (covers.length === 0) continue
    const scored = scoreScope(signals, meta.scope, covers, options?.weightTag)
    if (!scored) continue
    candidates.push({
      scope: meta.scope,
      confidence: Number(squash(scored.raw).toFixed(4)),
      reason: scored.reasons.join('; '),
      domainMatch: scored.domainMatch,
      coverContainsDomain: scored.coverContainsDomain,
      coverSpecificity: scored.coverSpecificity,
    })
  }
  // Sort by confidence desc; on equal confidence prefer a domain-prefix match
  // (so the deterministic-bypass caller picks the genuine domain candidate over
  // a coincidentally-equal weak-signal one — e.g. a lone domain hit and a
  // three-tag hit both squash to exactly 0.5); then, between two scopes that BOTH
  // forward-match the same domain at equal confidence, prefer the MORE SPECIFIC
  // cover — the narrower team that more precisely contains the topic, not
  // whichever scope name sorts first; finally break remaining ties on scope name
  // ascending for full determinism.
  candidates.sort((a, b) =>
    b.confidence - a.confidence ||
    (b.domainMatch ? 1 : 0) - (a.domainMatch ? 1 : 0) ||
    b.coverSpecificity - a.coverSpecificity ||
    a.scope.localeCompare(b.scope),
  )
  // Number.isFinite guards NaN/Infinity from library callers computing a floor
  // (e.g. parseFloat(env)) — NaN would otherwise silently disable filtering
  // (NaN > 0 is false) with no error.
  const min = options?.minConfidence ?? 0
  return Number.isFinite(min) && min > 0 ? candidates.filter(c => c.confidence >= min) : candidates
}

/**
 * Who chose a write's scope (a server otherwise sees only the string):
 * - `explicit` — named on the call itself.
 * - `session`  — a session or `.plur.yaml` scope was in effect (standing human choice).
 * - `default`  — nothing named it; the unscoped default applied.
 * - `routed`   — the router chose it from `covers`; the only value meaning no human picked it.
 */
export type ScopeSource = 'explicit' | 'session' | 'default' | 'routed'

export interface AutoRouteDecision {
  /**
   * `route` — write to `scope`.
   * `refuse-shared` — the only eligible candidates were shared; the caller
   *   falls back to its unscoped default.
   * `no-match` — nothing cleared the gate at all.
   */
  action: 'route' | 'refuse-shared' | 'no-match'
  /** The scope to write to, or null when the caller should use its own default. */
  scope: string | null
  /** The candidate that decided the outcome — the one routed to, or the one refused. */
  candidate: ScopeCandidate | null
  /** The highest-ranked SHARED candidate that was passed over, when there was one. */
  refusedShared: ScopeCandidate | null
}

export interface DecideAutoRouteOptions {
  /** Confidence gate for non-forward-domain candidates. Default SCOPE_MATCH_THRESHOLD. */
  matchThreshold?: number
  /**
   * Opt in to routing an unscoped write into a shared scope. Default false.
   * Exists so an install that genuinely wants covers-driven team
   * routing can have it, deliberately and in writing, rather than by accident.
   */
  allowSharedScope?: boolean
  /**
   * Refuse a NON-shared candidate exactly
   * like a shared one — same `refuse-shared` action, same `refusedShared`
   * report. The write path passes "backed by a URL store AND not the user's
   * own `/me` namespace (or that identity is unknown)", so an unscoped write
   * reaches a remote personal scope only when it is the user's own. Applies
   * whatever `allowSharedScope` says: that opt-in governs shared scopes only.
   */
  refuseScope?: (scope: string) => boolean
}

/**
 * Pick the auto-route target from a ranked candidate list; the write path and suggestions
 * share it so they agree. A FORWARD domain match (`coverContainsDomain`) routes without the
 * confidence gate; everything else must clear `matchThreshold`.
 * A shared candidate is REFUSED unless the caller opted in (a remote push cannot be undone
 * locally); the search continues to the next eligible candidate unless `refuseScope`
 * rejects it. `refusedShared` reports the highest-ranked candidate passed over.
 */
export function decideAutoRoute(
  candidates: ScopeCandidate[],
  options: DecideAutoRouteOptions = {},
): AutoRouteDecision {
  const threshold = options.matchThreshold ?? SCOPE_MATCH_THRESHOLD
  const allowShared = options.allowSharedScope === true
  let refusedShared: ScopeCandidate | null = null
  let firstEligible: ScopeCandidate | null = null

  for (const candidate of candidates) {
    // The deterministic forward-domain bypass, then the threshold gate.
    if (!candidate.coverContainsDomain && !(candidate.confidence >= threshold)) continue
    if (!firstEligible) firstEligible = candidate
    const shared = isSharedScope(candidate.scope)
    if ((!allowShared && shared) || (!shared && options.refuseScope?.(candidate.scope) === true)) {
      if (!refusedShared) refusedShared = candidate
      continue
    }
    return { action: 'route', scope: candidate.scope, candidate, refusedShared }
  }

  if (refusedShared) {
    return { action: 'refuse-shared', scope: null, candidate: refusedShared, refusedShared }
  }
  return { action: 'no-match', scope: null, candidate: firstEligible, refusedShared: null }
}
