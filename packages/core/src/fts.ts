import type { Engram } from './schemas/engram.js'

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
  'were', 'been', 'have', 'has', 'not', 'but', 'its', 'you', 'your',
  'can', 'will', 'should', 'would', 'could', 'may', 'might',
])

/** Tokenize text into searchable terms */
export function ftsTokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens = lower
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .filter(w => !STOP_WORDS.has(w))
  // CJK: \w is ASCII-only ([A-Za-z0-9_]), so Han runs are stripped by the
  // replace above and pure-Chinese text tokenizes to nothing. Chinese has no
  // whitespace-delimited words — re-extract Han runs from the source and index
  // them as character bigrams so non-English text survives BM25. (plur-ai#782)
  for (const run of lower.match(/\p{Script=Han}{2,}/gu) ?? []) {
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
  }
  return tokens
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

/**
 * Corpus-wide statistics for IDF, supplied by a store that can compute them
 * without materialising the corpus (convergence Phase 4, #711).
 *
 * `computeIdf`'s default behaviour derives `N` and `df` from the engrams it is
 * handed. That is correct only when it is handed the WHOLE corpus, which is
 * true today because search loads everything. It stops being true the moment
 * narrowing is pushed into the store: given 200 candidates out of 50,000
 * engrams, deriving `N = 200` scores a term that is rare corpus-wide but common
 * among the candidates as if it were common — the exact inversion IDF exists to
 * prevent.
 *
 * The failure is silent. Every score is a plausible number, every test that
 * checks "the right rows came back" still passes, and the only symptom is
 * quietly worse ranking. So a store that narrows MUST also supply these.
 */
export interface CorpusStats {
  /** Total number of documents in the corpus — not in the candidate set. */
  N: number
  /**
   * Corpus-wide document frequency per query token, under the SAME matching
   * rule `ftsScore` applies (`t.includes(qt) || qt.startsWith(t)`). A store
   * that cannot reproduce that rule exactly must not supply stats at all —
   * approximate `df` is worse than local `df`, because it is wrong in a way
   * that does not correlate with the candidate set and cannot be reasoned about.
   */
  df: Map<string, number>
  /**
   * Corpus-wide mean document length in tokens — BM25's `avgdl`.
   *
   * Required for the same reason `N` is. BM25 normalises each document's length
   * against the corpus average; deriving that average from the NARROWED
   * candidates uses a systematically larger number, because candidates are by
   * construction the documents containing a query term. Every candidate then
   * looks shorter than average, the length penalty is under-applied, and the
   * ranking shifts.
   *
   * This was the hole in the original parity claim: `df` and `N` came from the
   * corpus while `avgdl` came from the candidates, so the two paths agreed only
   * on fixtures uniform enough to hide it.
   */
  avgDocLength: number
}

/**
 * True when a document term matches a query term under BM25's matching rule.
 *
 * Single definition so `ftsScore`, `computeIdf`, and any store implementing
 * {@link CorpusStats} cannot drift apart. They must agree exactly: `df` counted
 * under one rule and `tf` counted under another produces scores that are not
 * BM25 at all, with no error to signal it.
 *
 * Forward (`t.includes(qt)`) finds `transferWithAuthorization` from `auth`.
 * Reverse is bounded to a prefix so `deploy` still matches `deploying` while
 * `yin` no longer matches it (#721).
 */
export function termMatches(t: string, qt: string): boolean {
  return t.includes(qt) || qt.startsWith(t)
}

/**
 * Compute IDF weights for query tokens.
 *
 * When `stats` is supplied, uses those corpus-wide figures. Otherwise derives
 * them from `engrams`, which is correct only if `engrams` IS the corpus — see
 * {@link CorpusStats}.
 */
