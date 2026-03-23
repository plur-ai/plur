import type { Engram } from './schemas/engram.js'
import { searchEngrams } from './fts.js'
import { embeddingSearch } from './embeddings.js'

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
  if (engrams.length === 0) return []

  const exhaustive = isAggregationQuery(query)

  // For aggregation queries, cast a much wider net
  const effectiveLimit = exhaustive ? Math.max(limit, 50) : limit
  const bm25Limit = Math.min(engrams.length, exhaustive ? effectiveLimit * 5 : effectiveLimit * 3)
  const embLimit = Math.min(engrams.length, exhaustive ? effectiveLimit * 3 : effectiveLimit * 2)

  const [bm25Results, embResults] = await Promise.all([
    Promise.resolve(searchEngrams(engrams, query, bm25Limit)),
    embeddingSearch(engrams, query, embLimit, storagePath),
  ])

  const merged = rrfMerge([bm25Results, embResults])
  return merged.slice(0, effectiveLimit)
}
