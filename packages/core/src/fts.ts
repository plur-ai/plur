import type { Engram } from './schemas/engram.js'

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
  'were', 'been', 'have', 'has', 'not', 'but', 'its', 'you', 'your',
  'can', 'will', 'should', 'would', 'could', 'may', 'might',
])

/** Tokenize text into searchable terms */
export function ftsTokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .filter(w => !STOP_WORDS.has(w))
}

/** Score an engram against query tokens */
export function ftsScore(engram: Engram, queryTokens: string[]): number {
  const statementTokens = ftsTokenize(engram.statement)
  const domainTokens = engram.domain ? ftsTokenize(engram.domain.replace(/\./g, ' ')) : []
  const tagTokens = engram.tags.map(t => t.toLowerCase())
  const allTerms = [...statementTokens, ...domainTokens, ...tagTokens]
  let matches = 0
  for (const qt of queryTokens) {
    if (allTerms.some(t => t.includes(qt) || qt.includes(t))) matches++
  }
  return queryTokens.length > 0 ? matches / queryTokens.length : 0
}

/** Search engrams by text query */
export function searchEngrams(engrams: Engram[], query: string, limit = 20): Engram[] {
  const queryTokens = ftsTokenize(query)
  if (queryTokens.length === 0) return []
  return engrams
    .map(e => ({ engram: e, score: ftsScore(e, queryTokens) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.engram)
}
