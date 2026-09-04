import type { Engram, Association, Temporal } from './schemas/engram.js'
import type { PackManifest } from './schemas/pack.js'
import type { LoadedPack } from './engrams.js'
import { decayedStrength, decayedCoAccessStrength, daysSince, confidenceDecay } from './decay.js'
import { classifyPolarity } from './polarity.js'
import { computeConfidence } from './confidence.js'
import { freshTailBoost } from './fresh-tail.js'
import { makeVisibilityPredicate } from './scope-util.js'

/**
 * D1-RECALL/INJECT-ASYMMETRY (#353). When an inject is given an EXPLICIT
 * `scopeFilter === 'global'`, the first branch of scoreEngram returns ONLY
 * `global`-scoped engrams — it is TARGETED global-namespace injection, NOT a
 * personal-family catch-all. This is intentionally narrower than a PROJECT-scope
 * filter, whose branch passes ALL personal-family scopes (`local`, `global`,
 * `user:*`, `agent:*`).
 *
 * This is an asymmetry with RECALL: an explicit `scope=global` RECALL returns
 * all personal-family engrams (because `isPersonalScope('global')` is true),
 * whereas an explicit `scope=global` INJECT returns only `global`. The asymmetry
 * is pre-existing for recall and DELIBERATELY kept for inject. A future change
 * that "fixes" this (makes global inject a personal-family catch-all) MUST rename
 * this constant so the intent is unmistakable. See the D1-ASYMMETRY tests.
 */
export const INJECT_GLOBAL_IS_TARGETED = true

export interface InjectionContext {
  prompt: string
  scope?: string
  /**
   * Mounted-scope visibility grants (#775): scopes from `config.yaml`
   * `stores:` entries. Engrams in these scopes pass the `scope` visibility
   * filter like the personal family. Visibility-only — never an
   * authorization widening; see `makeVisibilityPredicate` in scope-util.ts.
   */
  grantedScopes?: readonly string[]
  session_id?: string
  maxTokens?: number      // Default: 8000 (~10% of 80K context)
  minRelevance?: number   // Default: 0.3
}

export type ScoredEngram = Engram & {
  keyword_match: number
  raw_score: number
  score: number
}

export type AgentEngram = Omit<ScoredEngram, 'associations'>
export type WireEngram = Omit<AgentEngram, 'keyword_match' | 'raw_score' | 'score'> & {
  confidence_score: number
}

/** Injection layer for progressive disclosure (Idea 10) */
export type InjectionLayer = 1 | 2 | 3

export interface InternalInjectionResult {
  directives: WireEngram[]
  constraints: WireEngram[]
  consider: WireEngram[]
  tokens_used: { directives: number; consider: number }
  /** Eviction warnings for soft-tier pinned engrams that did not fit the budget. */
  eviction_warnings?: string[]
}

const DEFAULT_MAX_TOKENS = 8000
const DEFAULT_MIN_RELEVANCE = 0.3
const MAX_PER_PACK = 5
const MAX_PER_DOMAIN = 10
// Two-tier pinned budget (pinned-tier spec):
//   Hard tier: absolute ceiling, write-rejected on overflow — guaranteed injection.
//             At injection time, further clamped to PINNED_HARD_TOKEN_BUDGET_RATIO
//             of the session's maxTokens so the tier cannot starve the recall pool.
//   Soft tier: 30% of maxTokens, priority-ordered eviction.
// At 8K default: hard=min(2000,2000)=2000 + soft=2400 = 4400 pinned, ~3600 recall.
// At 2K default: hard=min(2000,500)=500 + soft=600 = 1100 pinned, ~900 recall.
/** Absolute write-time ceiling for hard-tier pinned engrams (aggregate across all). */
export const PINNED_HARD_TOKEN_CAP = 2000
/**
 * Per-engram write-time ceiling for hard-tier pinned engrams.
 * A single hard-tier engram that exceeds this limit is rejected at plur_learn time,
 * preventing a single oversized engram from dominating the aggregate hard-tier budget.
 * ChatGPT Pattern A analogue — hard cap at save time, no runtime eviction decisions.
 * Spike value: 200 tokens ≈ ~800 chars of statement + metadata overhead.
 */
export const PINNED_HARD_PER_ENGRAM_TOKEN_CAP = 200
/** Fraction of maxTokens that the hard tier may consume at injection time. */
const PINNED_HARD_TOKEN_BUDGET_RATIO = 0.25
/** Fraction of maxTokens allocated to soft-tier pinned engrams. */
const PINNED_SOFT_TOKEN_BUDGET_RATIO = 0.3

