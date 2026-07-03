/**
 * Per-store reranker eval gate — #451 (final task).
 *
 * Cross-encoder rerankers are trained on web/QA corpora; on an out-of-domain
 * engram store they can be net-negative (one 2026 study measured bge-reranker
 * degrading dense retrieval 34%). The #451 measurements show the lift lives
 * in hard categories on the fixture corpus — but nothing guarantees that
 * transfers to YOUR store. So before anyone flips reranking on by default,
 * each store gets a quick self-check:
 *
 *   1. Sample the store's own engrams (deterministic, seeded).
 *   2. Synthesize a probe query from each sampled engram's statement —
 *      the source engram is the known-relevant document for that query.
 *   3. Retrieve the RRF top-K for the probe (reranker OFF), note where the
 *      source ranks.
 *   4. Re-order the same pool with the cross-encoder, note the new rank.
 *   5. Aggregate MRR / Hit@1 both ways. If the reranker systematically
 *      demotes known-relevant sources, it is HARMFUL on this store.
 *
 * The probe queries are keyword extracts of the source statements, so BM25
 * usually ranks the source highly already — by construction this gate has
 * limited power to prove *benefit* (the benchmark harness does that); its
 * job is to prove a reranker is NOT ACTIVELY HARMFUL on this store's
 * domain, which is exactly what an enable-gate needs.
 *
 * The verdict is ADVISORY: cached per store (`.reranker-eval.json`), read by
 * plur_doctor and logged loud-once on the reranker-enable path. It never
 * silently disables reranking — the shipping-default decision stays human.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Engram } from './schemas/engram.js'
import { hybridSearch } from './hybrid-search.js'
import { isRerankerOff } from './rerankers/index.js'
import type { RerankerAdapter } from './rerankers/types.js'
import { atomicWrite } from './sync.js'
import { logger } from './logger.js'

// ─── Tunables ────────────────────────────────────────────────────────

/** Cached verdicts older than this are stale — the store may have drifted. */
export const RERANKER_EVAL_STALENESS_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** Store-size drift (relative) beyond which a cached verdict is stale. */
export const RERANKER_EVAL_COUNT_DRIFT = 0.2

/** Fewer scored probes than this → 'insufficient-data' (no verdict). */
export const RERANKER_EVAL_MIN_PROBES = 5

/** ΔMRR below this → 'harmful'; above the positive twin → 'beneficial'. */
export const RERANKER_EVAL_HARM_THRESHOLD = -0.05
export const RERANKER_EVAL_BENEFIT_THRESHOLD = 0.05

/** Default number of engrams sampled as probes. */
const DEFAULT_SAMPLE = 20

/** Candidate pool per probe — mirrors the shipping hybrid top-10 window. */
const DEFAULT_TOP_K = 10

/** Default PRNG seed — same as the benchmark harness for familiarity. */
const DEFAULT_SEED = 1337

/** Probe queries draw up to this many content words from the statement. */
const MAX_QUERY_TOKENS = 6

/** Statements need at least this many distinct content words to be probed. */
const MIN_CONTENT_TOKENS = 4

// ─── Result types ────────────────────────────────────────────────────

export type RerankerEvalVerdict = 'beneficial' | 'neutral' | 'harmful' | 'insufficient-data'

