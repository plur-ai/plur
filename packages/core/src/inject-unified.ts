/**
 * Unified injection selection (retrieval and injection overhaul, W1).
 *
 * Injection = an always-on slot (the pinned engrams, up to their share of
 * the budget) + recall's ranked list packed into what the pins leave. It
 * replaces the legacy selection's own keyword-overlap score, constraints floor
 * and spreading activation when `injection.mode: unified`.
 *
 * Order of work (R3, R4, R6, D3, D4, W8):
 *   1. One visibility predicate (`isInjectVisible`) and the delivery gates —
 *      active, not a draft, temporally valid, not in an on_request pack, not
 *      replaced by a deliverable engram — over the WHOLE visible store, before
 *      any search. Nothing hidden here can come back later.
 *   2. The always-on slot: pins, ordered origin → hard tier → priority, and
 *      for pins without a priority prohibitions first, then oldest first.
 *   3. Rank the rest with recall's search. `Plur` runs the very search
 *      `recallHybridWithMeta` runs (BM25 over the rewritten query and the
 *      meaning leg fused by RRF, intent routing, the reranker when
 *      configured) and hands its order to `orderRecallCandidates`; the pure
 *      `rankForInjection` here uses the same fusion (`fuseLegs`) over a
 *      caller-supplied meaning map. A superseded engram with no deliverable
 *      replacement takes ×0.3 here, before the cut.
 *   4. Prohibitions in the ranked top 50 with a keyword hit or a meaning
 *      similarity over `EMBEDDING_RELEVANCE_FLOOR` get up to
 *      `prohibition_ratio` of the budget (withheld, like the task list, when
 *      the W8 gate is set and nothing clears it), then the task list takes
 *      up to `recall_limit` of the ranking, packed in rank order into `maxTokens − pinned_spent − prohibitions`,
 *      skipping an engram that does not fit and continuing. Per-pack and
 *      per-domain diversity caps apply.
 *   5. Render into the three sections (directives, constraints, consider) by
 *      the same routing the legacy path uses, after selection.
 *
 * Pure: no store reads, no writes, no clock other than the validity check.
 * The search here writes nothing (R5); `Plur._formatInjection` keeps
 * injection's own single set of writes.
 */
import type { Engram } from './schemas/engram.js'
import type { LoadedPack } from './engrams.js'
import { parseNamespacedId } from './engrams.js'
import { comparePinTiebreak, isProhibition } from './pin-policy.js'
import { searchEngramsScored } from './fts.js'
import { fuseLegs } from './hybrid-search.js'
import { rewriteLexicalQuery } from './intent/rewrite.js'
import {
  type InjectionContext, type InternalInjectionResult, type ScoredEngram, type WireEngram, type ExpiryConfig, type OmittedPinned,
  isInjectVisible, skipForApproval, skipForValidity, isReplacedByDeliverable, isPrimaryRow, hasHistoricalIntent,
  isSupersededEngram, getPackMetadata, stripAssociations, stripScoring, splitWireSections, estimateTokens,
  fillTokenBudget, hardPinnedReserve, pinnedHardCap, DEFAULT_PINNED_HARD_RATIO, PINNED_TOKEN_BUDGET_RATIO,
  DEFAULT_MAX_TOKENS, DEFAULT_GRACE_DAYS, MAX_PER_PACK, MAX_PER_DOMAIN, packKeyOf, EMBEDDING_RELEVANCE_FLOOR,
} from './inject.js'

/** Signals the W8 relevance gate can be set on (`injection.min_relevance_signal`). */
export type RelevanceSignalName = 'reranker' | 'rank_gap' | 'keyword' | 'cosine' | 'combined' | 'enrichment_kind'

/**
 * Per-injection relevance signals (W8 plumbing), for an offline study to pick
 * a cut-off signal. Null when the signal did not exist on this call.
 */