// DIP-0019 consider pool (bottom 1/3 of first-pass)
const DIP19_CONSIDER_MAX = 5
const DIP19_CONSIDER_BUDGET = 200

// --- Expiry handling (#347) ---

/**
 * Injection-time expiry policy (#347). `hard` (default) skips any engram
 * whose `temporal.valid_until` is in the past. `soft` keeps injecting a
 * recently-expired engram for `grace_days` days after expiry, rendered with
 * a loud "⚠ EXPIRED <date> — verify before use" marker.
 */
export interface ExpiryConfig {
  mode?: 'hard' | 'soft'
  grace_days?: number
}

const DEFAULT_GRACE_DAYS = 30

/**
 * True when the engram must be skipped for temporal validity. Not-yet-valid
 * engrams (`valid_from` in the future) are always skipped; expired engrams
 * are skipped in hard mode, and in soft mode once past the grace cutoff.
 */
function skipForValidity(
  engram: Engram,
  today: string,
  mode: 'hard' | 'soft',
  graceCutoff: string,
): boolean {
  const t = engram.temporal
  if (t?.valid_from && t.valid_from > today) return true
  if (t?.valid_until && t.valid_until < today) {
    if (mode !== 'soft') return true
    if (t.valid_until < graceCutoff) return true
  }
  return false
}

/**
 * "⚠ EXPIRED <date> — verify before use: " prefix for an engram whose
 * `valid_until` is in the past. Only soft-expiry mode lets expired engrams
 * reach the formatters, so in hard mode this never fires.
 */
function expiredMarker(engram: WireEngram): string {
  const until = engram.temporal?.valid_until
  if (until && until < new Date().toISOString().slice(0, 10)) {
    return `⚠ EXPIRED ${until} — verify before use: `
  }
  return ''
}

// --- Pack metadata helper ---

function getPackMetadata(manifest: PackManifest) {
  const meta = manifest['x-datacore'] || manifest.metadata
  return {
    injection_policy: meta?.injection_policy ?? 'on_match',
    match_terms: meta?.match_terms ?? [],
  }
}

// --- Token estimation ---

export function estimateTokens(engram: ScoredEngram): number {
  // Serialize wire-visible fields only (exclude scoring + associations)
  const { keyword_match: _km, raw_score: _rs, score: _s, associations: _a, ...wire } = engram
  const serialized = JSON.stringify(wire)
  return Math.ceil(serialized.length / 4)
}

/** Estimate token cost for a plain Engram (no scoring fields to strip). */
export function estimateEngramTokens(engram: Engram): number {
  const { associations: _, ...wire } = engram
  const serialized = JSON.stringify(wire)
  return Math.ceil(serialized.length / 4)
}

/**
 * Validate that a hard-tier pinned engram candidate does not exceed the per-engram
 * token cap. Called at plur_learn time so oversized engrams are rejected before
 * they are written, preventing a single engram from consuming the entire hard-tier
 * aggregate budget (PINNED_HARD_TOKEN_CAP) and making the budget unpredictable.
 *
 * ChatGPT Pattern A analogue: hard cap at save time, no runtime eviction decisions.
 *
 * @param candidate - The engram shape to check (need not be fully hydrated — must
 *   include at least statement and all metadata fields that will be stored).
 * @param cap - Token ceiling per engram. Defaults to PINNED_HARD_PER_ENGRAM_TOKEN_CAP.
 */
export function validatePinnedHardPerEngramCap(
  candidate: Engram,
  cap: number = PINNED_HARD_PER_ENGRAM_TOKEN_CAP,
): { ok: boolean; tokens: number; cap: number } {
  const tokens = estimateEngramTokens(candidate)
  return { ok: tokens <= cap, tokens, cap }
}

// --- Anchor boost ---

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter(w => w.length > 2))
}

export function anchorBoost(engram: Engram, taskWords: Set<string>): number {
  if (!engram.knowledge_anchors?.length) return 0

  const threshold = taskWords.size <= 1 ? 1 : 2
  let boost = 0

  for (const anchor of engram.knowledge_anchors) {
    if (!anchor.snippet) continue
    const snippetWords = tokenize(anchor.snippet)
    let overlap = 0
    for (const word of taskWords) {
      if (snippetWords.has(word)) overlap++
    }
    if (overlap >= threshold) boost += 0.5
  }

  return Math.min(boost, 2.0)
}

