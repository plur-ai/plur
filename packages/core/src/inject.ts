import type { Engram, Association } from './schemas/engram.js'
import type { PackManifest } from './schemas/pack.js'
import { parseNamespacedId, legacyPackEngramId, type LoadedPack } from './engrams.js'
import { decayedStrength, decayedCoAccessStrength, daysSince, confidenceDecay } from './decay.js'
import { classifyPolarity } from './polarity.js'
import { computeConfidence } from './confidence.js'
import { freshTailBoost } from './fresh-tail.js'
import { makeVisibilityPredicate } from './scope-util.js'
import { collapseLineTerminators } from './sanitize.js'
import { isNotYetValid, isExpired, isExpiredBeyondGrace } from './validity.js'
import { ftsTokenize } from './fts.js'

/**
 * Recall/inject asymmetry, deliberate: an explicit `scope=global` INJECT returns
 * only `global`-scoped engrams (targeted injection), while an explicit
 * `scope=global` RECALL returns all personal-family engrams, and a project-scope
 * inject filter passes all personal-family scopes. A change that makes global
 * inject a personal-family catch-all MUST rename this constant. See the
 * D1-ASYMMETRY tests.
 */
export const INJECT_GLOBAL_IS_TARGETED = true

export interface InjectionContext {
  prompt: string
  scope?: string
  /**
   * Mounted-scope visibility grants: scopes from `config.yaml`
   * `stores:` entries. Engrams in these scopes pass the `scope` visibility
   * filter like the personal family. Visibility-only — never an
   * authorization widening; see `makeVisibilityPredicate` in scope-util.ts.
   */
  grantedScopes?: readonly string[]
  session_id?: string
  /**
   * Budget for the WHOLE injection — directives + constraints + consider +
   * spread. Default: 8000 (~10% of 80K context).
   */
  maxTokens?: number
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

/** Injection layer for progressive disclosure */
export type InjectionLayer = 1 | 2 | 3

export interface InternalInjectionResult {
  directives: WireEngram[]
  constraints: WireEngram[]
  consider: WireEngram[]
  /** Estimated tokens per bucket; `directives + consider` ≤ `maxTokens`. */
  tokens_used: { directives: number; consider: number }
  /**
   * Association edges dropped during spreading activation, by reason.
   * `dropped_unresolvable`: target id not found in local engramMap (remote-only
   * or deleted engram). `dropped_retired`: target found but status !== 'active'.
   * Absent when both counts are zero.
   */
  spread_drops?: { dropped_unresolvable: number; dropped_retired: number }
  /**
   * Pinned engrams that were NOT delivered, and why. Empty when the whole
   * pinned set fit. `pinned: true` is priority-subject-to-capacity, so this
   * lets a caller distinguish "no pinned engrams matched" from "some pinned
   * engrams did not fit". Consumers MUST NOT assume full delivery.
   */
  omitted_pinned: OmittedPinned[]
}

const DEFAULT_MAX_TOKENS = 8000
const DEFAULT_MIN_RELEVANCE = 0.3
/**
 * Nearby-variant suppression (needs the meaning model): an unpinned candidate is
 * left out when a clearly better match is nearly the same rule — its relevance
 * is below NEIGHBOUR_RELEVANCE_RATIO of that match's, and the statements share
 * at least NEIGHBOUR_SIMILARITY of their words (Jaccard over search tokens).
 * Memories on other parts of the task, and variants about as relevant, are kept.
 */
const NEIGHBOUR_SIMILARITY = 0.2
const NEIGHBOUR_RELEVANCE_RATIO = 0.8
/** How many kept candidates each later candidate is compared with (bounds the cost on large stores). */
const NEIGHBOUR_ANCHORS = 50
const MAX_PER_PACK = 5
const MAX_PER_DOMAIN = 10
// Default share of the injection budget that may be PINNED. Configurable as
// `injection.pinned_ratio`. The same share is the pin-time quota
// (`pinnedQuota()`) and the ceiling on pins at injection: pins are given
// first, up to their share, so a large pinned set cannot crowd out the
// memories that match the task, which get the rest of the budget. Every pin
// that did not fit its share is named in `omitted_pinned`.
const PINNED_TOKEN_BUDGET_RATIO = 0.5
/**
 * Default share of the pinned budget the HARD tier may occupy (pinned
 * two-tier model). The hard tier is a sub-cap INSIDE the pinned share, not a
 * budget of its own: soft pins get whatever the hard tier leaves, so a store
 * with no hard-tier engrams gives its soft pins the whole pinned share.
 * Configurable as `injection.pinned_hard_ratio`; bounded to [0, 1], so the
 * hard tier can never exceed the pinned quota.
 */
export const DEFAULT_PINNED_HARD_RATIO = 0.5

/**
 * Token cap for the hard tier, given the base the pinned share is taken from.
 *
 * ONE formula for both ends: the write path passes `injection_budget` (the
 * same base `pinnedQuota()` uses), the injection path passes the injection
 * budget. With default config both give floor(floor(2000 × 0.5) × 0.5) = 500.
 */
export function pinnedHardCap(
  pinnedBudgetBase: number,
  hardRatio: number = DEFAULT_PINNED_HARD_RATIO,
  pinnedRatio: number = PINNED_TOKEN_BUDGET_RATIO,
): number {
  // A non-finite ratio (NaN from a bad direct call) falls back to the
  // default: Math.min/Math.max pass NaN through, which would disable the cap.
  const hard = Number.isFinite(hardRatio) ? Math.min(1, Math.max(0, hardRatio)) : DEFAULT_PINNED_HARD_RATIO
  return Math.floor(Math.floor(pinnedBudgetBase * pinnedShareRatio(pinnedRatio)) * hard)
}

/**
 * The pinned share of the injection budget — `injection.pinned_ratio`, the
 * ratio `pinnedQuota()` enforces at pin time, so admission and injection
 * agree. At injection it caps the pins and sizes the hard tier's
 * sub-cap. Non-finite falls back to the
 * default 0.5; out-of-range values are clamped to [0, 1].
 */
export function pinnedShareRatio(pinnedRatio: number = PINNED_TOKEN_BUDGET_RATIO): number {
  return Number.isFinite(pinnedRatio) ? Math.min(1, Math.max(0, pinnedRatio)) : PINNED_TOKEN_BUDGET_RATIO
}

/** True when an engram is in the hard pinned tier. Anything else pinned is soft. */
export function isHardPinned(e: { pinned?: unknown; pinned_tier?: unknown }): boolean {
  return e.pinned === true && e.pinned_tier === 'hard'
}

/**
 * Soft-tier eviction priority, validated (schema: integer 1–100, default 50).
 * A value outside the range is clamped rather than trusted, so a stored
 * `9999` cannot sort ahead of every legitimately prioritised engram.
 */
export function effectivePinnedPriority(e: { pinned_priority?: unknown }): number {
  const p = e.pinned_priority
  if (typeof p !== 'number' || !Number.isFinite(p)) return 50
  return Math.min(100, Math.max(1, Math.round(p)))
}

// --- Section budgets ---
//
// Constraints are filled FIRST, from a reserved floor, before anything else
// competes. Without a floor, constraints compete against every other engram on
// similarity to the task, and when common task terms carry little IDF the
// ranking favours long, keyword-dense documents, pushing important rules far
// down. Ranking still orders constraints — it just cannot evict the section.
const CONSTRAINTS_FLOOR_RATIO = 0.4
// Unused floor flows to directives, and unused directive budget flows back to
// constraints, so the reservation costs nothing when a section is small.

// DIP-0019 consider pool (bottom 1/3 of first-pass)
const DIP19_CONSIDER_MAX = 5
const DIP19_CONSIDER_BUDGET = 200

// --- Expiry handling ---

/**
 * Injection-time expiry policy. `hard` (default) skips any engram
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
 * Delegates to `validity.ts`, which compares instants rather than date
 * strings, so RFC 3339 timestamps are evaluated correctly.
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
 * An engram awaiting human approval (`commitment: 'draft'`) MUST NOT be
 * injected; enforced in core so no deployment has to reimplement it. Explicit
 * retrieval (`plur_recall`) is deliberately unaffected, so drafts can be reviewed.
 */
function skipForApproval(engram: Engram): boolean {
  return (engram as { commitment?: string }).commitment === 'draft'
}

/**
 * "⚠ EXPIRED <date> — verify before use: " prefix for an engram whose
 * `valid_until` is in the past. Only soft-expiry mode lets expired engrams
 * reach the formatters, so in hard mode this never fires.
 *
 * Uses the same evaluator as the filter that let it through, so a soft-mode
 * engram inside its grace window always carries the marker.
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

/**
 * Where a pinned row came from, for ordering: 0 = primary store, 1 = a `stores:`
 * entry or remote store, 2 = an installed pack. Markers are stamped by the
 * LOADER (`_storeScope`, `_pack`), never trusted from the row, so a row can only
 * rank itself lower. Security control: `pinned` bypasses the relevance gate, so
 * without this a pack could displace the user's own always-load rules.
 */
export function pinnedOriginRank(e: Record<string, unknown>): 0 | 1 | 2 {
  if (typeof e._pack === 'string') return 2
  if (typeof e._storeScope === 'string') return 1
  return 0
}

/**
 * Cost of an engram against the injection budget: what the formatters EMIT, not
 * the stored record (runtime state such as `activation` or `usage` is not
 * charged). Estimated at the richest layer; over-charging costs a little budget,
 * under-charging overflows the context. MUST stay in step with
 * formatLayer2/formatLayer3.
 */
export function estimateTokens(engram: ScoredEngram): number {
  // Measured by rendering through the formatters, so the estimate cannot drift.
  // Charged at the richer layer an engram can render at (selection happens
  // before the bucket is known); `confidence_score` is a same-width placeholder,
  // +1 is the joining newline. The field-sum estimate stays as a FLOOR so no
  // existing budget is loosened.
  const wire = { ...engram, confidence_score: 0 } as unknown as WireEngram
  const rendered = Math.max(formatLayer3(wire).length, formatLayer1(wire).length) + 1
  return Math.ceil(Math.max(rendered, legacyEstimateChars(engram)) / 4)
}

/** The field-sum estimate, in characters. Floor only; see above. */
function legacyEstimateChars(engram: ScoredEngram): number {
  const e = engram as ScoredEngram & {
    contraindications?: string[]
    rationale?: string
    commitment?: string
    claim_class?: unknown
  }
  let chars = e.id.length + 4 + (e.statement?.length ?? 0)
  const contra = e.contraindications
  if (contra?.length) chars += 24 + contra.join('; ').length
  if (e.rationale) chars += 15 + e.rationale.length
  const meta =
    (e.domain ? e.domain.length + 10 : 0) +
    (e.commitment ? e.commitment.length + 14 : 0) +
    // "Kind: <claim_class>". Also covered by the rendered estimate
    // above; kept in this floor too so the floor never under-counts a field
    // formatLayer3 renders — nothing validates `claim_class` against its enum
    // before it is stored.
    (typeof e.claim_class === 'string' ? e.claim_class.length + 9 : 0) +
    20 +                                                             // "Confidence: 0.00"
    (e.activation?.last_accessed ? e.activation.last_accessed.length + 15 : 0)
  if (meta > 20) chars += meta + 3
  return chars
}

// --- Anchor boost ---

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter(w => w.length > 2))
}