export interface RelevanceSignals {
  /** RRF fusion score of the top-ranked task candidate (after the ×0.3 re-rank). */
  top_fused: number | null
  /** Fusion score of rank 1 minus that of rank 5 (0 past the end of a shorter list). */
  rank_gap: number | null
  /** Highest meaning-model similarity among the task candidates. */
  top_cosine: number | null
  /** The top keyword hit's query coverage, in [0, 1] (IDF-weighted share of the query's words it contains). */
  top_keyword: number | null
  /** The reranker's raw score for the top candidate, when the reranker ran. */
  reranker: number | null
  /** True when `min_relevance_signal` was set and nothing cleared it: the task section is empty. */
  gated: boolean
  /** The configured gate signal, when its value was not available on this call (the gate then does not apply). */
  gate_unavailable?: RelevanceSignalName
}

export interface UnifiedConfig {
  expiry?: ExpiryConfig
  pinned_hard_ratio?: number
  pinned_ratio?: number
  /** Default true. False: no always-on slot, and pins stay out of the task list. */
  include_pinned?: boolean
  /** Task list length after the gates. Default 10. */
  recall_limit?: number
  /** Share of the budget prohibitions in the ranked top 50 may take first. Default 0.2. */
  prohibition_ratio?: number
  /** W8 gate signal; null/absent = no gate. */
  min_relevance_signal?: RelevanceSignalName | null
  /** W8 gate threshold; null/absent = no gate. */
  min_relevance?: number | null
  /** Rewrite the lexical query as recall does (`rewriteLexicalQuery`). Default true. */
  query_rewrite?: boolean
}

/** Default task-list length (`injection.recall_limit`). */
export const UNIFIED_RECALL_LIMIT = 10
/** Default prohibition slice (`injection.prohibition_ratio`, D4). */
export const UNIFIED_PROHIBITION_RATIO = 0.2
/** How deep in the ranking prohibitions are taken from (D4). */
export const PROHIBITION_DEPTH = 50
/** ×0.3 for a superseded engram with no deliverable replacement (as in legacy). */
const SUPERSEDED_PENALTY = 0.3
const RRF_K = 60

/** One ranked task candidate. */
export interface RankedCandidate {
  engram: Engram
  fused: number
  cosine: number | null
  keyword: number | null
  coverage: number | null
}

/** The unified selection's result: the legacy shape plus the W8 signals. */
export type UnifiedResult = InternalInjectionResult & {
  relevance: RelevanceSignals
  /** How many engrams the general task list delivered. */
  task_count: number
  /** The general task list's ids, in rank order. */
  task_ids: string[]
}

/** The gated candidate pool: everything this injection may deliver. */
export interface UnifiedPool {
  /** Deliverable, visible, unpinned task candidates. */
  candidates: Engram[]
  /** Deliverable, visible pins (empty when `include_pinned` is false). */
  pins: Engram[]
  /** Superseded candidates with no deliverable replacement (×0.3). */
  penalised: Set<string>
}

/**
 * Step 1: the gates over the whole visible store (R3, R4). The same gates,
 * in the same order, as the legacy loops in `selectAndSpread`.
 */
export function buildUnifiedPool(
  ctx: Pick<InjectionContext, 'prompt' | 'scope' | 'grantedScopes'>,
  personalEngrams: Engram[],
  packs: LoadedPack[],
  config: Pick<UnifiedConfig, 'expiry' | 'include_pinned'> = {},
): UnifiedPool {
  const nowMs = Date.now()
  const expiryMode = config.expiry?.mode ?? 'hard'
  const graceDays = config.expiry?.grace_days ?? DEFAULT_GRACE_DAYS
  const includePinned = config.include_pinned !== false
  const historical = hasHistoricalIntent(ctx.prompt)

  const deliverableIds = new Set<string>()
  const supersededBy = new Map<string, readonly string[]>()
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

  const visible: Engram[] = []
  const admit = (engram: Engram, packName?: string) => {
    if (engram.relations?.superseded_by?.length) supersededBy.set(engram.id, engram.relations.superseded_by)
    if (engram.status !== 'active') return
    // Visibility FIRST and once: an engram this injection cannot see is not a
    // candidate for any slot, and no later step can revive it (R4).
    if (!isInjectVisible(engram.scope, ctx.scope, ctx.grantedScopes)) return
    if (skipForApproval(engram) || skipForValidity(engram, nowMs, expiryMode, graceDays)) return
    deliverableIds.add(engram.id)
    visible.push(packName ? ({ ...engram, _pack: packName } as Engram) : engram)
  }
  for (const e of personalEngrams) admit(e)
  for (const pack of packs) {
    if (getPackMetadata(pack.manifest).injection_policy === 'on_request') continue
    for (const e of pack.engrams) admit(e, pack.manifest.name)
  }

  const candidates: Engram[] = []
  const pins: Engram[] = []
  const penalised = new Set<string>()
  for (const e of visible) {
    // Replaced by an engram this session can deliver: not current (outside a
    // historical prompt), so not a candidate for any slot.
    if (!historical && isReplacedByDeliverable(e, deliverableIds, supersededBy, replacedFromPrimary)) continue
    if ((e as { pinned?: boolean }).pinned === true) {
      if (includePinned) pins.push(e)
      continue
    }
    if (!historical && isSupersededEngram(e)) penalised.add(e.id)
    candidates.push(e)
  }
  return { candidates, pins, penalised }
}