// --- Relations-to-associations converter ---
// Converts the legacy `relations` field into the new `associations` format.
// Used as fallback when engram.associations is empty but relations exists.

export function flattenRelations(engram: Engram): Association[] {
  if (!engram.relations) return []

  const associations: Association[] = []
  for (const id of engram.relations.broader) {
    associations.push({ target_type: 'engram', target: id, type: 'semantic', strength: 0.5 })
  }
  for (const id of engram.relations.narrower) {
    associations.push({ target_type: 'engram', target: id, type: 'semantic', strength: 0.5 })
  }
  for (const id of engram.relations.related) {
    associations.push({ target_type: 'engram', target: id, type: 'semantic', strength: 0.5 })
  }
  // Skip conflicts — they don't produce positive associations
  return associations
}

// --- Supersedes chain helpers ---

const HISTORICAL_KEYWORDS = ['before', 'was', 'prior', 'used to', 'previously', 'old', 'earlier', 'history', 'historical', 'legacy']

// Match keywords on WORD BOUNDARIES, not substrings (#481). Substring matching
// false-positived on common words: 'prior' ⊂ "priority"/"prioritize",
// 'old' ⊂ "hold"/"threshold"/"placeholder", 'was' ⊂ "wasm". A false positive
// SUPPRESSES the ×0.3 penalty on superseded engrams, injecting stale memory
// instead of the current tip. \b sits at every space↔word transition, so
// multi-word phrases like "used to" match correctly with a boundary at each end.
// The inter-word gap is matched as \s+ (not a literal space) so a phrase split
// by a newline, tab, or doubled space — "used\nto", "used  to" — still matches;
// hardcoding a single U+0020 there was a false-negative on multi-line prompts.
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const HISTORICAL_KEYWORD_PATTERNS = HISTORICAL_KEYWORDS.map(
  kw => new RegExp(`\\b${kw.split(/\s+/).map(escapeRegExp).join('\\s+')}\\b`),
)

function hasHistoricalIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  return HISTORICAL_KEYWORD_PATTERNS.some(re => re.test(lower))
}

function isSupersededEngram(engram: ScoredEngram): boolean {
  return (engram.relations?.superseded_by?.length ?? 0) > 0
}

// --- Strip pipeline ---

function stripAssociations(engram: ScoredEngram): AgentEngram {
  const { associations: _, ...rest } = engram
  return rest
}

function stripScoring(engram: AgentEngram): WireEngram {
  const { keyword_match: _, raw_score: _r, score: _s, ...rest } = engram
  return { ...rest, confidence_score: computeConfidence(engram) }
}

// --- Scoring ---

