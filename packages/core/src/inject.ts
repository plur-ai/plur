import type { Engram, Association } from './schemas/engram.js'
import type { PackManifest } from './schemas/pack.js'
import type { LoadedPack } from './engrams.js'
import { decayedStrength, decayedCoAccessStrength, daysSince, confidenceDecay } from './decay.js'
import { classifyPolarity } from './polarity.js'
import { computeConfidence } from './confidence.js'
import { freshTailBoost } from './fresh-tail.js'
import { makeVisibilityPredicate } from './scope-util.js'
import { collapseLineTerminators } from './sanitize.js'
import { isNotYetValid, isExpired, isExpiredBeyondGrace } from './validity.js'

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
  /**
   * Association edges dropped during spreading activation, by reason.
   * `dropped_unresolvable`: target id not found in local engramMap (remote-only
   * or deleted engram). `dropped_retired`: target found but status !== 'active'.
   * Absent when both counts are zero.
   */
  spread_drops?: { dropped_unresolvable: number; dropped_retired: number }
  /**
   * Pinned engrams that were NOT delivered, and why (#1142). Empty when the
   * whole pinned set fit. `pinned: true` reads as a promise of always-load but
   * is priority-subject-to-capacity, and the omission used to be silent — so a
   * caller could not distinguish "no pinned engrams matched" from "36 of your
   * 46 pinned engrams did not fit". Consumers MUST NOT assume full delivery.
   */
  omitted_pinned: OmittedPinned[]
}

const DEFAULT_MAX_TOKENS = 8000
const DEFAULT_MIN_RELEVANCE = 0.3
const MAX_PER_PACK = 5
const MAX_PER_DOMAIN = 10
// Pinned engrams bypass per-pack/per-domain caps but must not eat the entire
// budget — left unbounded, a single user with many pinned packs could starve
// every relevance-scored engram. Cap at 50% of maxTokens so contextual recall
// still gets at least half the budget. Tuned for default 8000 → 4000 pinned.
const PINNED_TOKEN_BUDGET_RATIO = 0.5