/**
 * Step 3: recall's ranking over the gated candidates, without bookkeeping.
 *
 * The keyword leg is BM25 over the lexically rewritten query (as recall's);
 * the meaning leg is `meaning` (id → similarity) when the caller ran the
 * meaning model. Fused as recall fuses them: RRF with each keyword hit
 * weighted by its query coverage. Leg depths follow recall's proportions for
 * a fetch of `depth` (keyword 3×, meaning 2×). The ×0.3 re-rank of
 * superseded-without-replacement candidates is applied before sorting.
 */
export function rankForInjection(
  pool: Pick<UnifiedPool, 'candidates' | 'penalised'>,
  query: string,
  meaning?: ReadonlyMap<string, number>,
  opts: { query_rewrite?: boolean; depth?: number } = {},
): RankedCandidate[] {
  const candidates = pool.candidates
  if (candidates.length === 0) return []
  const depth = Math.max(1, opts.depth ?? PROHIBITION_DEPTH)
  const lexical = opts.query_rewrite === false ? query : rewriteLexicalQuery(query)
  const kw = searchEngramsScored(candidates, lexical, Math.min(candidates.length, depth * 3))
  const byId = new Map(candidates.map(e => [e.id, e]))
  const meaningRanked = meaning && meaning.size > 0
    ? [...meaning.entries()]
      .filter(([id, s]) => byId.has(id) && s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.min(candidates.length, depth * 2))
    : []
  // The same fusion recall uses (hybrid-search `fuseLegs`).
  const out = fuseLegs(kw, meaningRanked.map(([id]) => byId.get(id)!))
    .map((f): RankedCandidate => ({ engram: f.engram, fused: f.score, cosine: meaning?.get(f.engram.id) ?? null, keyword: f.keyword, coverage: f.coverage }))
  const ranked = out
  for (const c of ranked) if (pool.penalised.has(c.engram.id)) c.fused *= SUPERSEDED_PENALTY
  // Stable: ties keep the keyword-then-meaning order they arrived in.
  return ranked.sort((a, b) => b.fused - a.fused)
}

/**
 * Recall's ranked ids (`order`, already routed and reranked by recall's own
 * search) as task candidates: ids the gates removed (not in the pool) drop
 * out, everything else keeps recall's order. A superseded candidate with no
 * deliverable replacement (`pool.penalised`) takes ×0.3 on its fused score
 * and moves down past the candidates that now outscore it, as legacy does.
 * `fused` carries each id's RRF score when the search reported it (else a
 * rank-derived one), `meaning` the raw cosine for the W8 signals.
 */
