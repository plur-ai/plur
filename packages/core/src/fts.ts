import { createHash } from 'crypto'
import type { Engram } from './schemas/engram.js'

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
  'were', 'been', 'have', 'has', 'not', 'but', 'its', 'you', 'your',
  'can', 'will', 'should', 'would', 'could', 'may', 'might',
])

/**
 * Shortest token `ftsTokenize` can emit.
 *
 * NOT the same number as the word-path length filter below: the whitespace
 * path discards anything under three characters (two for dense scripts), while
 * the space-less bigram path emits tokens of exactly two.
 *
 * Anything reasoning about the shortest STORED token (e.g.
 * `PostgresAdapter.reversePrefixes`) must read this constant rather than
 * restate the word-path floor.
 */
export const MIN_TOKEN_LENGTH = 2

/**
 * Version of `ftsTokenize`'s output contract. Bump on ANY change that can alter
 * the token list for the same input.
 * Stores that tokenize at write time (e.g. `PostgresAdapter`'s exact BM25
 * pushdown) rely on one tokenizer producing both stored and query tokens; a
 * mismatch fails silently (rows never match), so such stores reindex when
 * this changes.
 */
export const TOKENIZER_VERSION = 4

/** Tokenize text into searchable terms */
/**
 * Scripts written without spaces between words, indexed as character BIGRAMS
 * (no per-language segmenter dependency).
 * Uses `Script_Extensions`, NOT `Script`: marks like U+30FC ー (Script=Common),
 * 々 and Thai's THANTHAKHAT would otherwise split runs in the wrong place.
 */
const SPACELESS_RUN = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Thai}\p{Script_Extensions=Khmer}\p{Script_Extensions=Lao}\p{Script_Extensions=Myanmar}]{2,}/gu

/**
 * Scripts whose words are routinely one or two characters, so the Latin-shaped
 * `length > 2` floor would erase them. Korean example: 도커 ("docker") is two
 * syllable blocks.
 */
/**
 * Longest space-less run that gets fully bigram-indexed: far above any real
 * statement, far below what lets one pasted document dominate a shared GIN
 * index. Changing it alters tokens, so bump {@link TOKENIZER_VERSION} and reindex.
 */
export const MAX_SPACELESS_RUN_CHARS = 512

