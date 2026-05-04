import type { Engram } from './schemas/engram.js'
import { searchEngrams } from './fts.js'
import { embeddingSearch, embedderStatus } from './embeddings.js'

/** Result of a hybrid search call with diagnostic metadata. */
export interface HybridSearchResult {
  engrams: Engram[]
  /**
   * - "hybrid": both BM25 and embeddings contributed (full operation).
   * - "hybrid-degraded": embeddings were configured to load but failed —
   *   ran BM25-only as a fallback. Indicates a fault to surface to the user.
   * - "bm25-only": embeddings are explicitly disabled (env var or
   *   config.yaml); ran BM25 by design. Not a fault, no remediation needed.
   */
  mode: 'hybrid' | 'hybrid-degraded' | 'bm25-only'
  embedderError: string | null
}

/**
 * Reciprocal Rank Fusion (RRF) merges results from multiple search methods.
 *
 * RRF formula: score(d) = Σ 1 / (k + rank_i(d))
 * where k is a constant (typically 60) and rank_i is the rank in result list i.
 *
 * This gives high-ranked results from ANY method a boost, while naturally
 * handling the case where a result appears in multiple lists (scores add up).
 */
function rrfMerge(resultSets: Engram[][], k = 60): Engram[] {
  const scores = new Map<string, { engram: Engram; score: number }>()

  for (const results of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const engram = results[rank]
      const existing = scores.get(engram.id)
      const rrfScore = 1 / (k + rank + 1)
      if (existing) {
        existing.score += rrfScore
      } else {
        scores.set(engram.id, { engram, score: rrfScore })
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(s => s.engram)
}

/** Detect aggregation queries that need exhaustive retrieval */
const AGGREGATION_PATTERNS = [
  /how many/i,
  /how much/i,
  /total (?:number|amount|cost|time|hours|days|spent)/i,
  /all (?:the|my)/i,
  /every (?:time|instance)/i,
  /(?:count|sum|add up|combine|altogether)/i,
  /in the (?:past|last) (?:week|month|year|few)/i,
  /did I (?:attend|visit|go to|buy|spend|do)/i,
]

function isAggregationQuery(query: string): boolean {
  return AGGREGATION_PATTERNS.some(p => p.test(query))
}

/**
 * Hybrid search: BM25 + embedding search merged via RRF.
 *
 * Runs both search methods in parallel, then fuses results.
 * No LLM calls — fully local, ~500ms with cached embeddings.
 *
 * Automatically detects aggregation queries ("how many", "total", etc.)
 * and switches to exhaustive mode — wider retrieval to capture ALL
 * mentions across conversations, not just the top few.
 */
export async function hybridSearch(
  engrams: Engram[],
  query: string,
  limit: number,
  storagePath?: string,
): Promise<Engram[]> {
  const result = await hybridSearchWithMeta(engrams, query, limit, storagePath)
  return result.engrams
}

/**
 * Same as hybridSearch but returns metadata about whether embeddings
 * actually contributed. Use this when you want to surface a
 * "hybrid-degraded" warning to users instead of silent fallback.
 */
export async function hybridSearchWithMeta(
  engrams: Engram[],
  query: string,
  limit: number,
  storagePath?: string,
): Promise<HybridSearchResult> {
  if (engrams.length === 0) {
    return { engrams: [], mode: 'hybrid', embedderError: null }
  }

  const exhaustive = isAggregationQuery(query)
  const effectiveLimit = exhaustive ? Math.max(limit, 50) : limit
  const bm25Limit = Math.min(engrams.length, exhaustive ? effectiveLimit * 5 : effectiveLimit * 3)
  const embLimit = Math.min(engrams.length, exhaustive ? effectiveLimit * 3 : effectiveLimit * 2)

  const [bm25Results, embResults] = await Promise.all([
    Promise.resolve(searchEngrams(engrams, query, bm25Limit)),
    embeddingSearch(engrams, query, embLimit, storagePath),
  ])

  const status = embedderStatus()
  // Three-way mode:
  //   - bm25-only: user opted out (env var or config) — by design, not a fault.
  //   - hybrid-degraded: embeddings were configured to load but failed.
  //   - hybrid: both methods contributed.
  // Empty embResults with no error means "no semantic neighbors above
  // threshold", which is normal — don't flag as degraded.
  let mode: 'hybrid' | 'hybrid-degraded' | 'bm25-only'
  let embedderError: string | null = null
  if (status.disabled) {
    mode = 'bm25-only'
  } else if (!status.available || (embResults.length === 0 && !!status.lastError)) {
    mode = 'hybrid-degraded'
    embedderError = status.lastError
  } else {
    mode = 'hybrid'
  }

  const merged = rrfMerge([bm25Results, embResults])
  return {
    engrams: merged.slice(0, effectiveLimit),
    mode,
    embedderError,
  }
}