export function orderRecallCandidates(
  order: readonly string[],
  pool: Pick<UnifiedPool, 'candidates' | 'penalised'>,
  fused: ReadonlyMap<string, { score: number; keyword: number | null; coverage: number | null }>,
  meaning?: ReadonlyMap<string, number>,
): RankedCandidate[] {
  const byId = new Map(pool.candidates.map(e => [e.id, e]))
  const list: RankedCandidate[] = []
  order.forEach((id, pos) => {
    const engram = byId.get(id)
    if (!engram) return
    const f = fused.get(id)
    list.push({ engram, fused: f?.score ?? 1 / (RRF_K + pos + 1), cosine: meaning?.get(id) ?? null, keyword: f?.keyword ?? null, coverage: f?.coverage ?? null })
  })
  if (pool.penalised.size === 0) return list
  const kept: RankedCandidate[] = []
  const demoted: Array<{ c: RankedCandidate; from: number }> = []
  for (const c of list) {
    if (pool.penalised.has(c.engram.id)) { c.fused *= SUPERSEDED_PENALTY; demoted.push({ c, from: kept.length }) }
    else kept.push(c)
  }
  // Each demoted candidate goes before the first kept candidate, at or after
  // its own place, that it still outscores; ties keep recall's order.
  const slot = (from: number, f: number) => { let at = from; while (at < kept.length && kept[at].fused >= f) at++; return at }
  const keyed = [
    ...kept.map((c, i) => ({ c, key: i, tie: 0 })),
    ...demoted.map(({ c, from }, i) => ({ c, key: slot(from, c.fused) - 0.5, tie: i })),
  ]
  return keyed.sort((x, y) => x.key - y.key || x.tie - y.tie).map(k => k.c)
}

/** Reorder the head of a ranking by reranker scores (id → score). */
export function applyRerankScores(ranked: RankedCandidate[], scores: ReadonlyMap<string, number>): RankedCandidate[] {
  if (scores.size === 0) return ranked
  const head = ranked.filter(c => scores.has(c.engram.id))
  const tail = ranked.filter(c => !scores.has(c.engram.id))
  head.sort((a, b) => scores.get(b.engram.id)! - scores.get(a.engram.id)!)
  return [...head, ...tail]
}

/** The W8 signals for a ranking (and the reranker's scores, when it ran). */
export function relevanceSignals(ranked: RankedCandidate[], rerank?: ReadonlyMap<string, number>): RelevanceSignals {
  const top = ranked[0]
  let topCosine: number | null = null
  for (const c of ranked) if (c.cosine !== null && (topCosine === null || c.cosine > topCosine)) topCosine = c.cosine
  // The top KEYWORD hit's coverage, not the top fused candidate's.
  let topKw: RankedCandidate | undefined
  for (const c of ranked) if (c.keyword !== null && (!topKw || c.keyword > (topKw.keyword ?? 0))) topKw = c
  return {
    top_fused: top ? top.fused : null,
    rank_gap: top ? top.fused - (ranked[4]?.fused ?? 0) : null,
    top_cosine: topCosine,
    top_keyword: topKw ? topKw.coverage : null,
    reranker: rerank && rerank.size > 0 && top && rerank.has(top.engram.id) ? rerank.get(top.engram.id)! : null,
    gated: false,
  }
}

function signalValue(s: RelevanceSignals, name: RelevanceSignalName): number | null {
  switch (name) {
    case 'reranker': return s.reranker
    case 'rank_gap': return s.rank_gap
    case 'keyword': return s.top_keyword
    case 'cosine': return s.top_cosine
    // Not defined until the signal study picks a combination / enrichment lands.
    case 'combined': return null
    case 'enrichment_kind': return null
  }
}

const asScored = (e: Engram, score: number): ScoredEngram => ({ ...e, keyword_match: score, raw_score: score, score })

/**
 * Steps 2, 4 and 5 over a pool and its ranking. Separate from the ranking so
 * a caller can rerank (async, time-capped) in between.
 */
