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

/** Build searchable text from all engram fields */
export function engramSearchText(engram: Engram): string {
  const parts = [engram.statement]
  if (engram.domain) parts.push(engram.domain.replace(/\./g, ' '))
  if (engram.tags.length > 0) parts.push(engram.tags.join(' '))
  if (engram.entities) {
    for (const e of engram.entities) {
      parts.push(e.name)
      if (e.type !== 'other') parts.push(e.type)
    }
  }
  if (engram.temporal) {
    if (engram.temporal.valid_from) parts.push(engram.temporal.valid_from)
    if (engram.temporal.valid_until) parts.push(engram.temporal.valid_until)
  }
  if (engram.rationale) parts.push(engram.rationale)
  return parts.join(' ')
}

/** Compute IDF weights for query tokens against a corpus of engrams */
export function computeIdf(engrams: Engram[], queryTokens: string[]): Map<string, number> {
  const N = engrams.length
  if (N === 0) return new Map()

  // Pre-tokenize all engrams
  const engramTermSets = engrams.map(e => new Set(ftsTokenize(engramSearchText(e))))

  const idf = new Map<string, number>()
  for (const qt of queryTokens) {
    let df = 0
    for (const termSet of engramTermSets) {
      if (termSet.has(qt) || Array.from(termSet).some(t => t.includes(qt) || qt.includes(t))) {
        df++
      }
    }
    idf.set(qt, Math.max(0, Math.log(N / (1 + df))))
  }
  return idf
}

/** Score an engram against query tokens with IDF weighting */
export function ftsScore(engram: Engram, queryTokens: string[], idfWeights?: Map<string, number>): number {
  const allTerms = ftsTokenize(engramSearchText(engram))
  if (queryTokens.length === 0) return 0

  let weightedHits = 0
  let totalWeight = 0

  for (const qt of queryTokens) {
    const weight = idfWeights?.get(qt) ?? 1
    totalWeight += weight
    if (allTerms.some(t => t.includes(qt) || qt.includes(t))) {
      weightedHits += weight
    }
  }

  // If all IDF weights are 0 (e.g., single-document corpus), fall back to match ratio
  if (totalWeight === 0) {
    let matches = 0
    for (const qt of queryTokens) {
      if (allTerms.some(t => t.includes(qt) || qt.includes(t))) matches++
    }
    return matches / queryTokens.length
  }
  return weightedHits / totalWeight
}

/** Search engrams by text query with IDF-weighted scoring */
export function searchEngrams(engrams: Engram[], query: string, limit = 20): Engram[] {
  const queryTokens = ftsTokenize(query)
  if (queryTokens.length === 0) return []
  const idfWeights = computeIdf(engrams, queryTokens)
  return engrams
    .map(e => ({ engram: e, score: ftsScore(e, queryTokens, idfWeights) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.engram)
}
