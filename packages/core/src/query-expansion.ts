import type { Engram } from './schemas/engram.js'
import type { LlmFunction } from './types.js'
import { hybridSearch } from './hybrid-search.js'

/**
 * Query expansion: LLM rewrites the query into multiple variants,
 * then hybrid search runs on each variant, and results are merged via RRF.
 *
 * This addresses the keyword mismatch problem — if the user asks about
 * "database" but the engram says "PostgreSQL", BM25 misses it. Query
 * expansion generates variants like "database", "SQL", "PostgreSQL",
 * "data store" that cover more ground.
 *
 * Opt-in: requires an LLM function. Adds ~1-2s latency and one LLM call.
 */

const EXPANSION_PROMPT = `You are a search query expander. Given a user query, generate 3 alternative search queries that capture the same intent but use different words, synonyms, or related concepts.

Return ONLY the 3 queries, one per line, nothing else. No numbering, no explanations.

Query: "{query}"`

const AGGREGATION_EXPANSION_PROMPT = `You are a search query expander for an aggregation query. The user wants to COUNT or TOTAL something across multiple conversations. Generate 5 search queries that will find ALL individual instances — each query should target a different way the item might have been mentioned.

For example, if the query is "How many weddings did I attend?", generate queries like:
- wedding ceremony attended
- went to wedding reception
- wedding invitation RSVP
- marriage celebration
- attended wedding of

Return ONLY the 5 queries, one per line. No numbering, no explanations.

Query: "{query}"`

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

/** Parse LLM response into query variants */
function parseVariants(response: string, original: string): string[] {
  const variants = response
    .split('\n')
    .map(line => line.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(line => line.length > 3 && line.length < 200)
    .slice(0, 3)

  // Always include the original query
  return [original, ...variants]
}

/**
 * Reciprocal Rank Fusion across multiple result sets.
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

/**
 * Expanded search: query expansion + hybrid search + RRF merge.
 *
 * Pipeline:
 * 1. LLM generates query variants (3 for normal, 5 for aggregation)
 * 2. Hybrid search (BM25+embeddings) runs on original + variants
 * 3. Results from all searches are merged via RRF
 *
 * For aggregation queries ("how many", "total"), uses a specialized prompt
 * that generates entity-focused variants to find ALL mentions across
 * conversations, not just the top few.
 *
 * Cost: 1 LLM call (~$0.001) + N× hybrid search
 */
export async function expandedSearch(
  engrams: Engram[],
  query: string,
  limit: number,
  llm: LlmFunction,
  storagePath?: string,
): Promise<Engram[]> {
  if (engrams.length === 0) return []

  const aggregation = isAggregationQuery(query)

  // Step 1: Generate query variants — more for aggregation queries
  let variants: string[]
  try {
    const promptTemplate = aggregation ? AGGREGATION_EXPANSION_PROMPT : EXPANSION_PROMPT
    const prompt = promptTemplate.replace('{query}', query)
    const response = await llm(prompt)
    variants = parseVariants(response, query)
    if (aggregation) {
      // Allow up to 5 variants for aggregation (parseVariants caps at 3)
      const extra = response
        .split('\n')
        .map(line => line.replace(/^\d+[\.\)]\s*/, '').trim())
        .filter(line => line.length > 3 && line.length < 200)
        .slice(0, 5)
      variants = [query, ...extra]
    }
  } catch {
    variants = [query]
  }

  // Step 2: Run hybrid search for each variant
  // For aggregation, use higher limit per variant to catch all mentions
  const perVariantLimit = aggregation ? Math.max(limit, 50) : limit
  const searchPromises = variants.map(v =>
    hybridSearch(engrams, v, perVariantLimit, storagePath)
  )
  const resultSets = await Promise.all(searchPromises)

  // Step 3: Merge via RRF — aggregation returns more results
  const merged = rrfMerge(resultSets)
  const effectiveLimit = aggregation ? Math.max(limit, 50) : limit
  return merged.slice(0, effectiveLimit)
}
