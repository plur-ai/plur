import type { Engram } from './schemas/engram.js'
import { searchEngrams } from './fts.js'
import { embeddingSearch, embedderStatus } from './embeddings.js'
import { logger } from './logger.js'
import type { RerankerAdapter } from './rerankers/types.js'
import { isRerankerOff, recordRerankerEngaged, recordRerankerFailure, hfCacheDirName } from './rerankers/index.js'

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
  /**
   * RRF fusion score of the top-ranked result, or null when no engrams
   * matched. Surfaced (not computed anew) so callers can apply a relevance
   * threshold — e.g. the WS5 failed-recall miss-signal treats a low top
   * score as a miss even when ≥1 engram came back. Exposing this value does
   * NOT change the retrieval algorithm; it only stops discarding a number
   * rrfMerge already produced.
   *
   * NOTE: this is the **pre-rerank** RRF fusion score — the miss-signal reasons
   * about fusion strength, not the cross-encoder's reordering. Reranking (#220)
   * reorders the returned engrams but does not change topScore.
   */
  topScore: number | null
  /**
   * Number of candidates re-scored by the cross-encoder reranker (#220), or 0
   * when the reranker was off (default), unavailable, or the candidate pool was
   * empty. Useful for benchmark + diagnostic reporting.
   */
  reranked?: number
}

/** Options for the optional cross-encoder rerank stage (#220). */
export interface RerankOptions {
  /** Adapter to use. When omitted or `isRerankerOff(adapter)` is true, skips. */
  reranker?: RerankerAdapter
  /**
   * How many top RRF candidates to feed into the cross-encoder. Larger K
   * means more chances to surface a buried gem but more model passes. The
   * cost is O(K) cross-encoder calls per query. Default 50.
   */
  topK?: number
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
function rrfMerge(resultSets: Engram[][], k = 60): Array<{ engram: Engram; score: number }> {
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

  return Array.from(scores.values()).sort((a, b) => b.score - a.score)
}

/**
 * RRF-merge result sets and return just the engrams (no scores). For callers
 * that fuse externally-ranked lists and don't need topScore — e.g. the PGLite
 * recall path fusing pgvector hits with BM25 before the rerank stage.
 */
export function rrfMergeEngrams(resultSets: Engram[][], k = 60): Engram[] {
  return rrfMerge(resultSets, k).map(s => s.engram)
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
  rerank?: RerankOptions,
): Promise<Engram[]> {
  const result = await hybridSearchWithMeta(engrams, query, limit, storagePath, rerank)
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
  rerank?: RerankOptions,
): Promise<HybridSearchResult> {
  if (engrams.length === 0) {
    return { engrams: [], mode: 'hybrid', embedderError: null, topScore: null, reranked: 0 }
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
  const ranked = merged.slice(0, effectiveLimit)
  // topScore is the RRF fusion score of the top candidate, captured BEFORE the
  // optional rerank stage — the miss-signal reasons about fusion strength, not
  // the cross-encoder's reordering.
  const topScore = ranked.length > 0 ? ranked[0].score : null
  // Optional cross-encoder rerank (#220): reorders the top-K by joint relevance.
  // Off by default; on failure applyReranker logs + falls back to RRF order, so
  // recall always returns something.
  const reranked = await applyReranker(ranked.map(s => s.engram), query, rerank)
  return {
    engrams: reranked.engrams,
    mode,
    embedderError,
    topScore,
    reranked: reranked.count,
  }
}

/**
 * Internal: apply the cross-encoder reranker to the top-K of a fused list.
 *
 * - When no reranker is supplied (or the sentinel `off` adapter is supplied)
 *   returns the input order unchanged with count=0.
 * - When the reranker throws (model unavailable, network, etc.) logs a
 *   warning and falls back to the RRF order — recall should always return
 *   something, even when the optional rerank stage fails.
 */
export async function applyReranker(
  candidates: Engram[],
  query: string,
  rerank?: RerankOptions,
): Promise<{ engrams: Engram[]; count: number }> {
  if (!rerank?.reranker || isRerankerOff(rerank.reranker)) {
    return { engrams: candidates, count: 0 }
  }
  if (candidates.length === 0) {
    return { engrams: candidates, count: 0 }
  }
  const topK = Math.max(1, Math.min(candidates.length, rerank.topK ?? 50))
  const head = candidates.slice(0, topK)
  const tail = candidates.slice(topK)
  try {
    const docs = head.map(e => e.statement)
    const scores = await rerank.reranker.scoreBatch(query, docs)
    if (scores.length !== head.length) {
      const message = `returned ${scores.length} scores for ${head.length} candidates`
      // #341: a mismatch is a non-engagement too — record it so doctor/recall
      // can surface that results are RRF-only despite reranking being on.
      logRerankerFailure(rerank.reranker, message)
      return { engrams: candidates, count: 0 }
    }
    const ranked = head
      .map((engram, i) => ({ engram, score: scores[i] }))
      .sort((a, b) => b.score - a.score)
      .map(r => r.engram)
    recordRerankerEngaged()
    return { engrams: [...ranked, ...tail], count: head.length }
  } catch (err) {
    logRerankerFailure(rerank.reranker, (err as Error).message)
    return { engrams: candidates, count: 0 }
  }
}

/**
 * Record a rerank failure and log it loud-once (#341): the first occurrence
 * of a message logs at warning with the classification + remediation pointer;
 * repeats of the same message are demoted to debug so a broken model doesn't
 * flood one warning per query. The runtime tracker keeps the state that
 * plur_doctor and the MCP recall path surface.
 */
function logRerankerFailure(reranker: RerankerAdapter, message: string): void {
  const rec = recordRerankerFailure(reranker.name, message)
  const base =
    `[hybrid-search] reranker "${reranker.name}" failed: ${message}. ` +
    `Falling back to RRF order — results are NOT cross-encoder reranked.`
  if (!rec.firstFailure) {
    logger.debug(base)
    return
  }
  const hint = rec.kind === 'corrupt-cache'
    ? ` Model cache looks corrupt (truncated download, see #340) — delete ~/.cache/huggingface/hub/${hfCacheDirName(reranker.modelId)}/ to force a clean re-download.`
    : ''
  logger.warning(`${base}${hint} Run plur_doctor for diagnosis. Repeats of this failure log at debug level.`)
}