export function scoreEngram(
  engram: Engram,
  promptLower: string,
  promptWords: Set<string>,
  packMatchTerms: string[],
  scopeFilter: string | undefined,
  isPack: boolean,
  // Trailing optional so the post-#759 public signature stays non-breaking.
  grantedScopes?: readonly string[],
): number {
  // Scope filtering: if scope is specified, only include matching engrams
  if (scopeFilter) {
    if (scopeFilter === 'global') {
      // INJECT_GLOBAL_IS_TARGETED: explicit scope=global inject returns ONLY
      // global-scoped engrams — targeted global-namespace injection. The
      // personal-family pass-through below applies to PROJECT-scope filters
      // only; this branch predates D1 and is intentionally narrower than the
      // project branch (see INJECT_GLOBAL_IS_TARGETED JSDoc + D1-ASYMMETRY tests).
      // Mounted-scope grants (#775) deliberately do NOT reach this branch:
      // targeted-global stays global-only, grants or no grants.
      void INJECT_GLOBAL_IS_TARGETED
      if (engram.scope !== 'global') return 0
    } else if (!makeVisibilityPredicate(scopeFilter, grantedScopes)(engram.scope)) {
      // Visibility filter (#353/#775), ONE predicate for every in-memory call
      // site: personal-family scopes (local, global, user:*, agent:*, anything
      // not isSharedScope) always pass a project-scope filter, and so do
      // scopes granted by mounted `config.yaml` stores. Only SHARED scopes
      // matching neither the filter nor a grant are excluded.
      return 0
    }
  }

  let termHits = 0

  // Pack match terms (highest weight — curated relevance signals)
  for (const term of packMatchTerms) {
    if (promptLower.includes(term.toLowerCase())) termHits++
  }
  // Tag matches
  for (const tag of engram.tags) {
    if (promptWords.has(tag.toLowerCase())) termHits++
  }
  // Domain hierarchy matches (each level counts)
  if (engram.domain) {
    for (const part of engram.domain.split(/[./]/)) {
      if (promptWords.has(part.toLowerCase())) termHits++
    }
  }
  // Statement keyword overlap — word-boundary matching (lower weight)
  const statementWords = new Set(engram.statement.toLowerCase().split(/\W+/).filter(w => w.length > 2))
  for (const word of promptWords) {
    if (statementWords.has(word)) termHits += 0.5
  }

  // Pinned engrams bypass the term-hits gate. They get a baseline score
  // derived from retrieval strength alone so they remain eligible for
  // injection on every session, regardless of keyword overlap. Use the
  // pinned flag sparingly — meta-rules, safety conventions, core operating
  // principles. Per-pack/per-domain caps in fillTokenBudget still apply.
  const isPinned = (engram as any).pinned === true
  if (termHits === 0 && !isPinned) return 0
  if (termHits === 0 && isPinned) {
    // Synthetic minimal hit so downstream scoring math works
    termHits = 0.5
  }

  // Base score from term hits * (decayed) retrieval strength
  // Pack engrams use raw RS (read-only, can't track usage)
  let rs = isPack
    ? engram.activation.retrieval_strength
    : decayedStrength(engram.activation.retrieval_strength, daysSince(engram.activation.last_accessed))
  // Idea 21 (SP1): Additional confidence decay for engrams without recent feedback
  if (!isPack) {
    const fb = engram.feedback_signals
    const lastPositive = fb && fb.positive > 0 ? engram.activation.last_accessed : null
    rs = confidenceDecay(rs, lastPositive, (engram as any).commitment, undefined)
  }
  let score = termHits * rs

  // Feedback signal boost: positive feedback increases score, negative decreases
  const feedback = engram.feedback_signals
  if (feedback) {
    const netFeedback = feedback.positive - feedback.negative
    if (netFeedback > 0) score *= 1 + Math.min(netFeedback * 0.05, 0.3)
    else if (netFeedback < 0) score *= Math.max(1 + netFeedback * 0.1, 0.5)
  }

  // Consolidated engrams get a slight boost (survived reconsolidation)
  if (engram.consolidated) score *= 1.1

  // Pinned engrams get a sizeable boost so they reliably beat low-relevance
  // organic matches into the budget. Not infinite — they still compete with
  // other pinned + highly-relevant engrams.
  if (isPinned) score *= 2.0

  // Emotional weight multiplier: maps [1,10] to [0.84, 1.20], neutral at 5
  const emotionalWeight = engram.episodic?.emotional_weight ?? 5
  score *= 1 + (emotionalWeight - 5) * 0.04

  return score
}

// --- Token budget filler ---