/** Shared words over all words of two token sets; 0 when both are empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
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
// Converts the legacy `relations` field into the `associations` format.
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

// Match keywords on WORD BOUNDARIES, not substrings: substring matching
// false-positives on common words ('prior' ⊂ "priority", 'old' ⊂ "threshold",
// 'was' ⊂ "wasm"), and a false positive SUPPRESSES the ×0.3 penalty on
// superseded engrams, injecting stale memory instead of the current tip.
// \b sits at every space↔word transition, so multi-word phrases match with a
// boundary at each end. The inter-word gap is matched as \s+ (not a literal
// space) so a phrase split by a newline, tab, or doubled space still matches.
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

/**
 * Replaced by an engram this session could deliver, so not injected (outside a
 * historical prompt). When no replacement is deliverable here (retired,
 * remote-only, draft, expired, on_request pack, invisible scope), the ×0.3
 * re-rank applies instead so the session is not left with neither.
 * - A supersede loop (self, or A → B → A) is not a replacement; members keep the re-rank.
 * - Only DIRECT superseded_by edges count (A → B → C with only C deliverable: A stays).
 */
function isReplacedByDeliverable(
  engram: Engram,
  deliverableIds: ReadonlySet<string>,
  supersededBy: ReadonlyMap<string, readonly string[]>,
  replacedFromPrimary?: ReadonlyMap<string, readonly string[]>,
): boolean {
  const replacements = [...(engram.relations?.superseded_by ?? []), ...(replacedFromPrimary?.get(engram.id) ?? [])]
  return replacements.some(id =>
    deliverableIds.has(id) && !leadsBackTo(id, engram.id, supersededBy))
}