const DENSE_SCRIPT = /[\p{Script_Extensions=Hangul}\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u

export function ftsTokenize(text: string): string[] {
  const lower = text.toLowerCase()

  // PART 1 — the character class must keep MARKS, not just letters and digits.
  //
  // `\w` is ASCII-only: it would strip every non-Latin script and cut
  // accented Latin at each accent. `\p{L}\p{N}` alone is not sufficient
  // either: Devanagari vowel signs and Thai tone marks are NONSPACING MARKS
  // (\p{Mn}), so without \p{M} Hindi tokenizes to nothing and Thai shatters
  // into fragments the length filter then drops.
  const wordSource = lower
    // PART 2a — remove space-less runs BEFORE splitting on whitespace.
    //
    // Ordering dependency: the Unicode class above preserves a Han run as a
    // single "word", so leaving it in the word path would index the whole run
    // AND all its bigrams. Strip here, re-add as bigrams below.
    .replace(SPACELESS_RUN, ' ')
    .replace(/[^\p{L}\p{N}\p{M}_\s]/gu, ' ')

  const tokens = wordSource
    .split(/\s+/)
    // PART 3 — the length floor is Latin-centric.
    //
    // `length > 2` would kill two-character words, which are ordinary in
    // dense scripts (도커, "docker"). Relaxed to two for those scripts only, so
    // English stop-noise ("a", "of") is still filtered.
    //
    // Deliberately NOT relaxed to one (a lone 猫 is not indexed):
    // MIN_TOKEN_LENGTH = 2 is load-bearing — `PostgresAdapter.reversePrefixes`
    // reads it, and emitting length-1 tokens would change the pushdown's
    // contract. A single character also cannot be bigram-indexed.
    .filter(w => w.length > 2 || (w.length === 2 && DENSE_SCRIPT.test(w)))
    .filter(w => !STOP_WORDS.has(w))

  // Space-less scripts, indexed as character bigrams.
  // Read from `lower`, not from wordSource — the runs were stripped there.
  for (const run of lower.match(SPACELESS_RUN) ?? []) {
    // Capped. A run of length n emits n-1 bigrams, and every one becomes
    // a row in Postgres's GIN index — so a 5,000-character CJK engram writes
    // ~5,000 index entries where English prose of the same length writes a few
    // hundred. Uncapped, one pasted document could dominate the index.
    //
    // The cap is per RUN, not per engram, so ordinary statements — which are
    // assertions, not documents — are untouched: nothing here changes for a run
    // under the limit, which is essentially all of them. A run over it is
    // TRUNCATED rather than dropped: its opening is the part a query is most
    // likely to share, and indexing a prefix beats indexing nothing.
    const span = Math.min(run.length, MAX_SPACELESS_RUN_CHARS)
    for (let i = 0; i < span - 1; i++) tokens.push(run.slice(i, i + 2))
  }
  return tokens
}

/**
 * The context fields that enrich a statement into searchable text.
 *
 * Named separately from `Engram` so a not-yet-stored write can be turned into
 * the SAME text an existing engram would produce. Dedup compares an incoming
 * statement against stored engrams; embedding the bare statement on one side
 * and enriched text on the other is not a like-for-like comparison. Context
 * pushes distinct pairs and genuine duplicates apart; dropping it from one side
 * collapses them together.
 */
export interface SearchTextFields {
  statement: string
  domain?: string | null
  tags?: string[] | null
  entities?: Engram['entities']
  temporal?: Engram['temporal']
  rationale?: string | null
  source?: string | null
  dual_coding?: Engram['dual_coding']
  knowledge_anchors?: Engram['knowledge_anchors']
}

/**
 * Build searchable text from context fields. Single definition so the stored
 * and incoming sides cannot drift apart.
 */
export function searchTextFrom(fields: SearchTextFields): string {
  // `engramSearchText` reads `engram.tags.length` unguarded — fine for a
  // schema-validated Engram, a crash for a partial write. Normalise first.
  return engramSearchText({
    ...fields,
    tags: fields.tags ?? [],
    domain: fields.domain ?? undefined,
    rationale: fields.rationale ?? undefined,
    source: fields.source ?? undefined,
  } as unknown as Engram)
}

/**
 * Build searchable text from all engram fields.
 *
 * `tags` is read defensively. A schema-validated Engram always has it, but this
 * function is also reached from paths that splice in partially-built objects
 * (e.g. learnBatch's dedup accumulator). There an unguarded read would throw
 * into a surrounding catch and silently degrade dedup, so this takes the
 * default instead.
 */
export function engramSearchText(engram: Engram): string {
  const parts = [engram.statement]
  if (engram.domain) parts.push(engram.domain.replace(/\./g, ' '))
  if (engram.tags?.length) parts.push(engram.tags.join(' '))
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
  // search corpus is the whole point of the field.
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
 * Hash of the exact text an engram's embedding was computed from, stored beside
 * the vector so a rewritten statement is not ranked by its old vector.
 * - Hashes the RAW `engramSearchText` passed to `embed()`, not its lossy
 *   tokenization (which drops stop words: "use X" vs "do not use X").
 * - md5: a change detector, not a security boundary.
 * - The WRITER hashes what it embedded, so a concurrent update self-heals
 *   instead of pairing a new-text hash with an old-text vector.
 */
export function embeddingContentHash(engram: Engram): string {
  return hashEmbeddedText(engramSearchText(engram))
}

/** md5 of an already-derived string. Exported so stores can hash the same way. */
export function hashEmbeddedText(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

/**
 * Corpus-wide IDF statistics, supplied by a store that can compute them without
 * materialising the corpus. `computeIdf` otherwise derives `N` and `df` from the
 * engrams it is handed, which is wrong for a narrowed candidate set and fails
 * silently (only ranking degrades). A store that narrows MUST supply these.
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
   */
  avgDocLength: number
}

/**
 * True when a document term matches a query term under BM25's matching rule.
 * The single definition shared by `ftsScore`, `computeIdf` and
 * {@link CorpusStats} stores: `df` and `tf` counted under different rules is
 * not BM25, silently. Forward is substring (`auth` → `transferWithAuthorization`);
 * reverse is prefix-only (`deploy` matches `deploying`, `yin` does not).
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
 * Extend store-supplied corpus statistics with outsider documents (secondary
 * stores, packs), so the union is scored against its true statistics.
 * With primary-only stats, a term absent from the primary corpus gets `df = 0`
 * and maximal IDF, letting weak outsider rows outrank strong primary matches.
 * Outsiders are already in memory, so figures are exact. `df` counts under
 * {@link termMatches}, the same rule `computeIdf` uses (see CorpusStats.df).
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
  return ftsScoreDetail(engram, queryTokens, idfWeights, avgDocLength).score
}

/**
 * BM25 score plus query coverage: the share of the query's term weight (the
 * same effective IDF the score uses) carried by query terms this engram
 * contains, in [0, 1]. A document that matches every informative query word
 * has coverage 1; one that matches a single word out of four equally rare
 * ones has 0.25. Hybrid fusion uses it to weigh how much a keyword hit says.
 */
export function ftsScoreDetail(
  engram: Engram, queryTokens: string[], idfWeights?: Map<string, number>, avgDocLength?: number,
): { score: number; coverage: number } {
  const allTerms = ftsTokenize(engramSearchText(engram))
  if (queryTokens.length === 0) return { score: 0, coverage: 0 }

  const docLen = allTerms.length
  const avgdl = avgDocLength && avgDocLength > 0 ? avgDocLength : docLen

  // Determine if any IDF weight is non-zero (i.e., not all terms are corpus-universal)
  const hasNonZeroIdf = idfWeights && Array.from(idfWeights.values()).some(v => v > 0)

  let score = 0
  let weightTotal = 0
  let weightMatched = 0
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
    weightTotal += effectiveIdf
    let tf = 0
    for (const t of allTerms) {
      if (termMatches(t, qt)) tf++
    }
    if (tf === 0) continue
    weightMatched += effectiveIdf

    // BM25 formula: IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgdl))
    const numerator = tf * (BM25_K1 + 1)
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * docLen / avgdl)
    score += effectiveIdf * (numerator / denominator)
  }

  return { score, coverage: weightTotal > 0 ? weightMatched / weightTotal : 0 }
}