export function fillTokenBudget(
  scored: ScoredEngram[],
  maxTokens: number,
): { selected: ScoredEngram[]; tokens_used: number; evicted_soft_pinned: ScoredEngram[] } {
  const result: ScoredEngram[] = []
  const packCounts = new Map<string, number>()
  const domainCounts = new Map<string, number>()
  let tokensUsed = 0
  const evicted_soft_pinned: ScoredEngram[] = []

  // Three-pass selection: hard-pinned first, then soft-pinned, then the rest.
  // Hard-tier: write-time ceiling = PINNED_HARD_TOKEN_CAP (2000); further clamped
  //            at injection time so the tier cannot exceed PINNED_HARD_TOKEN_BUDGET_RATIO
  //            of the session budget (prevents starvation when maxTokens = 2000).
  // Soft-tier: priority-ordered (pinned_priority DESC, learned_at ASC); evicted lowest-first.
  // All pinned items bypass per-pack/per-domain fairness caps.
  const allPinned = scored.filter(e => (e as any).pinned === true)
  const unpinned = scored.filter(e => (e as any).pinned !== true)

  const hardPinned = allPinned.filter(e => ((e as any).pinned_tier ?? 'soft') === 'hard')
  const softPinned = allPinned.filter(e => ((e as any).pinned_tier ?? 'soft') === 'soft')

  // Pass 1: hard-tier — clamped to the smaller of the write-time ceiling and the
  // session-proportional budget so the hard tier cannot starve the recall pool.
  const hardBudget = Math.min(PINNED_HARD_TOKEN_CAP, Math.floor(PINNED_HARD_TOKEN_BUDGET_RATIO * maxTokens))
  for (const engram of hardPinned) {
    const cost = estimateTokens(engram)
    if (tokensUsed + cost > hardBudget) continue
    if (tokensUsed + cost > maxTokens) continue
    result.push(engram)
    tokensUsed += cost
    const pack = engram.pack ?? '__personal__'
    packCounts.set(pack, (packCounts.get(pack) ?? 0) + 1)
    const topDomain = (engram.domain ?? '__none__').split('.')[0]
    domainCounts.set(topDomain, (domainCounts.get(topDomain) ?? 0) + 1)
  }

  // Pass 2: soft-tier — sorted by pinned_priority DESC, then learned_at ASC (FIFO tie-break)
  const softBudget = Math.floor(maxTokens * PINNED_SOFT_TOKEN_BUDGET_RATIO)
  let softTokensUsed = 0
  const sortedSoft = softPinned.slice().sort((a, b) => {
    const pa = (a as any).pinned_priority ?? 50
    const pb = (b as any).pinned_priority ?? 50
    if (pb !== pa) return pb - pa
    const la: string = (a as any).temporal?.learned_at ?? ''
    const lb: string = (b as any).temporal?.learned_at ?? ''
    return la < lb ? -1 : la > lb ? 1 : 0
  })
  for (const engram of sortedSoft) {
    const cost = estimateTokens(engram)
    if (softTokensUsed + cost > softBudget || tokensUsed + cost > maxTokens) {
      evicted_soft_pinned.push(engram)
      continue
    }
    result.push(engram)
    tokensUsed += cost
    softTokensUsed += cost
    const pack = engram.pack ?? '__personal__'
    packCounts.set(pack, (packCounts.get(pack) ?? 0) + 1)
    const topDomain = (engram.domain ?? '__none__').split('.')[0]
    domainCounts.set(topDomain, (domainCounts.get(topDomain) ?? 0) + 1)
  }

  // Pass 3: relevance-scored engrams, subject to fairness caps
  for (const engram of unpinned) {
    const cost = estimateTokens(engram)
    if (tokensUsed + cost > maxTokens) continue

    const pack = engram.pack ?? '__personal__'
    const packCount = packCounts.get(pack) ?? 0
    if (packCount >= MAX_PER_PACK && pack !== '__personal__') continue

    const domain = engram.domain ?? '__none__'
    const topDomain = domain.split('.')[0]
    const domainCount = domainCounts.get(topDomain) ?? 0
    if (domainCount >= MAX_PER_DOMAIN) continue

    result.push(engram)
    tokensUsed += cost
    packCounts.set(pack, packCount + 1)
    domainCounts.set(topDomain, domainCount + 1)
  }
  return { selected: result, tokens_used: tokensUsed, evicted_soft_pinned }
}

// --- Eviction warning builder ---

function buildEvictionWarnings(evicted: ScoredEngram[], maxTokens: number): string[] | undefined {
  if (evicted.length === 0) return undefined
  const softBudget = Math.floor(maxTokens * PINNED_SOFT_TOKEN_BUDGET_RATIO)
  const evictedList = evicted
    .map(e => `${e.id} (priority ${(e as any).pinned_priority ?? 50}, ${estimateTokens(e)} tokens)`)
    .join(', ')
  return [
    `[SOFT-TIER EVICTION] ${evicted.length} soft-pinned engram(s) evicted ` +
    `(budget: ${softBudget} tokens). ` +
    `Evicted: ${evictedList}. ` +
    `To protect: raise pinned_priority above 50, or promote to hard tier if truly critical.`,
  ]
}

// --- Main injection function ---