export function packUnified(
  ctx: Pick<InjectionContext, 'maxTokens'>,
  pool: UnifiedPool,
  ranked: RankedCandidate[],
  config: UnifiedConfig = {},
  rerank?: ReadonlyMap<string, number>,
): UnifiedResult {
  const maxTokens = ctx.maxTokens ?? DEFAULT_MAX_TOKENS
  const hardRatio = config.pinned_hard_ratio ?? DEFAULT_PINNED_HARD_RATIO
  const pinnedRatio = config.pinned_ratio ?? PINNED_TOKEN_BUDGET_RATIO
  const recallLimit = Math.max(0, config.recall_limit ?? UNIFIED_RECALL_LIMIT)
  const prohibitionRatio = Math.min(1, Math.max(0, config.prohibition_ratio ?? UNIFIED_PROHIBITION_RATIO))

  // ── 2. Always-on slot. fillTokenBudget orders pins by origin, hard tier and
  // priority, then score; the score here encodes D3's default for pins with
  // equal priority — pin-policy's comparePinTiebreak (prohibitions first,
  // then oldest first, then id), the same order `plur pins` reports.
  const pinOrder = [...pool.pins].sort(comparePinTiebreak)
  const pinScored = pinOrder.map((e, i) => asScored(e, pinOrder.length - i))
  const ledger = {
    spent: 0,
    hardSpent: 0,
    hardReserve: hardPinnedReserve(pinScored, pinnedHardCap(maxTokens, hardRatio, pinnedRatio)),
  }
  const pinPass = fillTokenBudget(pinScored, maxTokens, maxTokens, ledger, hardRatio, pinnedRatio)
  const selected: ScoredEngram[] = [...pinPass.selected]
  let spent = pinPass.tokens_used

  // Diversity caps shared across the slices, seeded by the pins (as legacy).
  const packCounts = new Map<string, number>()
  const domainCounts = new Map<string, number>()
  const count = (e: Engram) => {
    const pack = packKeyOf(e as never)
    packCounts.set(pack, (packCounts.get(pack) ?? 0) + 1)
    const top = (e.domain ?? '__none__').split('.')[0]
    domainCounts.set(top, (domainCounts.get(top) ?? 0) + 1)
  }
  for (const e of selected) count(e)
  const capped = (e: Engram): boolean => {
    const pack = packKeyOf(e as never)
    if (pack !== '__personal__' && (packCounts.get(pack) ?? 0) >= MAX_PER_PACK) return true
    return (domainCounts.get((e.domain ?? '__none__').split('.')[0]) ?? 0) >= MAX_PER_DOMAIN
  }
  const taken = new Set(selected.map(e => e.id))
  /** Skip-and-continue packing (R6). Returns tokens used. */
  const pack = (list: RankedCandidate[], cap: number, maxItems: number): number => {
    let used = 0
    let items = 0
    for (const c of list) {
      if (items >= maxItems) break
      if (taken.has(c.engram.id) || capped(c.engram)) continue
      const scored = asScored(c.engram, c.fused)
      const cost = estimateTokens(scored)
      if (used + cost > cap || spent + used + cost > maxTokens) continue
      selected.push(scored)
      taken.add(c.engram.id)
      count(c.engram)
      used += cost
      items++
    }
    return used
  }

  // ── W8 gate (default off). When nothing clears it, the prohibition slice
  // and the general task list are withheld; the always-on slot stays.
  const relevance = relevanceSignals(ranked, rerank)
  const gateSignal = config.min_relevance_signal ?? null
  const gateThreshold = config.min_relevance ?? null
  if (gateSignal && gateThreshold !== null) {
    const v = signalValue(relevance, gateSignal)
    if (v === null) relevance.gate_unavailable = gateSignal
    else if (v < gateThreshold) relevance.gated = true
  }

  // ── 4a. Prohibition slice (D4): relevance-based, from the ranked top 50.
  // A prohibition the meaning leg merely ranked (every engram gets a rank
  // there) is not relevant by that alone: it needs a keyword hit or a
  // similarity over the legacy embedding floor.
  const relevant = (c: RankedCandidate) => c.keyword !== null || (c.cosine !== null && c.cosine > EMBEDDING_RELEVANCE_FLOOR)
  const prohibitions = relevance.gated ? [] : ranked.slice(0, PROHIBITION_DEPTH).filter(c => isProhibition(c.engram) && relevant(c))
  spent += pack(prohibitions, Math.floor(maxTokens * prohibitionRatio), Number.POSITIVE_INFINITY)

  // ── 4b. Task list: recall's ranking, up to recall_limit, into what is left.
  const before = selected.length
  if (!relevance.gated) spent += pack(ranked, maxTokens - spent, recallLimit)
  const taskCount = selected.length - before
  const taskIds = selected.slice(before).map(e => e.id)

  // ── 5. Render. Sections assigned after selection, by the legacy routing.
  const wire: WireEngram[] = selected.map(e => stripScoring(stripAssociations(e)))
  const { directives, constraints, demoted } = splitWireSections(wire)
  return {
    directives,
    constraints,
    consider: demoted,
    tokens_used: { directives: spent, consider: 0 },
    omitted_pinned: dedupe(pinPass.omitted_pinned, selected),
    relevance,
    task_count: taskCount,
    task_ids: taskIds,
  }
}

