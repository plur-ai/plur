/**
 * Per-store reranker fit check (#451).
 *
 * Cross-encoders are trained on specific domains (ms-marco-MiniLM-L6 on MS
 * MARCO passage retrieval; bge-reranker-v2-m3 on multilingual retrieval).
 * On out-of-domain stores the model can produce uninformative or
 * inverted scores — activating it by default could be net-negative.
 *
 * This module measures whether a reranker *separates* same-domain pairs from
 * cross-domain pairs on the user's actual engrams. The algorithm:
 *   1. Sample up to `sampleSize` engrams from the store.
 *   2. Group by domain. If only one domain (or none), use statement similarity
 *      as a proxy: consecutive pairs as "positive", cross-sample pairs as "negative".
 *   3. Score K positive and K negative (query, document) pairs.
 *   4. Compute separability = (mean_positive - mean_negative) / span.
 *   5. Gate: separability ≥ MIN_SEPARABILITY → fit.
 *
 * A fit score of 1.0 means the model perfectly separates relevant from
 * irrelevant. 0.0 means it gives the same scores to both — useless.
 * Negative means it inverts relevance — harmful.
 *
 * No LLM access is required. The check runs fully local in ~seconds.
 */

import type { RerankerAdapter } from './types.js'

export interface FitCheckResult {
  /** Whether the reranker is a good fit for this store's engrams. */
  fit: boolean
  /**
   * Separability score in [−1, +1].
   *   > 0  : model scores same-domain pairs higher — the right direction.
   *   ≈ 0  : model cannot distinguish — no signal.
   *   < 0  : model scores cross-domain pairs higher — potentially harmful.
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

  // Work with at most sampleSize engrams.
  const sample = engrams.length > sampleSize
    ? deterministicSample(engrams, sampleSize)
    : [...engrams]

  // Build (query, document) pairs for each polarity.
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

  // Score all pairs in two batches.
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
 * Build positive (same-domain) and negative (cross-domain) pairs.
 *
 * Strategy:
 *   - Group engrams by domain. Domains with ≥ 2 engrams contribute positive
 *     pairs (consecutive within the group). All engrams contribute negative
 *     pairs (first of one group vs first of another group).
 *   - If there is only one distinct domain (or no domain field), fall back to
 *     the positional proxy: consecutive engrams → positive, non-adjacent
 *     engrams → negative.
 */
function buildPairs(
  engrams: FitCheckEngram[],
  pairsPerPolarity: number,
): { posPairs: Pair[]; negPairs: Pair[] } {
  // Group by domain (use '__none__' for undeclared domains).
  const byDomain = new Map<string, FitCheckEngram[]>()
  for (const e of engrams) {
    const key = e.domain ?? '__none__'
    const bucket = byDomain.get(key)
    if (bucket) {
      bucket.push(e)
    } else {
      byDomain.set(key, [e])
    }
  }

  const multiDomain = byDomain.size >= 2

  const posPairs: Pair[] = []
  const negPairs: Pair[] = []

  if (multiDomain) {
    // Same-domain positives: consecutive pairs within each domain bucket.
    for (const bucket of byDomain.values()) {
      for (let i = 0; i + 1 < bucket.length && posPairs.length < pairsPerPolarity; i++) {
        posPairs.push([bucket[i].statement, bucket[i + 1].statement])
      }
    }

    // Cross-domain negatives: first element of each domain vs first of another.
    const domainReps = [...byDomain.values()].map(b => b[0])
    for (let i = 0; i < domainReps.length && negPairs.length < pairsPerPolarity; i++) {
      const j = (i + Math.floor(domainReps.length / 2)) % domainReps.length
      if (i !== j) {
        negPairs.push([domainReps[i].statement, domainReps[j].statement])
      }
    }
  } else {
    // Single-domain fallback: positional proxy.
    for (let i = 0; i + 1 < engrams.length && posPairs.length < pairsPerPolarity; i += 2) {
      posPairs.push([engrams[i].statement, engrams[i + 1].statement])
    }
    // Negatives: first quarter vs last quarter.
    const half = Math.floor(engrams.length / 2)
    for (
      let i = 0;
      i < half && i + half < engrams.length && negPairs.length < pairsPerPolarity;
      i++
    ) {
      negPairs.push([engrams[i].statement, engrams[i + half].statement])
    }
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