export function selectAndSpread(
  ctx: InjectionContext,
  personalEngrams: Engram[],
  packs: LoadedPack[],
  config?: { spread_cap?: number; spread_budget?: number; expiry?: ExpiryConfig },
  embeddingBoosts?: Map<string, number>,
): InternalInjectionResult {
  const spreadCap = config?.spread_cap ?? 3
  const spreadBudget = config?.spread_budget ?? 480

  const promptLower = ctx.prompt.toLowerCase()
  const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 2))
  const maxTokens = ctx.maxTokens ?? DEFAULT_MAX_TOKENS
  const minRelevance = ctx.minRelevance ?? DEFAULT_MIN_RELEVANCE
  const today = new Date().toISOString().slice(0, 10)
  const expiryMode = config?.expiry?.mode ?? 'hard'
  const graceDays = config?.expiry?.grace_days ?? DEFAULT_GRACE_DAYS
  const graceCutoff = new Date(Date.now() - graceDays * 86400000).toISOString().slice(0, 10)

  // Step 0: Build engram map for spreading activation
  const engramMap = new Map<string, Engram>()

  // Step 1-2: Score all active engrams
  const scored: ScoredEngram[] = []

  for (const engram of personalEngrams) {
    if (engram.status !== 'active') continue
    if (skipForValidity(engram, today, expiryMode, graceCutoff)) continue
    engramMap.set(engram.id, engram)
    let raw = scoreEngram(engram, promptLower, promptWords, [], ctx.scope, false, ctx.grantedScopes)
    // Embedding boost: semantically similar engrams with zero keyword hits still get scored.
    // Threshold raised from 0.3 -> 0.5 in 0.9.4 — with embeddings now actually running
    // (post-build-config fix), 0.3 was too generous and surfaced spurious matches between
    // unrelated short English sentences. 0.5 is a typical BGE-small threshold for
    // "actually related". Keyword+semantic matches still get the additive bonus regardless.
    const embBoost = embeddingBoosts?.get(engram.id) ?? 0
    if (raw === 0 && embBoost > 0.5) {
      raw = embBoost * 2 // semantic-only signal, scaled to be comparable with keyword scores
    } else if (raw > 0 && embBoost > 0) {
      raw += embBoost // additive boost for keyword+semantic match
    }
    // Fresh tail boost (Idea 13): recently created engrams get a retrieval strength boost
    if (raw > 0) {
      const createdAt = engram.temporal?.learned_at ?? engram.activation.last_accessed
      const ftBoost = freshTailBoost(createdAt, (engram as any).commitment, new Date())
      if (ftBoost > 0) raw += ftBoost
    }
    if (raw > 0) {
      scored.push({ ...engram, keyword_match: raw, raw_score: raw, score: raw })
    }
  }

  for (const pack of packs) {
    const packMeta = getPackMetadata(pack.manifest)
    if (packMeta.injection_policy === 'on_request') continue
    const matchTerms = packMeta.match_terms
    for (const engram of pack.engrams) {
      if (engram.status !== 'active') continue
      if (skipForValidity(engram, today, expiryMode, graceCutoff)) continue
      engramMap.set(engram.id, engram)
      let raw = scoreEngram(engram, promptLower, promptWords, matchTerms, ctx.scope, true, ctx.grantedScopes)
      const embBoost = embeddingBoosts?.get(engram.id) ?? 0
      if (raw === 0 && embBoost > 0.5) {
        raw = embBoost * 2
      } else if (raw > 0 && embBoost > 0) {
        raw += embBoost
      }
      if (raw > 0) {
        // Stamp `_pack` so the pack name survives stripAssociations/stripScoring into
        // WireEngram — the telemetry loop in _inject reads `_pack` to bucket
        // pack_counts. The corpus path no longer carries these rows (filtered by the
        // #901 fix), so the stamp must come from the pack loop instead.
        const scored_entry = { ...engram, keyword_match: raw, raw_score: raw, score: raw } as any
        scored_entry._pack = pack.manifest.name
        scored.push(scored_entry)
      }
    }
  }

  // Step 3: Normalize keyword_match to [0,10] (all scored engrams, not yet filtered)
  const maxKm = Math.max(...scored.map(e => e.keyword_match), 1)
  for (const e of scored) {
    e.keyword_match = (e.keyword_match / maxKm) * 10
  }

  // Step 4: Compute score with anchor boost
  // Scan 1: compute keyword_match + anchorBoost for all engrams
  const aBoosts = new Map<string, number>()
  for (const e of scored) {
    const aBoost = anchorBoost(e, promptWords)
    aBoosts.set(e.id, aBoost)
    e.score = e.keyword_match + aBoost
  }

  // Step 5: Filter by minimum relevance.
  // Pinned engrams bypass the relevance gate — that is the whole contract of
  // pinning. Without this exemption, a session with strong personal-engram
  // matches normalizes pinned scores below DEFAULT_MIN_RELEVANCE (0.3) and
  // the pinned engram is silently dropped before fillTokenBudget sees it.
  const filtered = scored.filter(s => (s as any).pinned === true || s.score >= minRelevance)

  // Sort by score descending
  filtered.sort((a, b) => b.score - a.score)

  // Supersedes chain preference: under budget pressure, tip beats older members
  if (!hasHistoricalIntent(ctx.prompt)) {
    for (const e of filtered) {
      if (isSupersededEngram(e)) {
        e.score *= 0.3
      }
    }
    filtered.sort((a, b) => b.score - a.score)
  }

  // Step 6: Fill directive token budget
  const { selected: directives, tokens_used: directiveTokens, evicted_soft_pinned } = fillTokenBudget(filtered, maxTokens)
  const directiveIds = new Set(directives.map(e => e.id))

  // DIP-0019 consider pool: next candidates that didn't fit as directives
  // Respect pack diversity: exclude packs already at their cap in directives
  const directivePackCounts = new Map<string, number>()
  for (const e of directives) {
    const pack = e.pack ?? '__personal__'
    directivePackCounts.set(pack, (directivePackCounts.get(pack) ?? 0) + 1)
  }
  const dip19Remainder = filtered.filter(e => {
    if (directiveIds.has(e.id)) return false
    const pack = e.pack ?? '__personal__'
    if (pack !== '__personal__' && (directivePackCounts.get(pack) ?? 0) >= MAX_PER_PACK) return false
    return true
  })
  const { selected: dip19Consider } = fillTokenBudget(
    dip19Remainder, DIP19_CONSIDER_BUDGET,
  )
  // Cap at DIP19_CONSIDER_MAX and correct token count
  const dip19Pool = dip19Consider.slice(0, DIP19_CONSIDER_MAX)
  const dip19PoolTokens = dip19Pool.reduce((acc, e) => acc + estimateTokens(e), 0)

  // Build soft-tier eviction warning (computed before the early-exit guard so
  // callers see it even when all engrams were evicted and the result is empty).
  const builtEvictionWarnings = buildEvictionWarnings(evicted_soft_pinned, maxTokens)

  // Step 7-8: Guard empty
  if (directives.length === 0 && dip19Pool.length === 0) {
    return {
      directives: [],
      constraints: [],
      consider: [],
      tokens_used: { directives: 0, consider: 0 },
      ...(builtEvictionWarnings ? { eviction_warnings: builtEvictionWarnings } : {}),
    }
  }

  const maxFirstPass = Math.max(...directives.map(e => e.score), 1)

  // Steps 9-13: Spreading activation
  const visited = new Set(directives.map(e => e.id))
  for (const e of dip19Pool) visited.add(e.id)

  const spreadCandidates: ScoredEngram[] = []
  let spreadTokens = 0

  for (const directive of directives) {
    // Get associations (fall back to converting relations if associations empty)
    const assocs = directive.associations?.length
      ? directive.associations
      : flattenRelations(directive)

    for (const assoc of assocs) {
      if (assoc.target_type !== 'engram') continue
      if (visited.has(assoc.target)) continue

      const target = engramMap.get(assoc.target)
      if (!target || target.status !== 'active') continue

      // Apply decay to co_accessed associations at read time
      const effectiveStrength = assoc.type === 'co_accessed' && assoc.updated_at
        ? decayedCoAccessStrength(assoc.strength, daysSince(assoc.updated_at))
        : assoc.strength
      if (effectiveStrength <= 0) continue

      // Compute spread score
      const spreadScore = (directive.score / maxFirstPass) * effectiveStrength
      if (spreadScore < minRelevance * 0.5) continue

      const spreadEngram: ScoredEngram = {
        ...target,
        keyword_match: 0,
        raw_score: 0,
        score: spreadScore,
      }

      const cost = estimateTokens(spreadEngram)
      if (spreadTokens + cost > spreadBudget) continue
      if (spreadCandidates.length >= spreadCap) break

      spreadCandidates.push(spreadEngram)
      spreadTokens += cost
      visited.add(assoc.target)
    }
  }

  // Merge consider pools: DIP-0019 bottom-1/3 + spreading activation
  const allConsider = [...dip19Pool, ...spreadCandidates]

  // Steps 14-15: Strip pipeline
  const agentDirectives = directives.map(stripAssociations)
  const agentConsider = allConsider.map(stripAssociations)

  const wireAll = agentDirectives.map(stripScoring)
  const wireConsider = agentConsider.map(stripScoring)

  // Auto-classify polarity, apply cognitive_level routing (SP1 Idea 5) and commitment scoring (SP1 Idea 6)
  const wireDirectives: WireEngram[] = []
  const wireConstraints: WireEngram[] = []
  const cognitiveDemoted: WireEngram[] = []
  for (const wire of wireAll) {
    const polarity = wire.polarity ?? classifyPolarity(wire.statement)
    // Idea 6: Apply commitment multiplier to confidence score
    const commitment = (wire as any).commitment as string | undefined
    if (commitment) {
      const mult: Record<string, number> = { locked: 1.0, decided: 0.9, leaning: 0.7, exploring: 0.5 }
      wire.confidence_score *= mult[commitment] ?? 1.0
    }
    // Idea 5: Cognitive level bucket routing
    const cogLevel = (wire as any).knowledge_type?.cognitive_level as string | undefined
    if (cogLevel === 'remember' || cogLevel === 'understand') {
      cognitiveDemoted.push(wire)
    } else if (polarity === 'dont') {
      wireConstraints.push(wire)
    } else if (cogLevel === 'apply' || cogLevel === 'analyze') {
      wireConstraints.push(wire)
    } else {
      wireDirectives.push(wire)
    }
  }

  const allWireConsider = [...wireConsider, ...cognitiveDemoted]
  const considerTokens = dip19PoolTokens + spreadTokens

  return {
    directives: wireDirectives,
    constraints: wireConstraints,
    consider: allWireConsider,
    tokens_used: { directives: directiveTokens, consider: considerTokens },
    ...(builtEvictionWarnings ? { eviction_warnings: builtEvictionWarnings } : {}),
  }
}

