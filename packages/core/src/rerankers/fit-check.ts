/**
 * Per-store reranker fit check: does a cross-encoder separate relevant from irrelevant
 * pairs on the user's own engrams? (Out-of-domain models can invert scores.)
 * 1. Sample up to `sampleSize` engrams; synthesize a probe query from each statement.
 * 2. POSITIVE = (probe, its OWN engram); NEGATIVE = (probe, a different, preferably
 *    cross-domain engram). Positives must be the source engram: cross-encoders score
 *    relevance, not topical co-membership.
 * 3. separability = (mean_positive - mean_negative) / span; fit when ≥ MIN_SEPARABILITY.
 * 1.0 = perfect, 0.0 = useless, negative = harmful. Fully local, no LLM.
 */

import type { RerankerAdapter } from './types.js'
import { synthesizeProbeQuery } from '../reranker-eval.js'

export interface FitCheckResult {
  /** Whether the reranker is a good fit for this store's engrams. */
  fit: boolean
  /**
   * Separability score in [−1, +1].
   *   > 0  : model scores relevant pairs higher — the right direction.
   *   ≈ 0  : model cannot distinguish — no signal.
   *   < 0  : model scores irrelevant pairs higher — potentially harmful.
   */
  separability: number
  positive_mean: number
  negative_mean: number
  /** Total pairs scored (positive + negative). */
  n_pairs: number
  reranker: string
  computed_at: number
}

export interface FitCheckEngram {
  statement: string
  domain?: string
}

/** Separability threshold above which we consider the reranker a fit. */
const MIN_SEPARABILITY = 0.05

/** Pairs scored per polarity (positive / negative). */
const PAIRS_PER_POLARITY = 10

/**
 * Check whether `reranker` produces useful scores on the given engrams.
 *
 * @param engrams   Engrams from the store to evaluate against.
 * @param reranker  The adapter to probe.
 * @param opts.sampleSize  Max engrams to sample (default 100).
 * @returns FitCheckResult — callers decide whether to cache it.
 */
export async function checkRerankerFit(
  engrams: FitCheckEngram[],
  reranker: RerankerAdapter,
  opts?: { sampleSize?: number },
): Promise<FitCheckResult> {
  const sampleSize = opts?.sampleSize ?? 100

  const sample = engrams.length > sampleSize
    ? deterministicSample(engrams, sampleSize)
    : [...engrams]

  const { posPairs, negPairs } = buildPairs(sample, PAIRS_PER_POLARITY)

  const n_pairs = posPairs.length + negPairs.length

  if (n_pairs === 0) {
    // Not enough engrams to evaluate — treat as fit to avoid false negatives.
    return {
      fit: true,
      separability: 0,
      positive_mean: 0,
      negative_mean: 0,
      n_pairs: 0,
      reranker: reranker.name,
      computed_at: Date.now(),
    }
  }

  const [posScores, negScores] = await Promise.all([
    scorePairs(reranker, posPairs),
    scorePairs(reranker, negPairs),
  ])

  const positive_mean = mean(posScores)
  const negative_mean = mean(negScores)

  // Normalise: separability ∈ [−1, +1].
  // span = max absolute score across both sets; avoids /0 when model outputs ~0.
  const span = Math.max(
    ...posScores.map(Math.abs),
    ...negScores.map(Math.abs),
    1e-6,
  )
  const separability = (positive_mean - negative_mean) / span

  return {
    fit: separability >= MIN_SEPARABILITY,
    separability,
    positive_mean,
    negative_mean,
    n_pairs,
    reranker: reranker.name,
    computed_at: Date.now(),
  }
}

// --- Internals ---

type Pair = [string, string]

/**
 * Build (query, document) pairs whose RELEVANCE a cross-encoder can actually
 * judge. For each engram we synthesize a probe query from its own statement:
 *   - POSITIVE = (probe_i, statement_i)   — the doc answers its own probe.
 *   - NEGATIVE = (probe_i, statement_j)   — j ≠ i, cross-domain when available.
 * A healthy relevance reranker scores positives high and negatives low; an
 * inverting/broken one does the opposite, driving separability negative.
 */
function buildPairs(
  engrams: FitCheckEngram[],
  pairsPerPolarity: number,
): { posPairs: Pair[]; negPairs: Pair[] } {
  // A probe query built from each engram's own keywords. Statements too short to
  // yield a content-bearing query are dropped (synthesizeProbeQuery → null).
  const probed = engrams
    .map((e, i) => ({ e, query: synthesizeProbeQuery(e.statement, i) }))
    .filter((p): p is { e: FitCheckEngram; query: string } => p.query !== null)

  const posPairs: Pair[] = []
  const negPairs: Pair[] = []

  // Positive: each probe against the very engram it was derived from.
  for (let i = 0; i < probed.length && posPairs.length < pairsPerPolarity; i++) {
    posPairs.push([probed[i].query, probed[i].e.statement])
  }

  // Negative: each probe against a DIFFERENT engram — prefer a different domain
  // so the pair is unambiguously irrelevant; fall back to the next index when no
  // cross-domain partner exists (single-domain store).
  for (let i = 0; i < probed.length && negPairs.length < pairsPerPolarity; i++) {
    let j = -1
    for (let k = 1; k < probed.length; k++) {
      const cand = (i + k) % probed.length
      if (probed[cand].e.domain !== probed[i].e.domain) { j = cand; break }
    }
    if (j === -1) j = (i + 1) % probed.length
    if (j !== i) negPairs.push([probed[i].query, probed[j].e.statement])
  }

  return { posPairs, negPairs }
}

/** Score pairs using the reranker's scoreBatch. One query → N docs per call. */
async function scorePairs(reranker: RerankerAdapter, pairs: Pair[]): Promise<number[]> {
  if (pairs.length === 0) return []
  // Group by query so we can batch docs. Each unique query gets one scoreBatch call.
  const byQuery = new Map<string, string[]>()
  for (const [q, d] of pairs) {
    const docs = byQuery.get(q)
    if (docs) {
      docs.push(d)
    } else {
      byQuery.set(q, [d])
    }
  }
  const allScores: number[] = []
  for (const [query, docs] of byQuery) {
    const scores = await reranker.scoreBatch(query, docs)
    allScores.push(...scores)
  }
  return allScores
}

/** Deterministic subsample — take evenly-spaced indices to avoid domain bias. */
function deterministicSample<T>(arr: T[], n: number): T[] {
  const step = arr.length / n
  const result: T[] = []
  for (let i = 0; i < n; i++) {
    result.push(arr[Math.floor(i * step)])
  }
  return result
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}