/**
 * A row of ANOTHER store that a primary row supersedes, read from the primary
 * row's forward edge (the reverse edge in that store resolves to no loaded id).
 * Only primary rows (no loader marker, bare id) and only edges to a namespaced
 * id count: a store or pack row must never hide another store's row.
 * Primary-to-primary supersession keeps using the reverse edge.
 */
function isPrimaryRow(e: Engram): boolean {
  const m = e as { _storeScope?: unknown; _fromRemoteStore?: unknown; _pack?: unknown }
  return m._storeScope === undefined && m._fromRemoteStore === undefined && m._pack === undefined
    && parseNamespacedId(e.id) === null
}

/** Does following superseded_by edges from `start` reach `target`? A self-edge reaches at once. */
function leadsBackTo(
  start: string,
  target: string,
  supersededBy: ReadonlyMap<string, readonly string[]>,
): boolean {
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const next of supersededBy.get(id) ?? []) stack.push(next)
  }
  return false
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

/**
 * Is `engram` visible under the inject's scope filter? The SAME decision as the
 * scope gate in `scoreEngram`, as a boolean. Needed because `scoreEngram`
 * returns 0 for both "excluded" and "no hits", and the pinned exemption,
 * embedding boost and spreading activation may revive only the latter.
 * Invisible engrams are dropped before scoring and never enter the spreading map.
 */
export function isInjectVisible(
  engramScope: string,
  scopeFilter: string | undefined,
  grantedScopes?: readonly string[],
): boolean {
  if (!scopeFilter) return true
  if (scopeFilter === 'global') return engramScope === 'global'
  return makeVisibilityPredicate(scopeFilter, grantedScopes)(engramScope)
}