export interface RerankerEvalResult {
  version: 1
  /** Adapter name evaluated (e.g. ms-marco-minilm-l6). */
  reranker: string
  model_id: string
  /** ISO timestamp of the run — drives the staleness bound. */
  evaluated_at: string
  /** Active engram count at eval time — drives the drift staleness check. */
  engram_count: number
  /** Engrams with statements long enough to synthesize a probe from. */
  eligible_count: number
  /** Probes attempted (min(eligible, sample option)). */
  sample_size: number
  /** Probes where RRF retrieved the source in the top-K (the scored set). */
  scored_probes: number
  seed: number
  top_k: number
  /** Mean reciprocal rank of the source engram under RRF-only ordering. */
  rrf_mrr: number
  /** Mean reciprocal rank of the source engram after cross-encoder rerank. */
  rerank_mrr: number
  /** rerank_mrr - rrf_mrr. Negative = the reranker demotes known-relevant docs. */
  delta_mrr: number
  rrf_hit1: number
  rerank_hit1: number
  /** Probes where the rerank improved the source's rank. */
  promotions: number
  /** Probes where the rerank worsened the source's rank. */
  demotions: number
  /** Mean cross-encoder scoring time per probe (ms) — advisory latency signal. */
  mean_rerank_ms: number
  verdict: RerankerEvalVerdict
}

export interface RerankerEvalOptions {
  /** Max engrams sampled as probes. Default 20. */
  sample?: number
  /** PRNG seed for sampling + query synthesis. Default 1337. */
  seed?: number
  /** Candidate pool size per probe. Default 10 (the shipping hybrid window). */
  topK?: number
  /** Store root for the embeddings cache (same as hybridSearch's storagePath). */
  storagePath?: string
}

// ─── Probe query synthesis ───────────────────────────────────────────

/**
 * Compact stopword list — enough to keep probe queries content-bearing.
 * Not exhaustive; a stopword that slips through only makes the probe easier
 * for BM25, which biases the gate toward "not harmful" (its conservative
 * direction).
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while',
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here',
  'he', 'she', 'they', 'we', 'you', 'i', 'his', 'her', 'their', 'our', 'your', 'my',
  'do', 'does', 'did', 'done', 'doing', 'has', 'have', 'had', 'having',
  'will', 'would', 'can', 'could', 'shall', 'should', 'may', 'might', 'must',
  'not', 'no', 'nor', 'so', 'too', 'very', 'just', 'only', 'also', 'than',
  'as', 'because', 'about', 'over', 'under', 'up', 'down', 'out', 'off',
  'all', 'any', 'each', 'every', 'some', 'both', 'more', 'most', 'other',
  'one', 'two', 'via', 'per', 'vs', 'etc', 'what', 'which', 'who', 'how', 'why', 'where',
])

/** FNV-1a 32-bit hash — mixes the statement into the seed so two identical-length statements sample differently. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Seeded Fisher–Yates shuffle (returns a new array). */
function seededShuffle<T>(items: T[], rand: () => number): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Synthesize a deterministic probe query from an engram statement.
 *
 * Tokenizes, drops stopwords and sub-3-char tokens, dedupes, then draws up
 * to {@link MAX_QUERY_TOKENS} content words — seeded-sampled (not a plain
 * prefix) so probes exercise different parts of long statements — and joins
 * them in original statement order to keep some phrase structure.
 *
 * Returns null when the statement has fewer than {@link MIN_CONTENT_TOKENS}
 * distinct content words — too short to be a meaningful probe.
 */
export function synthesizeProbeQuery(statement: string, seed: number): string | null {
  const tokens = (statement ?? '')
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))
  const unique: string[] = []
  const seen = new Set<string>()
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t)
      unique.push(t)
    }
  }
  if (unique.length < MIN_CONTENT_TOKENS) return null
  if (unique.length <= MAX_QUERY_TOKENS) return unique.join(' ')
  const rand = mulberry32((seed ^ fnv1a(statement)) >>> 0)
  const indices = seededShuffle(unique.map((_t, i) => i), rand)
    .slice(0, MAX_QUERY_TOKENS)
    .sort((a, b) => a - b)
  return indices.map(i => unique[i]).join(' ')
}

// ─── The self-eval ───────────────────────────────────────────────────

/**
 * Run the per-store reranker self-eval.
 *
 * Failures in the adapter PROPAGATE — an eval run is an explicit health
 * question and must not silently degrade the way the recall hot path does.
 */