// --- Progressive Disclosure (Idea 10) ---

export function formatLayer1(engram: WireEngram): string {
  const display = (engram as any).summary ?? engram.statement.slice(0, 60)
  return `[${engram.id}] ${expiredMarker(engram)}${display}`
}

export function formatLayer2(engram: WireEngram): string {
  return `[${engram.id}] ${expiredMarker(engram)}${engram.statement}`
}

export function formatLayer3(engram: WireEngram): string {
  const lines = [`[${engram.id}] ${expiredMarker(engram)}${engram.statement}`]
  if (engram.rationale) lines.push(`  Rationale: ${engram.rationale}`)
  const meta: string[] = []
  if (engram.domain) meta.push(`Domain: ${engram.domain}`)
  // #348: commitment (a decision-state ladder: exploring→leaning→decided→locked)
  // and confidence (epistemic certainty, a float) are ORTHOGONAL. Previously
  // commitment was rendered under the `Confidence:` label and the numeric score
  // was discarded, so a shaky fact (confidence 0.12) marked `locked` read as
  // maximally certain in the highest-authority directives block. Show both as
  // distinct fields; never overwrite one with the other.
  const commitment = (engram as any).commitment as string | undefined
  if (commitment) meta.push(`Commitment: ${commitment}`)
  if (engram.confidence_score != null) meta.push(`Confidence: ${engram.confidence_score.toFixed(2)}`)
  if (engram.activation?.last_accessed) meta.push(`Last verified: ${engram.activation.last_accessed}`)
  if (meta.length > 0) lines.push(`  ${meta.join(' | ')}`)
  return lines.join('\n')
}

export function assignLayer(bucket: 'directives' | 'constraints' | 'consider'): InjectionLayer {
  switch (bucket) {
    case 'directives': return 3
    case 'constraints': return 2
    case 'consider': return 1
  }
}

export function formatWithLayer(engrams: WireEngram[], layer: InjectionLayer): string {
  if (engrams.length === 0) return ''
  switch (layer) {
    case 1: return engrams.map(formatLayer1).join(' | ')
    case 2: return engrams.map(formatLayer2).join('\n')
    case 3: return engrams.map(formatLayer3).join('\n')
  }
}

// --- Public wrapper functions for Plur class ---

export interface PublicScoredEngram { engram: Engram; score: number }

export function scoreEngramsPublic(
  engrams: Engram[],
  task: string,
  options?: { scope?: string; grantedScopes?: readonly string[] },
): PublicScoredEngram[] {
  const promptLower = task.toLowerCase()
  const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 2))
  return engrams.map(e => ({
    engram: e,
    score: scoreEngram(e, promptLower, promptWords, [], options?.scope, false, options?.grantedScopes),
  })).sort((a, b) => b.score - a.score)
}