export function scoreEngram(
  engram: Engram,
  promptLower: string,
  promptWords: Set<string>,
  packMatchTerms: string[],
  scopeFilter: string | undefined,
  isPack: boolean,
  // Trailing optional so the public signature stays non-breaking.
  grantedScopes?: readonly string[],
): number {
  // Scope filtering: if scope is specified, only include matching engrams.
  // `isInjectVisible` below is the same decision as a boolean; selectAndSpread
  // consults it directly because a 0 from here does not say WHICH gate fired.
  if (scopeFilter) {
    if (scopeFilter === 'global') {
      // INJECT_GLOBAL_IS_TARGETED: explicit scope=global inject returns ONLY
      // global-scoped engrams — targeted global-namespace injection. The
      // personal-family pass-through below applies to PROJECT-scope filters
      // only; this branch is intentionally narrower than the project branch
      // (see INJECT_GLOBAL_IS_TARGETED JSDoc + D1-ASYMMETRY tests).
      // Mounted-scope grants deliberately do NOT reach this branch:
      // targeted-global stays global-only, grants or no grants.
      void INJECT_GLOBAL_IS_TARGETED
      if (engram.scope !== 'global') return 0
    } else if (!makeVisibilityPredicate(scopeFilter, grantedScopes)(engram.scope)) {
      // Visibility filter, ONE predicate for every in-memory call
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
  // A locked engram does not fade with disuse either: it ranks at its stored
  // strength, the same exemption confidenceDecay gives it below.
  const isLocked = (engram as any).commitment === 'locked'
  let rs = isPack || isLocked
    ? engram.activation.retrieval_strength
    : decayedStrength(engram.activation.retrieval_strength, daysSince(engram.activation.last_accessed))
  // Additional confidence decay for engrams without recent feedback
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

/** A pinned engram that did not make it in, and why. */
export interface OmittedPinned {
  id: string
  /** Estimated token cost of the engram that was skipped. */
  cost: number
  /** `pinned-sub-budget`: the pinned share (`injection.pinned_ratio`, default
   *  50%) was exhausted while overall budget remained.
   *  `total-budget`: no room left at all.
   *  `hard-tier-cap`: a hard-tier engram did not fit the hard tier's sub-cap.
   *  `soft-tier-budget`: an engram with an explicit soft tier or priority did
   *  not fit what the hard tier left of the pinned share. An engram with no
   *  tier fields reports `pinned-sub-budget`. */
  reason: 'pinned-sub-budget' | 'total-budget' | 'hard-tier-cap' | 'soft-tier-budget'
}

/**
 * Tokens the hard tier holds back from the soft tier: what the hard-pinned
 * candidates cost, up to the hard cap. Computed ONCE over every candidate and
 * shared through the ledger, so a soft pin in an earlier section pass cannot
 * spend the share before a hard pin is looked at.
 */
//
// Known limitation: a hard pin that can never fit still counts toward the
// reserve; the write-time cap makes that rare and it is not corrected here.
export function hardPinnedReserve(scored: Array<ScoredEngram>, hardCap: number): number {
  let sum = 0
  for (const e of scored) {
    if (isHardPinned(e as never)) sum += estimateTokens(e)
  }
  return Math.min(hardCap, sum)
}

/**
 * Union the per-pass omission lists into what the caller actually did not get:
 * one entry per engram, and nothing a later pass went on to select.
 *
 * @param all - omissions from every pass, in pass order.
 * @param selected - the engrams that made the final set.
 */
function dedupeOmitted(all: OmittedPinned[], selected: ScoredEngram[] = []): OmittedPinned[] {
  return all
    .filter((o, i, list) => list.findIndex(x => x.id === o.id) === i)
    .filter(o => !selected.some(d => d.id === o.id))
}

export function fillTokenBudget(
  scored: ScoredEngram[],
  maxTokens: number,
  /**
   * Base for the pinned sub-budget. Defaults to `maxTokens`, but MUST be the
   * whole injection budget when this is one of several section passes:
   * the ratio guards against pinned starving contextual recall and must not
   * compound once per pass.
   */
  pinnedBudgetBase: number = maxTokens,
  /**
   * Running total of pinned tokens committed by EVERY pass sharing this
   * budget. Shared and mutated, because the sub-budget is a property of the
   * injection, not of a pass. Otherwise each pass would be granted the pinned
   * share of the WHOLE budget afresh, and several passes together could let
   * pinned engrams fill the entire injection.
   */
  pinnedLedger: { spent: number; hardSpent?: number; hardReserve?: number } = { spent: 0 },
  /**
   * Share of the pinned budget the hard tier may occupy (pinned two-tier
   * model). See {@link DEFAULT_PINNED_HARD_RATIO}.
   */
  pinnedHardRatio: number = DEFAULT_PINNED_HARD_RATIO,
  /**
   * Share of `pinnedBudgetBase` reserved for pinned engrams
   * (`injection.pinned_ratio`, default 0.5) — the ratio the pin-time quota
   * uses, passed through so the two cannot disagree.
   */
  pinnedRatio: number = PINNED_TOKEN_BUDGET_RATIO,
  /**
   * Engrams already committed to this section by an earlier selection (the
   * global pinned pre-pass in `selectAndSpread`). They count toward the
   * per-pack and per-domain caps exactly as if they had been selected here.
   */
  seed: readonly ScoredEngram[] = [],
): { selected: ScoredEngram[]; tokens_used: number; omitted_pinned: OmittedPinned[] } {
  const result: ScoredEngram[] = []
  const omittedPinned: OmittedPinned[] = []
  const packCounts = new Map<string, number>()
  const domainCounts = new Map<string, number>()
  for (const e of seed) {
    const pack = e.pack ?? '__personal__'
    packCounts.set(pack, (packCounts.get(pack) ?? 0) + 1)
    const topDomain = (e.domain ?? '__none__').split('.')[0]
    domainCounts.set(topDomain, (domainCounts.get(topDomain) ?? 0) + 1)
  }
  let tokensUsed = 0

  // Two-pass selection: pinned engrams first, then the rest. Pins ignore
  // per-pack/per-domain fairness caps but respect maxTokens and the pinned share
  // (hard tier: its sub-cap). Order: origin (primary, stores/remote, packs), so
  // budget pressure never admits a pack pin ahead of the user's own; within an
  // origin, hard tier, then soft by `pinned_priority`, then score. Origin stays
  // the outer key so tiers cannot reopen the trust boundary.
  const pinned = scored.filter(e => (e as any).pinned === true).sort((a, b) =>
    pinnedOriginRank(a as never) - pinnedOriginRank(b as never)
    || (isHardPinned(a as never) ? 0 : 1) - (isHardPinned(b as never) ? 0 : 1)
    || (isHardPinned(a as never) ? 0 : effectivePinnedPriority(b as never) - effectivePinnedPriority(a as never))
    || b.score - a.score)
  const unpinned = scored.filter(e => (e as any).pinned !== true)
  // Pinned memories come first, up to their share of the budget:
  // `injection.pinned_ratio`, default half. A
  // large pinned set cannot take the whole budget; the memories matching the
  // task get what the pins leave, and every pin over the share is named.
  const pinnedBudget = Math.floor(pinnedBudgetBase * pinnedShareRatio(pinnedRatio))
  // The hard tier is a sub-cap inside the pinned share; the soft tier gets
  // what the hard tier holds back. With no hard-tier candidates the reserve is
  // 0 and the soft tier has the whole pinned share.
  const hardCap = pinnedHardCap(pinnedBudgetBase, pinnedHardRatio, pinnedRatio)
  if (pinnedLedger.hardSpent === undefined) pinnedLedger.hardSpent = 0
  if (pinnedLedger.hardReserve === undefined) pinnedLedger.hardReserve = hardPinnedReserve(scored, hardCap)
  const softBudget = pinnedBudget - pinnedLedger.hardReserve
  const softReason = (e: ScoredEngram): OmittedPinned['reason'] => {
    const r = e as unknown as { pinned_tier?: unknown; pinned_priority?: unknown }
    return r.pinned_tier === 'soft' || r.pinned_priority != null ? 'soft-tier-budget' : 'pinned-sub-budget'
  }

  // Omissions are REPORTED, not silent: pinning is priority-subject-to-capacity.
  // Once a pin is skipped for budget, no LOWER-origin pin may be admitted after
  // it; within one origin, greedy is fine. Kept per tier (the hard tier has its
  // own reserve); a total-budget skip blocks both tiers.
  let skippedRankSoft: number | null = null
  let skippedRankHard: number | null = null
  const lower = (cur: number | null, rank: number) => cur === null ? rank : Math.min(cur, rank)
  for (const engram of pinned) {
    const rank = pinnedOriginRank(engram as never)
    const hard = isHardPinned(engram as never)
    const blockedAt = hard ? skippedRankHard : skippedRankSoft
    if (blockedAt !== null && rank > blockedAt) {
      omittedPinned.push({ id: engram.id, cost: estimateTokens(engram), reason: hard ? 'hard-tier-cap' : softReason(engram) })
      continue
    }
    const cost = estimateTokens(engram)
    if (tokensUsed + cost > maxTokens) {
      omittedPinned.push({ id: engram.id, cost, reason: 'total-budget' })
      skippedRankSoft = lower(skippedRankSoft, rank)
      skippedRankHard = lower(skippedRankHard, rank)
      continue
    }
    // Against the SHARED spend, so the cap binds across passes rather than
    // once per pass.
    if (hard) {
      // Hard-tier overflow is REPORTED like any other omission. The write
      // path refuses a hard-tier engram that would overrun the cap, but it can
      // only count what this client sees (a remote store's hard tier may be
      // written elsewhere), so this is the enforcement point that cannot be
      // bypassed — and a tier sold as guaranteed must not vanish silently.
      if (pinnedLedger.hardSpent + cost > hardCap || pinnedLedger.spent + cost > pinnedBudget) {
        omittedPinned.push({ id: engram.id, cost, reason: 'hard-tier-cap' })
        skippedRankHard = lower(skippedRankHard, rank)
        continue
      }
    } else if (pinnedLedger.spent - pinnedLedger.hardSpent + cost > softBudget) {
      omittedPinned.push({ id: engram.id, cost, reason: softReason(engram) })
      skippedRankSoft = lower(skippedRankSoft, rank)
      continue
    }
    result.push(engram)
    tokensUsed += cost
    pinnedLedger.spent += cost
    if (hard) pinnedLedger.hardSpent += cost
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
  config?: { spread_cap?: number; spread_budget?: number; expiry?: ExpiryConfig; pinned_hard_ratio?: number; pinned_ratio?: number },
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
  // Engrams hidden by the scope filter. A spreading edge to one is neither
  // "retired" nor "unresolvable" — it is simply not part of this view — so it
  // is skipped without feeding spread_drops.
  const scopeExcludedIds = new Set<string>()
  // Every engram this injection could deliver, for the "replaced by a
  // deliverable engram" test: active, approved, valid, visible under this
  // inject's scope filter, and not in an on_request pack. A correction kept in
  // a scope this injection cannot see is not deliverable here, so the engram
  // it replaces stays injectable rather than leaving neither.
  // Filled by the scoring loops below.
  const deliverableIds = new Set<string>()
  // superseded_by edges of every engram the loops see, for loop detection.
  const supersededBy = new Map<string, readonly string[]>()
  // Forward edges from primary rows to other stores' rows (see isPrimaryRow).
  const replacedFromPrimary = new Map<string, string[]>()
  for (const e of personalEngrams) {
    if (!e.relations?.supersedes?.length || !isPrimaryRow(e)) continue
    for (const t of e.relations.supersedes) {
      if (parseNamespacedId(t) === null) continue
      const list = replacedFromPrimary.get(t) ?? []
      list.push(e.id)
      replacedFromPrimary.set(t, list)
    }
  }
  const historical = hasHistoricalIntent(ctx.prompt)

  // Step 1-2: Score all active engrams
  const scored: ScoredEngram[] = []
  // Keyword score + meaning similarity per candidate, for the relative cut in step 5.
  const relevance = new Map<string, number>()

  for (const engram of personalEngrams) {
    if (engram.relations?.superseded_by?.length) supersededBy.set(engram.id, engram.relations.superseded_by)
    if (engram.status !== 'active') { nonActiveIds.add(engram.id); continue }
    // NOT added to nonActiveIds: a draft is active, it is simply ungated for
    // delivery. That set feeds spread_drops accounting for retired or
    // unresolvable targets, and a pending-review engram is neither.
    const deliverable = !skipForApproval(engram)
      && !skipForValidity(engram, nowMs, expiryMode, graceDays)
    // Visibility BEFORE the map and the score (see isInjectVisible): nothing
    // below — pinned exemption, embedding boost, spreading — may revive it.
    if (!isInjectVisible(engram.scope, ctx.scope, ctx.grantedScopes)) { scopeExcludedIds.add(engram.id); continue }
    if (deliverable) deliverableIds.add(engram.id)
    if (!deliverable) continue
    engramMap.set(engram.id, engram)
    let raw = scoreEngram(engram, promptLower, promptWords, [], ctx.scope, false, ctx.grantedScopes)
    relevance.set(engram.id, raw + (embeddingBoosts?.get(engram.id) ?? 0))
    // Embedding boost: semantically similar engrams with zero keyword hits still get scored.
    // 0.5 is a typical BGE-small threshold for "actually related"; lower values
    // surface spurious matches between unrelated short English sentences.
    // Keyword+semantic matches still get the additive bonus regardless.
    const embBoost = embeddingBoosts?.get(engram.id) ?? 0
    if (raw === 0 && embBoost > 0.5) {
      raw = embBoost * 2 // semantic-only signal, scaled to be comparable with keyword scores
    } else if (raw > 0 && embBoost > 0) {
      raw += embBoost // additive boost for keyword+semantic match
    }
    // Fresh tail boost: recently created engrams get a retrieval strength boost
    if (raw > 0) {
      const createdAt = engram.temporal?.learned_at ?? engram.activation.last_accessed
      const ftBoost = freshTailBoost(createdAt, (engram as any).commitment, new Date())
      if (ftBoost > 0) raw += ftBoost
    }
    // Pinned engrams enter the pool even at raw 0. "Always-load" is the whole
    // contract of pinning, and the minRelevance exemption below is too late to
    // deliver it: an engram dropped here for having no keyword overlap never
    // reaches that gate. (Under injectHybrid an embedding boost usually rescues
    // such an engram; the BM25 path would not.)
    if (raw > 0 || (engram as { pinned?: boolean }).pinned === true) {
      scored.push({ ...engram, keyword_match: raw, raw_score: raw, score: raw })
    }
  }

  for (const pack of packs) {
    const packMeta = getPackMetadata(pack.manifest)
    if (packMeta.injection_policy === 'on_request') continue
    const matchTerms = packMeta.match_terms
    for (const engram of pack.engrams) {
      if (engram.relations?.superseded_by?.length) supersededBy.set(engram.id, engram.relations.superseded_by)
      if (engram.status !== 'active') continue
      const deliverable = !skipForApproval(engram)
        && !skipForValidity(engram, nowMs, expiryMode, graceDays)
      if (!isInjectVisible(engram.scope, ctx.scope, ctx.grantedScopes)) { scopeExcludedIds.add(engram.id); continue }
      if (deliverable) deliverableIds.add(engram.id)
      if (!deliverable) continue
      engramMap.set(engram.id, engram)
      let raw = scoreEngram(engram, promptLower, promptWords, matchTerms, ctx.scope, true, ctx.grantedScopes)
      relevance.set(engram.id, raw + (embeddingBoosts?.get(engram.id) ?? 0))
      const embBoost = embeddingBoosts?.get(engram.id) ?? 0
      if (raw === 0 && embBoost > 0.5) {
        raw = embBoost * 2
      } else if (raw > 0 && embBoost > 0) {
        raw += embBoost
      }
      // Same pinned exemption as the personal path above.
      if (raw > 0 || (engram as { pinned?: boolean }).pinned === true) {
        // Stamp `_pack` so the pack name survives stripAssociations/stripScoring into
        // WireEngram — the telemetry loop in _inject reads `_pack` to bucket
        // pack_counts. The corpus path does not carry these rows, so the stamp
        // must come from the pack loop.
        const scored_entry = { ...engram, keyword_match: raw, raw_score: raw, score: raw } as any
        scored_entry._pack = pack.manifest.name
        scored.push(scored_entry)
      }
    }
  }

  // A pack row also answers, for spreading, to the id it had under the earlier
  // pack-id scheme: relations saved before that change still name it that way.
  // Only when no row carries that id exactly and exactly one pack row answers
  // to it (if two packs share such an id, it names neither).
  {
    const exactIds = new Set<string>(personalEngrams.map(e => e.id))
    const legacyRows = new Map<string, string[]>()
    for (const pack of packs) {
      for (const engram of pack.engrams) {
        exactIds.add(engram.id)
        const legacy = legacyPackEngramId(engram.id, pack.manifest.name)
        if (legacy) legacyRows.set(legacy, [...(legacyRows.get(legacy) ?? []), engram.id])
      }
    }
    for (const [legacy, ids] of legacyRows) {
      if (ids.length !== 1 || exactIds.has(legacy)) continue
      const row = engramMap.get(ids[0])
      if (row) engramMap.set(legacy, row)
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
  // A superseded engram whose replacement is deliverable is not current, so it is
  // not a candidate at all — not in directives, constraints or consider.
  // A historical prompt ("previously", "used to") still reaches it.
  const current = scored.filter(s =>
    ((s as any).pinned === true || s.score >= minRelevance)
    && (historical || !isReplacedByDeliverable(s, deliverableIds, supersededBy, replacedFromPrimary)))
  // Nearby-variant suppression. The floor above is a share of a score
  // normalised to the best match and padded by recency and anchor bonuses, so
  // nearly anything sharing a word with the task clears it — including the
  // variant of the matching rule written for a different situation ("incident
  // summaries" beside "review summaries"). When the meaning model ran, walk the
  // candidates from most to least relevant and leave out one that is nearly the
  // same statement as a clearly more relevant candidate already kept. Pinned
  // candidates, and candidates the meaning model gave no score, are neither
  // judged nor used as anchors. Without the meaning model, keyword overlap alone
  // cannot rank a rule above its variant, so that path skips this step.
  let filtered = current
  if (embeddingBoosts && embeddingBoosts.size > 0) {
    const judged = (e: ScoredEngram) => (e as any).pinned !== true && embeddingBoosts.has(e.id)
    const rel = (e: ScoredEngram) => relevance.get(e.id) ?? 0
    const byRelevance = current.filter(judged).sort((a, b) => rel(b) - rel(a))
    const anchors: Array<{ rel: number; words: Set<string> }> = []
    const dropped = new Set<string>()
    for (const e of byRelevance) {
      const words = new Set(ftsTokenize(e.statement))
      const r = rel(e)
      const variant = anchors.some(a => r < NEIGHBOUR_RELEVANCE_RATIO * a.rel && jaccard(a.words, words) >= NEIGHBOUR_SIMILARITY)
      if (variant) { dropped.add(e.id); continue }
      if (anchors.length < NEIGHBOUR_ANCHORS) anchors.push({ rel: r, words })
    }
    if (dropped.size > 0) filtered = current.filter(e => !dropped.has(e.id))
  }

  // Sort by score descending
  filtered.sort((a, b) => b.score - a.score)

  // Supersedes chain preference: under budget pressure, tip beats older members.
  // Only a superseded engram with no deliverable replacement here (or one in a
  // supersede loop) reaches this.
  if (!historical) {
    for (const e of filtered) {
      if (isSupersededEngram(e)) {
        e.score *= 0.3
      }
    }
    filtered.sort((a, b) => b.score - a.score)
  }

  // Step 6: Fill section budgets — CONSTRAINTS FIRST, from a reserved floor.
  // - `isConstraintCandidate` must stay in step with the wire-time routing
  //   below, or the floor reserves space for engrams rendered elsewhere.
  // - PINNED FIRST, across both sections, in ONE origin-ordered pass, so the
  //   origin rule is global; section passes see only unpinned engrams.
  // - ONE ledger for every pass drawing on `maxTokens`, so the pinned share is
  //   not multiplied by the number of passes.
  // - The hard-tier reserve is computed over ALL candidates.
  const hardRatio = config?.pinned_hard_ratio ?? DEFAULT_PINNED_HARD_RATIO
  const pinnedRatio = config?.pinned_ratio ?? PINNED_TOKEN_BUDGET_RATIO
  const pinnedLedger = {
    spent: 0,
    hardSpent: 0,
    hardReserve: hardPinnedReserve(filtered, pinnedHardCap(maxTokens, hardRatio, pinnedRatio)),
  }
  const pinnedPass = fillTokenBudget(
    filtered.filter(e => (e as any).pinned === true), maxTokens, maxTokens, pinnedLedger, hardRatio, pinnedRatio)
  const pinnedConstraints = pinnedPass.selected.filter(isConstraintCandidate)
  const pinnedDirectives = pinnedPass.selected.filter(e => !isConstraintCandidate(e))
  const pinnedConstraintTokens = pinnedConstraints.reduce((a, e) => a + estimateTokens(e), 0)

  // Pins had first claim, up to their share. The memories matching
  // the task get the rest of the budget. A pin that did not fit its share is
  // named in `omitted_pinned` and does not come back through the consider pool
  // or spreading below: that would give it past its share, after the task's
  // memories.
  const omittedPinIds = new Set(pinnedPass.omitted_pinned.map(o => o.id))
  const unpinned = filtered.filter(e => (e as any).pinned !== true)
  const constraintCandidates = unpinned.filter(isConstraintCandidate)
  const otherCandidates = unpinned.filter(e => !isConstraintCandidate(e))

  const constraintsFloor = Math.floor(maxTokens * CONSTRAINTS_FLOOR_RATIO)
  // Pinned constraints draw on the constraints floor first, and the floor
  // stops at what the pins left: with a pinned share above
  // 1 − CONSTRAINTS_FLOOR_RATIO the pins and the floor together would
  // otherwise overrun `maxTokens`.
  const firstPass = fillTokenBudget(constraintCandidates,
    Math.max(0, Math.min(constraintsFloor - pinnedConstraintTokens, maxTokens - pinnedPass.tokens_used)),
    maxTokens, pinnedLedger, hardRatio, pinnedRatio, pinnedConstraints)

  // Directives get everything the pins and the constraints floor did not use.
  const directivesBudget = Math.max(0, maxTokens - pinnedPass.tokens_used - firstPass.tokens_used)
  const dirPass = fillTokenBudget(otherCandidates, directivesBudget, maxTokens, pinnedLedger, hardRatio, pinnedRatio,
    pinnedDirectives)

  // Any budget the directives left over flows BACK to constraints, so a
  // session with few directives carries more of its rules, not fewer.
  const slack = Math.max(0,
    maxTokens - pinnedPass.tokens_used - firstPass.tokens_used - dirPass.tokens_used)
  const chosen = new Set(firstPass.selected.map(e => e.id))
  const secondPass = slack > 0
    ? fillTokenBudget(constraintCandidates.filter(e => !chosen.has(e.id)), slack, maxTokens, pinnedLedger, hardRatio, pinnedRatio)
    : { selected: [] as ScoredEngram[], tokens_used: 0, omitted_pinned: [] as OmittedPinned[] }

  const selectedConstraints = [...pinnedConstraints, ...firstPass.selected, ...secondPass.selected]
  const constraintTokens = pinnedConstraintTokens + firstPass.tokens_used + secondPass.tokens_used

  // Downstream (spreading activation, consider pool, wire split) consumes one
  // ordered pool. Constraints lead it so any consumer that truncates head-first
  // keeps the prohibitions.
  const directives = [...selectedConstraints, ...pinnedDirectives, ...dirPass.selected]
  const directiveTokens = pinnedPass.tokens_used + firstPass.tokens_used + secondPass.tokens_used
    + dirPass.tokens_used
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
    if (omittedPinIds.has(e.id)) return false
    const pack = e.pack ?? '__personal__'
    if (pack !== '__personal__' && (directivePackCounts.get(pack) ?? 0) >= MAX_PER_PACK) return false
    return true
  })
  // CAP-SUM: `maxTokens` bounds the WHOLE injection — directives +
  // constraints + consider + spread. The sections above keep priority and
  // never exceed it; the consider pool, then spreading activation, get at most
  // what they leave (each still also capped by its own budget).
  const remainingAfterSections = Math.max(0, maxTokens - directiveTokens)
  const { selected: dip19Consider } = fillTokenBudget(
    dip19Remainder, Math.min(DIP19_CONSIDER_BUDGET, remainingAfterSections),
  )
  // Cap at DIP19_CONSIDER_MAX and correct token count
  const dip19Pool = dip19Consider.slice(0, DIP19_CONSIDER_MAX)
  const dip19PoolTokens = dip19Pool.reduce((acc, e) => acc + estimateTokens(e), 0)
  // Spreading activation draws on what the sections and the consider pool left.
  const effectiveSpreadBudget = Math.min(spreadBudget, Math.max(0, remainingAfterSections - dip19PoolTokens))

  // Step 7-8: Guard empty
  if (directives.length === 0 && dip19Pool.length === 0) {
    return {
      directives: [],
      constraints: [],
      consider: [],
      tokens_used: { directives: 0, consider: 0 },
      // NOT `[]`: when everything was dropped (e.g. a single oversized
      // pinned engram at a tiny budget), the omissions must still be reported.
      omitted_pinned: dedupeOmitted(pinnedPass.omitted_pinned, dip19Pool),
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
      // Reached under an earlier pack id (see the alias above) but already in.
      if (target && visited.has(target.id)) continue
      if (!target) {
        if (scopeExcludedIds.has(assoc.target)) continue
        if (nonActiveIds.has(assoc.target)) droppedRetired++
        else droppedUnresolvable++
        continue
      }
      if (target.status !== 'active') { droppedRetired++; continue }
      // A pin over its share is not given through spreading either.
      if (omittedPinIds.has(target.id)) continue
      if (!historical && isReplacedByDeliverable(target, deliverableIds, supersededBy, replacedFromPrimary)) continue

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
      if (spreadTokens + cost > effectiveSpreadBudget) continue
      if (spreadCandidates.length >= spreadCap) break

      spreadCandidates.push(spreadEngram)
      spreadTokens += cost
      visited.add(assoc.target)
      visited.add(target.id)
    }
  }

  // Merge consider pools: DIP-0019 bottom-1/3 + spreading activation
  const allConsider = [...dip19Pool, ...spreadCandidates]

  // Steps 14-15: Strip pipeline
  const agentDirectives = directives.map(stripAssociations)
  const agentConsider = allConsider.map(stripAssociations)

  const wireAll = agentDirectives.map(stripScoring)
  const wireConsider = agentConsider.map(stripScoring)

  // Auto-classify polarity, apply cognitive_level routing and commitment scoring
  const wireDirectives: WireEngram[] = []
  const wireConstraints: WireEngram[] = []
  const cognitiveDemoted: WireEngram[] = []
  for (const wire of wireAll) {
    const polarity = wire.polarity ?? classifyPolarity(wire.statement)
    // Apply commitment multiplier to confidence score
    const commitment = (wire as any).commitment as string | undefined
    if (commitment) {
      const mult: Record<string, number> = { locked: 1.0, decided: 0.9, leaning: 0.7, exploring: 0.5 }
      wire.confidence_score *= mult[commitment] ?? 1.0
    }
    // Cognitive level bucket routing
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
    omitted_pinned: dedupeOmitted(pinnedPass.omitted_pinned, [...directives, ...allConsider]),
  }
}

// --- Progressive Disclosure ---

/**
 * A compact mark for a memory no person or artifact asserted. Layers 1 and 2
 * have no metadata line, so without it a model's conclusion and a user's
 * statement render identically. Only `inferred` is marked: other claim classes
 * come from something checkable, and marking everything would be noise.
 */
function inferredMark(engram: WireEngram): string {
  return (engram as any).claim_class === 'inferred' ? '(inferred) ' : ''
}

/**
 * Fold anything that would forge an ENTRY boundary out of rendered text.
 *
 * This renderer separates entries with a newline, and dsh's `flatten()` splits
 * on `/\n(?=\[)/` to recover them, so a value carrying a line terminator mints
 * an entry the model reads at this block's authority. Reuses core's one
 * definition of a line terminator (`sanitize.ts`) rather than restating
 * the class: a second hand-written copy drifts toward the narrower of the two,
 * and nothing fails loudly when it does.
 */
const entrySafe = (value: string): string => collapseLineTerminators(String(value))

/**
 * Additionally fold the meta line's field delimiter ' | ' out of a value:
 * `domain` and `activation.last_accessed` carry pack-controlled text that could
 * otherwise forge meta fields inside `## DIRECTIVES`. Invariant: the renderer
 * owns ' | ', values never contain it (same trade `flatten()` makes for headings).
 * Deliberately NOT applied to `statement` or `rationale`, which are whole lines
 * where a pipe forges nothing (e.g. `Array<string> | null`).
 */
const metaSafe = (value: string): string => entrySafe(value).replace(/\s*\|\s*/g, ' ')

/**
 * Where a delivered memory came from: the scope it was saved in, on its own
 * indented continuation line of the entry.
 *
 * An entry the agent receives must say whose memory it is — a team rule and a
 * personal note read the same otherwise. Rendered on every layer, as its own
 * line rather than a field of the layer-3 meta line, so it reads the same in
 * every section and cannot be shadowed by a forged meta field.
 *
 * Only a non-empty scope is shown. The schema requires a scope string but
 * accepts `''`, and a cost estimate renders a bare entry with no scope at
 * all; neither has a scope to name, so neither gets the line.
 */
function originLines(engram: WireEngram, indent: string): string[] {
  const scope = (engram as { scope?: unknown }).scope
  if (typeof scope !== 'string' || scope === '') return []
  return [`${indent}Scope: ${entrySafe(scope)}`]
}

/**
 * Layer 1 (the "also consider" section) renders the WHOLE statement.
 *
 * A short form is not the memory: what is reported as given is delivered
 * whole. The budget already charges for the rendered entry (`estimateTokens`
 * renders it), so a long statement costs what it delivers.
 */
export function formatLayer1(engram: WireEngram): string {
  return [
    `[${engram.id}] ${expiredMarker(engram)}${inferredMark(engram)}${entrySafe(engram.statement)}`,
    ...originLines(engram, '  '),
  ].join('\n')
}

/**
 * Conditions under which the statement does NOT apply.
 *
 * Without them a qualified rule is delivered as an unconditional one —
 * "retry after a timeout" arriving without "but not after the idempotency
 * window expires".
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
    `[${engram.id}] ${expiredMarker(engram)}${inferredMark(engram)}${entrySafe(engram.statement)}`,
    ...contraindicationLines(engram, '  '),
    ...originLines(engram, '  '),
  ].join('\n')
}

export function formatLayer3(engram: WireEngram): string {
  const lines = [`[${engram.id}] ${expiredMarker(engram)}${entrySafe(engram.statement)}`]
  lines.push(...contraindicationLines(engram, '  '))
  lines.push(...originLines(engram, '  '))
  if (engram.rationale) lines.push(`  Rationale: ${entrySafe(engram.rationale)}`)
  const meta: string[] = []
  if (engram.domain) meta.push(`Domain: ${engram.domain}`)
  // Commitment (a decision-state ladder: exploring→leaning→decided→locked)
  // and confidence (epistemic certainty, a float) are ORTHOGONAL. Show both as
  // distinct fields; never overwrite one with the other, or a shaky fact marked
  // `locked` would read as maximally certain.
  const commitment = (engram as any).commitment as string | undefined
  if (commitment) meta.push(`Commitment: ${commitment}`)
  // What KIND of claim this is, at the moment it is put in front of a model.
  // Without it an inferred guess and a stated fact render identically in the
  // DIRECTIVES block, and the agent treats both as equally authoritative.
  const claimClass = (engram as any).claim_class as string | undefined
  if (claimClass) meta.push(`Kind: ${claimClass}`)
  if (engram.confidence_score != null) meta.push(`Confidence: ${engram.confidence_score.toFixed(2)}`)
  // "Last active", NOT "Last verified". This renders activation.last_accessed,
  // which applyFeedback() re-anchors on ANY signal — including negative — so it
  // is memory activity, not a source check. Factual verification needs its own
  // evidence and must not be inferred from recall or feedback.
  if (engram.activation?.last_accessed) meta.push(`Last active: ${engram.activation.last_accessed}`)
  if (meta.length > 0) lines.push(`  ${meta.map(metaSafe).join(' | ')}`)
  return lines.join('\n')
}

/**
 * Render depth per section.
 *
 * CONSTRAINTS renders at 3, not 2: a prohibition is what an agent is most
 * accountable for, so it carries its `rationale` (why it holds and when it
 * stops holding) and the commitment/confidence meta line, like directives.
 *
 * The cost is already budgeted: `estimateTokens` estimates at the richest
 * layer. Estimator and formatter agree.
 */
export function assignLayer(bucket: 'directives' | 'constraints' | 'consider'): InjectionLayer {
  switch (bucket) {
    case 'directives': return 3
    case 'constraints': return 3
    case 'consider': return 1
  }
}

export function formatWithLayer(engrams: WireEngram[], layer: InjectionLayer): string {
  if (engrams.length === 0) return ''
  switch (layer) {
    // One entry per line, as layers 2 and 3 do. A `' | '` entry delimiter would
    // let a `summary` containing ` | [ENG-X] ...` mint a whole extra entry,
    // since dsh's `flatten()` splits entries on newlines only. `flatten()`
    // documents the contract: "core renders one per line as `[ID] statement`".
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