export async function runRerankerSelfEval(
  engrams: Engram[],
  adapter: RerankerAdapter,
  opts?: RerankerEvalOptions,
): Promise<RerankerEvalResult> {
  if (isRerankerOff(adapter)) {
    throw new Error('Cannot self-eval the "off" reranker sentinel — configure PLUR_RERANKER or pass a real adapter.')
  }
  const seed = opts?.seed ?? DEFAULT_SEED
  const sample = Math.max(1, opts?.sample ?? DEFAULT_SAMPLE)
  const topK = Math.max(2, opts?.topK ?? DEFAULT_TOP_K)

  const active = engrams.filter(e => e.status === 'active')
  const eligible = active
    .map(e => ({ engram: e, query: synthesizeProbeQuery(e.statement, seed) }))
    .filter((p): p is { engram: Engram; query: string } => p.query !== null)

  const rand = mulberry32(seed >>> 0)
  const probes = seededShuffle(eligible, rand).slice(0, sample)

  let scored = 0
  let rrfMrrSum = 0
  let rerankMrrSum = 0
  let rrfHit1 = 0
  let rerankHit1 = 0
  let promotions = 0
  let demotions = 0
  let rerankMsSum = 0

  for (const probe of probes) {
    // RRF-only candidate pool (no reranker) — the shipping baseline order.
    const candidates = await hybridSearch(active, probe.query, topK, opts?.storagePath)
    const rrfRank = candidates.findIndex(e => e.id === probe.engram.id)
    if (rrfRank === -1) continue // source not retrieved — reranking can't touch it either way

    const started = Date.now()
    const scores = await adapter.scoreBatch(probe.query, candidates.map(e => e.statement))
    rerankMsSum += Date.now() - started
    if (scores.length !== candidates.length) {
      throw new Error(
        `Reranker "${adapter.name}" returned ${scores.length} scores for ${candidates.length} candidates during self-eval`,
      )
    }
    // Stable sort by descending score — ties keep RRF order, mirroring applyReranker.
    const reranked = candidates
      .map((engram, i) => ({ engram, score: scores[i] }))
      .sort((a, b) => b.score - a.score)
      .map(r => r.engram)
    const rerankRank = reranked.findIndex(e => e.id === probe.engram.id)

    scored += 1
    rrfMrrSum += 1 / (rrfRank + 1)
    rerankMrrSum += 1 / (rerankRank + 1)
    if (rrfRank === 0) rrfHit1 += 1
    if (rerankRank === 0) rerankHit1 += 1
    if (rerankRank < rrfRank) promotions += 1
    if (rerankRank > rrfRank) demotions += 1
  }

  const rrfMrr = scored > 0 ? rrfMrrSum / scored : 0
  const rerankMrr = scored > 0 ? rerankMrrSum / scored : 0
  const deltaMrr = rerankMrr - rrfMrr

  let verdict: RerankerEvalVerdict
  if (scored < RERANKER_EVAL_MIN_PROBES) {
    verdict = 'insufficient-data'
  } else if (deltaMrr < RERANKER_EVAL_HARM_THRESHOLD) {
    verdict = 'harmful'
  } else if (deltaMrr > RERANKER_EVAL_BENEFIT_THRESHOLD) {
    verdict = 'beneficial'
  } else {
    verdict = 'neutral'
  }

  return {
    version: 1,
    reranker: adapter.name,
    model_id: adapter.modelId,
    evaluated_at: new Date().toISOString(),
    engram_count: active.length,
    eligible_count: eligible.length,
    sample_size: probes.length,
    scored_probes: scored,
    seed,
    top_k: topK,
    rrf_mrr: rrfMrr,
    rerank_mrr: rerankMrr,
    delta_mrr: deltaMrr,
    rrf_hit1: scored > 0 ? rrfHit1 / scored : 0,
    rerank_hit1: scored > 0 ? rerankHit1 / scored : 0,
    promotions,
    demotions,
    mean_rerank_ms: scored > 0 ? rerankMsSum / scored : 0,
    verdict,
  }
}