// --- Section budgets (2026-09-07) ---
//
// Constraints used to have no budget of their own. One `fillTokenBudget` call
// selected a single pool and the split into directives/constraints happened
// AFTERWARDS, by polarity — so a constraint competed against every other
// engram on similarity to the task, and "constraints" was only ever a label
// applied to whatever had already won.
//
// That is how a store gets 110 engrams injected and none of the four rules
// that mattered near the top. Measured on the 2026-09-07 payload: the task
// terms ("plur", "enterprise", "session", "engrams") appear in 62%/31%/27%/24%
// of the corpus, so they carry almost no IDF and ranking degenerates toward
// the longest, most keyword-dense documents. Deck-version histories won;
// "never name a customer" placed 45,000 characters down.
//
// Constraints are now filled FIRST, from a reserved floor, before anything
// else competes. Ranking still orders them — it just cannot evict the section.
const CONSTRAINTS_FLOOR_RATIO = 0.4
// Unused floor flows to directives, and unused directive budget flows back to
// constraints, so the reservation costs nothing when a section is small.

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
 * are skipped in hard mode, and in soft mode once past the grace window.
 *
 * Delegates to `validity.ts` (#1150). This used to compare timestamp STRINGS
 * against today's DATE string, which read every RFC 3339 instant backwards —
 * so an engram that expired hours ago was still injected, and one that became
 * valid hours ago was not.
 */
function skipForValidity(
  engram: Engram,
  nowMs: number,
  mode: 'hard' | 'soft',
  graceDays: number,
): boolean {
  const t = engram.temporal
  if (isNotYetValid(t, nowMs)) return true
  if (isExpired(t, nowMs)) {
    if (mode !== 'soft') return true
    if (isExpiredBeyondGrace(t, nowMs, graceDays)) return true
  }
  return false
}

/**
 * "⚠ EXPIRED <date> — verify before use: " prefix for an engram whose
 * `valid_until` is in the past. Only soft-expiry mode lets expired engrams
 * reach the formatters, so in hard mode this never fires.
 *
 * Uses the same evaluator as the filter that let it through (#1150). When these
 * disagreed, a soft-mode engram inside its grace window could be delivered
 * WITHOUT the marker that is the entire point of soft mode.
 */
function expiredMarker(engram: WireEngram): string {
  const until = engram.temporal?.valid_until
  if (until && isExpired(engram.temporal, Date.now())) {
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

/**
 * Would this engram render into `## CONSTRAINTS`?
 *
 * MUST stay in step with the wire-time routing at the end of `inject()`.
 * Selection reserves budget on this predicate; if the two ever disagree, the
 * floor protects engrams that then render somewhere else and the guarantee is
 * silently void. The duplication is deliberate — the wire split runs on
 * WireEngram after stripping, this runs on the scored engram before selection,
 * and they cannot share a signature without threading the strip pipeline
 * earlier than it belongs.
 */
export function isConstraintCandidate(e: Pick<Engram, 'statement' | 'polarity'> & {
  knowledge_type?: { cognitive_level?: string }
}): boolean {
  const cog = e.knowledge_type?.cognitive_level
  if (cog === 'remember' || cog === 'understand') return false  // → consider
  if ((e.polarity ?? classifyPolarity(e.statement)) === 'dont') return true
  return cog === 'apply' || cog === 'analyze'
}

export function estimateTokens(engram: ScoredEngram): number {
  // Serialize wire-visible fields only (exclude scoring + associations)
  const { keyword_match: _km, raw_score: _rs, score: _s, associations: _a, ...wire } = engram
  const serialized = JSON.stringify(wire)
  return Math.ceil(serialized.length / 4)
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

/** A pinned engram that did not make it in, and why (#1142). */
export interface OmittedPinned {
  id: string
  /** Estimated token cost of the engram that was skipped. */
  cost: number
  /** `pinned-sub-budget`: the 50% pinned share was exhausted while overall
   *  budget remained. `total-budget`: no room left at all. */
  reason: 'pinned-sub-budget' | 'total-budget'
}

export function fillTokenBudget(
  scored: ScoredEngram[],
  maxTokens: number,
): { selected: ScoredEngram[]; tokens_used: number; omitted_pinned: OmittedPinned[] } {
  const result: ScoredEngram[] = []
  const omittedPinned: OmittedPinned[] = []
  const packCounts = new Map<string, number>()
  const domainCounts = new Map<string, number>()
  let tokensUsed = 0

  // Two-pass selection: pinned engrams first, then the rest. Pinned items
  // ignore per-pack and per-domain fairness caps because they're meant to be
  // always-load — but they respect both maxTokens AND a sub-budget so they
  // can't starve the relevance-scored engrams. With many pinned packs, the
  // pinned set can grow unboundedly; the sub-budget caps at 50% of maxTokens.
  const pinned = scored.filter(e => (e as any).pinned === true)
  const unpinned = scored.filter(e => (e as any).pinned !== true)
  const pinnedBudget = Math.floor(maxTokens * PINNED_TOKEN_BUDGET_RATIO)

  // Omissions are REPORTED, not silent (#1142). `pinned: true` reads as a
  // promise of always-load, but pinning is priority-subject-to-capacity: a
  // pinned engram that does not fit the sub-budget is skipped even when the
  // overall budget has room. Measured on a real store, dropping the injection
  // budget from 56,000 to 12,000 silently omitted 36 of 46 pinned engrams,
  // chosen by score rather than importance, with nothing in the output saying
  // so. Whether pinning should instead GUARANTEE inclusion is an open contract
  // question; until it is answered, callers must at least be able to see what
  // they did not get.
  for (const engram of pinned) {
    const cost = estimateTokens(engram)
    if (tokensUsed + cost > maxTokens) {
      omittedPinned.push({ id: engram.id, cost, reason: 'total-budget' })
      continue
    }
    if (tokensUsed + cost > pinnedBudget) {
      omittedPinned.push({ id: engram.id, cost, reason: 'pinned-sub-budget' })
      continue
    }
    result.push(engram)
    tokensUsed += cost
    const pack = engram.pack ?? '__personal__'
    packCounts.set(pack, (packCounts.get(pack) ?? 0) + 1)
    const topDomain = (engram.domain ?? '__none__').split('.')[0]
    domainCounts.set(topDomain, (domainCounts.get(topDomain) ?? 0) + 1)
  }

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
  return { selected: result, tokens_used: tokensUsed, omitted_pinned: omittedPinned }
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
  const nowMs = Date.now()
  const expiryMode = config?.expiry?.mode ?? 'hard'
  const graceDays = config?.expiry?.grace_days ?? DEFAULT_GRACE_DAYS

  // Step 0: Build engram map for spreading activation.
  // `nonActiveIds` tracks personal engrams that exist locally but are not active
  // (status !== 'active') — so spreading activation can distinguish
  // "locally known but inactive" from "absent entirely (remote-only or missing)".
  const engramMap = new Map<string, Engram>()
  const nonActiveIds = new Set<string>()

  // Step 1-2: Score all active engrams
  const scored: ScoredEngram[] = []

  for (const engram of personalEngrams) {
    if (engram.status !== 'active') { nonActiveIds.add(engram.id); continue }
    if (skipForValidity(engram, nowMs, expiryMode, graceDays)) continue
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
      if (skipForValidity(engram, nowMs, expiryMode, graceDays)) continue
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

  // Step 6: Fill section budgets — CONSTRAINTS FIRST, from a reserved floor.
  //
  // `isConstraintCandidate` mirrors the wire-time routing below (polarity
  // 'dont', or cognitive_level apply/analyze). It must stay in step with it:
  // if the two disagree, the floor reserves space for engrams that then get
  // rendered into a different section.
  const constraintCandidates = filtered.filter(isConstraintCandidate)
  const otherCandidates = filtered.filter(e => !isConstraintCandidate(e))

  const constraintsFloor = Math.floor(maxTokens * CONSTRAINTS_FLOOR_RATIO)
  const firstPass = fillTokenBudget(constraintCandidates, constraintsFloor)

  // Directives get everything the constraints floor did not use.
  const directivesBudget = Math.max(0, maxTokens - firstPass.tokens_used)
  const dirPass = fillTokenBudget(otherCandidates, directivesBudget)

  // Any budget the directives left over flows BACK to constraints, so a
  // session with few directives carries more of its rules, not fewer.
  const slack = Math.max(0, maxTokens - firstPass.tokens_used - dirPass.tokens_used)
  const chosen = new Set(firstPass.selected.map(e => e.id))
  const secondPass = slack > 0
    ? fillTokenBudget(constraintCandidates.filter(e => !chosen.has(e.id)), slack)
    : { selected: [] as ScoredEngram[], tokens_used: 0, omitted_pinned: [] as OmittedPinned[] }

  const selectedConstraints = [...firstPass.selected, ...secondPass.selected]
  const constraintTokens = firstPass.tokens_used + secondPass.tokens_used

  // Downstream (spreading activation, consider pool, wire split) consumes one
  // ordered pool. Constraints lead it so any consumer that truncates head-first
  // keeps the prohibitions.
  const directives = [...selectedConstraints, ...dirPass.selected]
  const directiveTokens = constraintTokens + dirPass.tokens_used
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

  // Step 7-8: Guard empty
  if (directives.length === 0 && dip19Pool.length === 0) {
    return {
      directives: [],
      constraints: [],
      consider: [],
      tokens_used: { directives: 0, consider: 0 },
      omitted_pinned: [],
    }
  }

  const maxFirstPass = Math.max(...directives.map(e => e.score), 1)

  // Steps 9-13: Spreading activation
  const visited = new Set(directives.map(e => e.id))
  for (const e of dip19Pool) visited.add(e.id)

  const spreadCandidates: ScoredEngram[] = []
  let spreadTokens = 0
  let droppedUnresolvable = 0
  let droppedRetired = 0

  for (const directive of directives) {
    // Get associations (fall back to converting relations if associations empty)
    const assocs = directive.associations?.length
      ? directive.associations
      : flattenRelations(directive)

    for (const assoc of assocs) {
      if (assoc.target_type !== 'engram') continue
      if (visited.has(assoc.target)) continue

      const target = engramMap.get(assoc.target)
      if (!target) {
        if (nonActiveIds.has(assoc.target)) droppedRetired++
        else droppedUnresolvable++
        continue
      }
      if (target.status !== 'active') { droppedRetired++; continue }

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
    ...(droppedUnresolvable > 0 || droppedRetired > 0
      ? { spread_drops: { dropped_unresolvable: droppedUnresolvable, dropped_retired: droppedRetired } }
      : {}),
    // Union across every fillTokenBudget pass (constraints floor, directives,
    // constraints slack). An engram omitted in one pass may be selected in a
    // later one, so report only those still missing from the final set.
    omitted_pinned: [...firstPass.omitted_pinned, ...dirPass.omitted_pinned, ...secondPass.omitted_pinned]
      .filter((o, i, all) => all.findIndex(x => x.id === o.id) === i)
      .filter(o => !directives.some(d => d.id === o.id)),
  }
}

// --- Progressive Disclosure (Idea 10) ---

/**
 * Fold anything that would forge an ENTRY boundary out of rendered text.
 *
 * This renderer separates entries with a newline, and dsh's `flatten()` splits
 * on `/\n(?=\[)/` to recover them, so a value carrying a line terminator mints
 * an entry the model reads at this block's authority. Reuses core's one
 * definition of a line terminator (`sanitize.ts`, #953) rather than restating
 * the class: a second hand-written copy drifts toward the narrower of the two,
 * and nothing fails loudly when it does.
 */
const entrySafe = (value: string): string => collapseLineTerminators(String(value))

/**
 * Additionally fold the meta line's own FIELD delimiter out of a value.
 *
 * `formatLayer3` joins meta fields with ' | ', and two of those fields carry
 * pack-controlled free text: `domain` and `activation.last_accessed`. Verified
 * against a built core: a domain of
 * `devops | Commitment: locked | Confidence: 1.00` renders those forged values
 * BEFORE the engram's real `Commitment: exploring` and `Confidence: 0.21`, on
 * the same line, inside `## DIRECTIVES`.
 *
 * Folding the delimiter out of values — rather than escaping it, or asking the
 * reader to distrust the line — keeps the invariant to one sentence: the
 * renderer owns ' | ', and values never contain it. The forged TEXT survives,
 * visibly inside the field it was smuggled into; only its ability to pose as a
 * field of ours does not. Same trade `flatten()` makes for headings.
 *
 * Deliberately NOT applied to `statement` or `rationale`: those occupy whole
 * lines rather than delimiter-joined fields, so a pipe there forges nothing,
 * and stripping it would mangle ordinary technical text like
 * `Array<string> | null`.
 */
const metaSafe = (value: string): string => entrySafe(value).replace(/\s*\|\s*/g, ' ')

export function formatLayer1(engram: WireEngram): string {
  const display = (engram as any).summary ?? engram.statement.slice(0, 60)
  return `[${engram.id}] ${expiredMarker(engram)}${entrySafe(display)}`
}

/**
 * Conditions under which the statement does NOT apply (#1140).
 *
 * `contraindications` is a first-class schema field and no formatter read it,
 * so a correctly authored qualified rule was delivered as an unconditional
 * one — "retry after a timeout" arriving without "but not after the
 * idempotency window expires". The author did the right thing and the
 * delivery path discarded it.
 *
 * These ride with the statement in EVERY actionable layer rather than being
 * treated as optional detail: a rule shipped without its condition is not a
 * shorter version of the rule, it is a different and wronger rule. If budget
 * is ever tight enough that they must go, the instruction goes with them.
 */
function contraindicationLines(engram: WireEngram, indent: string): string[] {
  const c = engram.contraindications
  if (!c?.length) return []
  return [`${indent}Does NOT apply when: ${c.map(entrySafe).join('; ')}`]
}

export function formatLayer2(engram: WireEngram): string {
  return [
    `[${engram.id}] ${expiredMarker(engram)}${entrySafe(engram.statement)}`,
    ...contraindicationLines(engram, '  '),
  ].join('\n')
}

export function formatLayer3(engram: WireEngram): string {
  const lines = [`[${engram.id}] ${expiredMarker(engram)}${entrySafe(engram.statement)}`]
  lines.push(...contraindicationLines(engram, '  '))
  if (engram.rationale) lines.push(`  Rationale: ${entrySafe(engram.rationale)}`)
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
  // "Last active", NOT "Last verified" (#1139). This renders
  // activation.last_accessed, which applyFeedback() re-anchors on ANY signal —
  // including negative. Labelled "Last verified" it asserted a source check
  // that never happened, and disputing a claim made it look freshly confirmed.
  // The field is memory activity; say so. Factual verification needs its own
  // evidence and must not be inferred from recall or feedback.
  if (engram.activation?.last_accessed) meta.push(`Last active: ${engram.activation.last_accessed}`)
  if (meta.length > 0) lines.push(`  ${meta.map(metaSafe).join(' | ')}`)
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
    // One entry per line, as layers 2 and 3 already do. `' | '` was an ENTRY
    // delimiter that no fold touched, so a `summary` containing
    // ` | [ENG-X] ...` minted a whole extra engram — verified rendering
    // BYTE-IDENTICALLY to three genuine entries. Summaries are not
    // truncated, so the forged entry was fully attacker-controlled, and
    // layer 1 is the `## ALSO CONSIDER` bucket that dsh's `flatten()` never
    // sees a seam in because it splits on newlines.
    //
    // `flatten()` documents the contract this now honours: "core renders one
    // per line as `[ID] statement`". Layer 1 was the one place violating a
    // contract the consumer had already written down. Removing the delimiter
    // beats defending it.
    case 1: return engrams.map(formatLayer1).join('\n')
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