/** Search engrams by text query with BM25 scoring */
export function searchEngrams(
  engrams: Engram[],
  query: string,
  limit = 20,
  stats?: CorpusStats,
): Engram[] {
  return searchEngramsScored(engrams, query, limit, stats).map(r => r.engram)
}

/** A BM25 hit with its score and query coverage (see {@link ftsScoreDetail}). */
export interface ScoredKeywordHit { engram: Engram; score: number; coverage: number }

/** {@link searchEngrams}, keeping each hit's BM25 score and query coverage. Same order. */
export function searchEngramsScored(
  engrams: Engram[],
  query: string,
  limit = 20,
  stats?: CorpusStats,
): ScoredKeywordHit[] {
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
  // and reorders results. Pinned by the length-skew fixture in corpus-stats.test.ts.
  const avgDocLength = stats
    ? stats.avgDocLength
    : engrams.length > 0
      ? engrams.reduce((sum, e) => sum + ftsTokenize(engramSearchText(e)).length, 0) / engrams.length
      : 0

  let scored = engrams
    .map(e => ({ engram: e, ...ftsScoreDetail(e, queryTokens, idfWeights, avgDocLength) }))
    .filter(r => r.score > 0)

  // Fallback: on tiny/uniform corpora, every query token can be either
  // corpus-universal (IDF skipped to 0) or corpus-absent (tf=0), collapsing
  // all scores to 0. Re-score with uniform weights so we still surface
  // lexically-similar docs.
  if (scored.length === 0) {
    scored = engrams
      .map(e => ({ engram: e, ...ftsScoreDetail(e, queryTokens, undefined, avgDocLength) }))
      .filter(r => r.score > 0)
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