function dedupe(all: OmittedPinned[], selected: ScoredEngram[]): OmittedPinned[] {
  const chosen = new Set(selected.map(e => e.id))
  const seen = new Set<string>()
  return all.filter(o => !chosen.has(o.id) && !seen.has(o.id) && (seen.add(o.id), true))
}

/**
 * The whole unified selection in one synchronous call (no reranker): gates,
 * ranking, packing, rendering. `meaning` is the meaning model's similarity
 * per id, when it ran.
 */
export function selectUnified(
  ctx: InjectionContext,
  personalEngrams: Engram[],
  packs: LoadedPack[],
  config: UnifiedConfig = {},
  meaning?: ReadonlyMap<string, number>,
): UnifiedResult {
  const pool = buildUnifiedPool(ctx, personalEngrams, packs, config)
  return rankAndPack(ctx, pool, config, meaning)
}

/**
 * Rank and pack, fetching deeper until the task list has `recall_limit`
 * survivors or the candidates run out (R3). The gates ran before the search,
 * so only the diversity caps and the budget can skip a ranked candidate.
 */
export function rankAndPack(
  ctx: InjectionContext,
  pool: UnifiedPool,
  config: UnifiedConfig = {},
  meaning?: ReadonlyMap<string, number>,
  rerank?: (ranked: RankedCandidate[]) => { ranked: RankedCandidate[]; scores?: ReadonlyMap<string, number> },
): UnifiedResult {
  const limit = Math.max(0, config.recall_limit ?? UNIFIED_RECALL_LIMIT)
  let depth = Math.max(PROHIBITION_DEPTH, limit * 5)
  for (;;) {
    let ranked = rankForInjection(pool, ctx.prompt, meaning, { query_rewrite: config.query_rewrite, depth })
    let scores: ReadonlyMap<string, number> | undefined
    if (rerank) ({ ranked, scores } = rerank(ranked))
    const res = packUnified(ctx, pool, ranked, config, scores)
    // Both legs must have offered every candidate before the search stops:
    // the keyword leg fetches 3× the depth but the meaning leg only 2×, so
    // stopping on the keyword leg alone would never offer meaning-only
    // candidates ranked past 2× the depth.
    const exhausted = (meaning && meaning.size > 0 ? depth * 2 : depth * 3) >= pool.candidates.length
    if (res.task_count >= limit || res.relevance.gated || exhausted) return res
    depth *= 4
  }
}

/** Cap on the extended query (W5): enough for retrieval, bounded for embedding cost. */
export const INJECTION_QUERY_MAX_CHARS = 2000

/**
 * The query an injection searches with (W5): the task, then each context part
 * the caller supplied (session task, scope label, branch, recent turns) that
 * is non-empty and not already contained, joined by newlines and capped.
 * Without context, the task unchanged.
 */
export function buildInjectionQuery(task: string, context?: readonly unknown[]): string {
  if (!context || context.length === 0) return task
  const parts = [task]
  const seen = new Set([task.trim().toLowerCase()])
  for (const c of context) {
    if (typeof c !== 'string') continue
    const t = c.trim()
    const key = t.toLowerCase()
    if (!t || seen.has(key)) continue
    seen.add(key)
    parts.push(t)
  }
  return parts.join('\n').slice(0, Math.max(task.length, INJECTION_QUERY_MAX_CHARS))
}