export function computeIdf(
  engrams: Engram[],
  queryTokens: string[],
  stats?: CorpusStats,
): Map<string, number> {
  if (stats) {
    if (stats.N === 0) return new Map()
    const idf = new Map<string, number>()
    for (const qt of queryTokens) {
      const df = stats.df.get(qt) ?? 0
      idf.set(qt, Math.max(0, Math.log(stats.N / (1 + df))))
    }
    return idf
  }

  const N = engrams.length
  if (N === 0) return new Map()

  // Pre-tokenize all engrams
  const engramTermSets = engrams.map(e => new Set(ftsTokenize(engramSearchText(e))))

  const idf = new Map<string, number>()
  for (const qt of queryTokens) {
    let df = 0
    for (const termSet of engramTermSets) {
      if (termSet.has(qt) || Array.from(termSet).some(t => termMatches(t, qt))) {
        df++
      }
    }
    idf.set(qt, Math.max(0, Math.log(N / (1 + df))))
  }
  return idf
}

/**
 * Extend store-supplied corpus statistics with documents that live OUTSIDE
 * that store, so a union of primary + outsider engrams is scored against the
 * union's true statistics instead of the primary corpus's.
 *
 * Why this exists: scoring outsiders (secondary-store and pack engrams) with
 * primary-only stats leaves any query term that is ABSENT from the primary
 * corpus at `df = 0`, so `computeIdf` prices it as maximally rare —
 * `log(N/1)`, unbounded in primary-corpus size and completely decoupled from
 * the term's real prevalence among the outsiders. Measured before this
 * function existed: a query mixing one primary-corpus term with one term
 * common across a 196-engram secondary store ranked the single strongest
 * primary match at position 197, below every weak outsider row. Team-specific
 * jargon is exactly the vocabulary that is common in a team store and absent
 * from a personal one, so the failure mode sat on the normal multi-store path,
 * not an edge case.
 *
 * The outsiders are already fully materialised in memory by the time the
 * union is ranked (that is how they got into the candidate list), so exact
 * union figures cost one tokenisation pass — there is nothing to approximate.
 * `df` counts under {@link termMatches}, the same rule `computeIdf`'s local
 * path applies; see the CorpusStats.df doc for why drifting from that rule is
 * worse than supplying no stats at all.
 */
export function extendCorpusStats(
  stats: CorpusStats,
  queryTokens: string[],
  outsiders: Engram[],
): CorpusStats {
  if (outsiders.length === 0) return stats
  const termSets: Array<Set<string>> = []
  let totalLen = 0
  for (const e of outsiders) {
    const terms = ftsTokenize(engramSearchText(e))
    totalLen += terms.length
    termSets.push(new Set(terms))
  }
  const df = new Map(stats.df)
  for (const qt of queryTokens) {
    let added = 0
    for (const set of termSets) {
      if (set.has(qt) || Array.from(set).some(t => termMatches(t, qt))) added++
    }
    if (added > 0) df.set(qt, (df.get(qt) ?? 0) + added)
  }
  const N = stats.N + outsiders.length
  return {
    N,
    df,
    avgDocLength: N > 0 ? (stats.avgDocLength * stats.N + totalLen) / N : 0,
  }
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

    // Count term frequency. Shares `termMatches` with `computeIdf` — tf and df
    // counted under different rules is not BM25, and nothing would report it.
    let tf = 0
    for (const t of allTerms) {
      if (termMatches(t, qt)) tf++
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
export function searchEngrams(
  engrams: Engram[],
  query: string,
  limit = 20,
  stats?: CorpusStats,
): Engram[] {
  const queryTokens = ftsTokenize(query)
  if (queryTokens.length === 0) return []
  // `stats` present means `engrams` is a NARROWED candidate set and the corpus
  // figures had to come from the store — see CorpusStats. Absent means
  // `engrams` is the whole corpus and deriving them here is correct.
  const idfWeights = computeIdf(engrams, queryTokens, stats)

  // Compute average document length for BM25 normalization.
  //
  // From `stats` when narrowing happened, because `engrams` is then the
  // candidate set, whose mean length has no reason to equal the corpus mean —
  // it can fall either side of it. Using it mis-applies BM25's length penalty
  // and reorders results, which is precisely how the two paths diverged while
  // `df` and `N` agreed. Pinned by the length-skew fixture in
  // corpus-stats.test.ts, which is mutation-checked: reverting this line
  // reverses the ranking there.
  const avgDocLength = stats
    ? stats.avgDocLength
    : engrams.length > 0
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