// ─── Per-store cache ─────────────────────────────────────────────────

const CACHE_FILENAME = '.reranker-eval.json'

/** Path of the per-store eval cache file. */
export function rerankerEvalCachePath(storeRoot: string): string {
  return join(storeRoot, CACHE_FILENAME)
}

/**
 * Load the per-store eval cache: reranker name → last result. Corrupt or
 * missing files load as empty — the gate is advisory, never a crash source.
 */
export function loadRerankerEvalCache(storeRoot: string): Record<string, RerankerEvalResult> {
  const path = rerankerEvalCachePath(storeRoot)
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || typeof raw.evals !== 'object' || raw.evals === null) return {}
    return raw.evals as Record<string, RerankerEvalResult>
  } catch {
    return {}
  }
}

/** Persist one eval result into the per-store cache (merge by reranker name). */
export function saveRerankerEvalResult(storeRoot: string, result: RerankerEvalResult): void {
  const evals = loadRerankerEvalCache(storeRoot)
  evals[result.reranker] = result
  atomicWrite(rerankerEvalCachePath(storeRoot), JSON.stringify({ version: 1, evals }, null, 2))
}

/**
 * A cached verdict goes stale when it is older than the staleness bound or
 * the store's engram count drifted more than 20% since the eval ran — either
 * way the store may no longer look like what was measured.
 */
export function isRerankerEvalStale(
  result: RerankerEvalResult,
  currentEngramCount: number,
  now: number = Date.now(),
): boolean {
  const evaluatedAt = Date.parse(result.evaluated_at)
  if (Number.isNaN(evaluatedAt) || now - evaluatedAt > RERANKER_EVAL_STALENESS_MS) return true
  const base = Math.max(1, result.engram_count)
  return Math.abs(currentEngramCount - result.engram_count) / base > RERANKER_EVAL_COUNT_DRIFT
}

// ─── Advisory (log/doctor — never an auto-disable) ───────────────────

/**
 * Build the advisory message for a store+reranker pair, or null when there
 * is nothing to warn about (no cached eval, or verdict is not harmful).
 *
 * ADVISORY by design (#451): the reranker stays enabled; this only makes the
 * measured harm visible so a human can decide to unset PLUR_RERANKER.
 */
export function rerankerEvalAdvisory(
  storeRoot: string,
  rerankerName: string,
  currentEngramCount: number,
): string | null {
  const cached = loadRerankerEvalCache(storeRoot)[rerankerName]
  if (!cached || cached.verdict !== 'harmful') return null
  const stale = isRerankerEvalStale(cached, currentEngramCount)
  const staleNote = stale
    ? ' The verdict is STALE (store changed or eval aged out) — re-run plur_doctor with rerank_eval:true for a fresh read.'
    : ''
  return (
    `[reranker-eval] Per-store self-eval (${cached.evaluated_at}) measured reranker "${rerankerName}" as ` +
    `net-negative on this store: ΔMRR ${cached.delta_mrr.toFixed(3)} over ${cached.scored_probes} probes ` +
    `(demoted known-relevant sources in ${cached.demotions}). This is advisory — reranking remains ENABLED. ` +
    `Consider unsetting PLUR_RERANKER for this store, or re-check via plur_doctor with rerank_eval:true.${staleNote}`
  )
}

/**
 * Log the advisory (loud-once semantics live in the caller — Plur memoizes
 * per instance). Split from {@link rerankerEvalAdvisory} so tests can assert
 * on the message without capturing stderr.
 */
export function logRerankerEvalAdvisory(
  storeRoot: string,
  rerankerName: string,
  currentEngramCount: number,
): void {
  const message = rerankerEvalAdvisory(storeRoot, rerankerName, currentEngramCount)
  if (message) logger.warning(message)
}
