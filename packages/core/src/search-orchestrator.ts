import type { Engram } from './schemas/engram.js'
import type { LlmFunction } from './types.js'
import { searchEngrams, ftsScore, ftsTokenize, computeIdf, engramSearchText } from './fts.js'
import { hybridSearchWithMeta } from './hybrid-search.js'
import { expandedSearch } from './query-expansion.js'

export type SearchStrategy = 'bm25' | 'hybrid' | 'expanded' | 'agentic'

export interface AutoSearchResult {
  results: Engram[]
  strategy_used: SearchStrategy
}

/**
 * The label a hybrid run earns. `hybridSearchWithMeta` degrades instead of
 * throwing when the embedder is unavailable (mode 'hybrid-degraded') or the
 * user disabled it ('bm25-only'); either way the fused list is lexical only,
 * so reporting 'hybrid' would claim a semantic leg that never ran
 * (formal R2, core-retrieval#9). Labels only — the routing below is unchanged.
 */
async function runHybrid(
  engrams: Engram[], query: string, limit: number, storagePath?: string,
): Promise<{ results: Engram[]; label: SearchStrategy }> {
  const r = await hybridSearchWithMeta(engrams, query, limit, storagePath)
  return { results: r.engrams, label: r.mode === 'hybrid' ? 'hybrid' : 'bm25' }
}

function isKeywordQuery(query: string): boolean {
  const words = query.trim().split(/\s+/)
  if (words.length >= 5) return false
  const nlSignals = /^(what|where|when|how|why|which|who|can|do|does|is|are|should|would|could)\b/i
  if (nlSignals.test(query.trim())) return false
  if (query.includes('?')) return false
  return true
}

function normalizedBm25Scores(engrams: Engram[], query: string): Map<string, number> {
  const queryTokens = ftsTokenize(query)
  if (queryTokens.length === 0) return new Map()
  const idfWeights = computeIdf(engrams, queryTokens)
  const avgDocLength = engrams.length > 0
    ? engrams.reduce((sum, e) => sum + ftsTokenize(engramSearchText(e)).length, 0) / engrams.length
    : 0
  const rawScores: Array<{ id: string; score: number }> = []
  for (const e of engrams) {
    const score = ftsScore(e, queryTokens, idfWeights, avgDocLength)
    if (score > 0) rawScores.push({ id: e.id, score })
  }
  if (rawScores.length === 0) return new Map()
  const min = Math.min(...rawScores.map(r => r.score))
  const max = Math.max(...rawScores.map(r => r.score))
  const range = max - min || 1
  const normalized = new Map<string, number>()
  for (const { id, score } of rawScores) {
    normalized.set(id, (score - min) / range)
  }
  return normalized
}

export async function recallAuto(
  engrams: Engram[],
  query: string,
  limit: number,
  storagePath?: string,
  llm?: LlmFunction,
): Promise<AutoSearchResult> {
  if (engrams.length === 0) return { results: [], strategy_used: 'bm25' }

  if (isKeywordQuery(query)) {
    const bm25Results = searchEngrams(engrams, query, limit)
    const scores = normalizedBm25Scores(engrams, query)
    const maxScore = bm25Results.length > 0 ? (scores.get(bm25Results[0].id) ?? 0) : 0
    if (bm25Results.length >= 3 && maxScore >= 0.3) {
      return { results: bm25Results, strategy_used: 'bm25' }
    }
    try {
      const hybrid = await runHybrid(engrams, query, limit, storagePath)
      if (hybrid.results.length >= 3) return { results: hybrid.results, strategy_used: hybrid.label }
    } catch { /* hybrid unavailable */ }
    if (llm) {
      try {
        const expandedResults = await expandedSearch(engrams, query, limit, llm, storagePath)
        return { results: expandedResults, strategy_used: 'expanded' }
      } catch { /* fall back */ }
    }
    return { results: bm25Results, strategy_used: 'bm25' }
  }

  let hybridResults: Engram[] = []
  let hybridLabel: SearchStrategy = 'hybrid'
  try {
    const hybrid = await runHybrid(engrams, query, limit, storagePath)
    hybridResults = hybrid.results
    hybridLabel = hybrid.label
  } catch {
    const bm25Results = searchEngrams(engrams, query, limit)
    return { results: bm25Results, strategy_used: 'bm25' }
  }

  const scores = normalizedBm25Scores(engrams, query)
  const maxScore = hybridResults.length > 0 ? (scores.get(hybridResults[0].id) ?? 0) : 0
  if (hybridResults.length >= 3 && maxScore >= 0.3) {
    return { results: hybridResults, strategy_used: hybridLabel }
  }

  if (llm) {
    try {
      const expandedResults = await expandedSearch(engrams, query, limit, llm, storagePath)
      return { results: expandedResults, strategy_used: 'expanded' }
    } catch { /* fall back */ }
  }

  if (hybridResults.length > 0) return { results: hybridResults, strategy_used: hybridLabel }
  return { results: searchEngrams(engrams, query, limit), strategy_used: 'bm25' }
}
