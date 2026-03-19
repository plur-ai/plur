import type { Engram, Association } from './schemas/engram.js'
import type { PackManifest } from './schemas/pack.js'
import type { LoadedPack } from './engrams.js'
import { decayedStrength, decayedCoAccessStrength, daysSince } from './decay.js'

export interface InjectionContext {
  prompt: string
  scope?: string
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
export type WireEngram = Omit<AgentEngram, 'keyword_match' | 'raw_score' | 'score'>

export interface InjectionResult {
  directives: WireEngram[]
  consider: WireEngram[]
  tokens_used: { directives: number; consider: number }
}

const DEFAULT_MAX_TOKENS = 8000
const DEFAULT_MIN_RELEVANCE = 0.3
const MAX_PER_PACK = 5
const MAX_PER_DOMAIN = 10

// DIP-0019 consider pool (bottom 1/3 of first-pass)
const DIP19_CONSIDER_MAX = 5
const DIP19_CONSIDER_BUDGET = 200

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

// --- Strip pipeline ---

function stripAssociations(engram: ScoredEngram): AgentEngram {
  const { associations: _, ...rest } = engram
  return rest
}

function stripScoring(engram: AgentEngram): WireEngram {
  const { keyword_match: _, raw_score: _r, score: _s, ...rest } = engram
  return rest
}

// --- Scoring ---

export function scoreEngram(
  engram: Engram,
  promptLower: string,
  promptWords: Set<string>,
  packMatchTerms: string[],
  scopeFilter: string | undefined,
  isPack: boolean,
): number {
  // Scope filtering: if scope is specified, only include matching engrams
  if (scopeFilter) {
    if (scopeFilter === 'global') {
      if (engram.scope !== 'global') return 0
    } else if (!engram.scope.startsWith(scopeFilter) && engram.scope !== 'global') {
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

  if (termHits === 0) return 0

  // Base score from term hits * (decayed) retrieval strength
  // Pack engrams use raw RS (read-only, can't track usage)
  const rs = isPack
    ? engram.activation.retrieval_strength
    : decayedStrength(engram.activation.retrieval_strength, daysSince(engram.activation.last_accessed))
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

  return score
}

// --- Token budget filler ---

export function fillTokenBudget(
  scored: ScoredEngram[],
  maxTokens: number,
): { selected: ScoredEngram[]; tokens_used: number } {
  const result: ScoredEngram[] = []
  const packCounts = new Map<string, number>()
  const domainCounts = new Map<string, number>()
  let tokensUsed = 0

  for (const engram of scored) {
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
  return { selected: result, tokens_used: tokensUsed }
}

// --- Main injection function ---

export function selectAndSpread(
  ctx: InjectionContext,
  personalEngrams: Engram[],
  packs: LoadedPack[],
  config?: { spread_cap?: number; spread_budget?: number },
): InjectionResult {
  const spreadCap = config?.spread_cap ?? 3
  const spreadBudget = config?.spread_budget ?? 480

  const promptLower = ctx.prompt.toLowerCase()
  const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 2))
  const maxTokens = ctx.maxTokens ?? DEFAULT_MAX_TOKENS
  const minRelevance = ctx.minRelevance ?? DEFAULT_MIN_RELEVANCE

  // Step 0: Build engram map for spreading activation
  const engramMap = new Map<string, Engram>()

  // Step 1-2: Score all active engrams
  const scored: ScoredEngram[] = []

  for (const engram of personalEngrams) {
    if (engram.status !== 'active') continue
    engramMap.set(engram.id, engram)
    const raw = scoreEngram(engram, promptLower, promptWords, [], ctx.scope, false)
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
      engramMap.set(engram.id, engram)
      const raw = scoreEngram(engram, promptLower, promptWords, matchTerms, ctx.scope, true)
      if (raw > 0) {
        scored.push({ ...engram, keyword_match: raw, raw_score: raw, score: raw })
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

  // Step 5: Filter by minimum relevance
  const filtered = scored.filter(s => s.score >= minRelevance)

  // Sort by score descending
  filtered.sort((a, b) => b.score - a.score)

  // Step 6: Fill directive token budget
  const { selected: directives, tokens_used: directiveTokens } = fillTokenBudget(filtered, maxTokens)
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
      consider: [],
      tokens_used: { directives: 0, consider: 0 },
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

  const wireDirectives = agentDirectives.map(stripScoring)
  const wireConsider = agentConsider.map(stripScoring)

  const considerTokens = dip19PoolTokens + spreadTokens

  return {
    directives: wireDirectives,
    consider: wireConsider,
    tokens_used: { directives: directiveTokens, consider: considerTokens },
  }
}

// --- Public wrapper functions for Plur class ---

export interface PublicScoredEngram { engram: Engram; score: number }

export function scoreEngramsPublic(
  engrams: Engram[],
  task: string,
  options?: { scope?: string },
): PublicScoredEngram[] {
  const promptLower = task.toLowerCase()
  const promptWords = new Set(promptLower.split(/\W+/).filter(w => w.length > 2))
  return engrams.map(e => ({
    engram: e,
    score: scoreEngram(e, promptLower, promptWords, [], options?.scope, false),
  })).sort((a, b) => b.score - a.score)
}
