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
  // Provenance: helps surface engrams by their origin (URL, paper, conversation ref).
  if (engram.source) parts.push(engram.source)
  // Dual-coding cues: example + analogy are *meant* to be alternate retrieval
  // anchors — same memory, different verbal route in. Including them in the
  // search corpus is the whole point of the field. plur-ai/plur#139.
  if (engram.dual_coding) {
    if (engram.dual_coding.example) parts.push(engram.dual_coding.example)
    if (engram.dual_coding.analogy) parts.push(engram.dual_coding.analogy)
  }
  // Knowledge-anchor snippets: short excerpts from linked source documents.
  // Text-bearing; should retrieve when a query matches the snippet content.
  if (engram.knowledge_anchors && engram.knowledge_anchors.length > 0) {
    for (const a of engram.knowledge_anchors) {
      if (a.snippet) parts.push(a.snippet)
    }
  }
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

const BM25_K1 = 1.2
const BM25_B = 0.75

/** Score an engram against query tokens using BM25 with IDF, TF saturation, and length normalization */
export function ftsScore(engram: Engram, queryTokens: string[], idfWeights?: Map<string, number>, avgDocLength?: number): number {
  const allTerms = ftsTokenize(engramSearchText(engram))
  if (queryTokens.length === 0) return 0

  const docLen = allTerms.length
  const avgdl = avgDocLength && avgDocLength > 0 ? avgDocLength : docLen

  // Determine if any IDF weight is non-zero (i.e., not all terms are corpus-universal)
  const hasNonZeroIdf = idfWeights && Array.from(idfWeights.values()).some(v => v > 0)

  let score = 0
  for (const qt of queryTokens) {
    let effectiveIdf: number
    if (!idfWeights) {
      // No IDF provided — use uniform weight=1 (pure BM25 TF+length mode)
      effectiveIdf = 1
    } else if (hasNonZeroIdf) {
      // Some terms are discriminative — skip zero-IDF (corpus-universal) terms
      effectiveIdf = idfWeights.get(qt) ?? 0
      if (effectiveIdf === 0) continue
    } else {
      // All IDF weights are zero (tiny/uniform corpus) — fall back to uniform weight=1
      effectiveIdf = 1
    }

    // Count term frequency (including substring matches)
    let tf = 0
    for (const t of allTerms) {
      if (t.includes(qt) || qt.includes(t)) tf++
    }
    if (tf === 0) continue

    // BM25 formula: IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgdl))
    const numerator = tf * (BM25_K1 + 1)
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * docLen / avgdl)
    score += effectiveIdf * (numerator / denominator)
  }

  return score
}

/** Search engrams by text query with BM25 scoring */
export function searchEngrams(engrams: Engram[], query: string, limit = 20): Engram[] {
  const queryTokens = ftsTokenize(query)
  if (queryTokens.length === 0) return []
  const idfWeights = computeIdf(engrams, queryTokens)

  // Compute average document length for BM25 normalization
  const avgDocLength = engrams.length > 0
    ? engrams.reduce((sum, e) => sum + ftsTokenize(engramSearchText(e)).length, 0) / engrams.length
    : 0

  let scored = engrams
    .map(e => ({ engram: e, score: ftsScore(e, queryTokens, idfWeights, avgDocLength) }))
    .filter(r => r.score > 0)

  // Fallback: on tiny/uniform corpora, every query token can be either
  // corpus-universal (IDF skipped to 0) or corpus-absent (tf=0), collapsing
  // all scores to 0. Re-score with uniform weights so we still surface
  // lexically-similar docs.
  if (scored.length === 0) {
    scored = engrams
      .map(e => ({ engram: e, score: ftsScore(e, queryTokens, undefined, avgDocLength) }))
      .filter(r => r.score > 0)
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.engram)
}
