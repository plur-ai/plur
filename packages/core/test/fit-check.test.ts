/**
 * Per-store reranker fit check tests (#451).
 *
 * All tests use a mock reranker — no model download required. The mock lets
 * us exercise the separability logic by returning controlled scores that
 * simulate "the model can distinguish relevance" vs "the model cannot".
 */
import { describe, it, expect } from 'vitest'
import { checkRerankerFit, type FitCheckEngram } from '../src/rerankers/fit-check.js'
import type { RerankerAdapter } from '../src/rerankers/types.js'

// --- Helpers ---

function makeAdapter(opts: {
  /** Score returned for same-domain (positive) pairs. */
  posScore?: number
  /** Score returned for cross-domain (negative) pairs. */
  negScore?: number
  /** Uniform score for all pairs. */
  uniformScore?: number
}): RerankerAdapter {
  const posScore = opts.posScore ?? opts.uniformScore ?? 0
  const negScore = opts.negScore ?? opts.uniformScore ?? 0
  return {
    name: 'mock',
    modelId: 'mock/model',
    async score(_q: string, _d: string) { return posScore },
    async scoreBatch(query: string, documents: string[]) {
      return documents.map(() => {
        // Very rough heuristic: treat queries containing "topic-a" as positive,
        // everything else as negative. The real logic is determined by the pair
        // construction, not by scorer content — so uniform scores work fine for
        // testing the separability arithmetic.
        void query
        return posScore
      })
    },
  }
}

/** Token overlap between a (query, document) pair — the signal a healthy
 *  relevance reranker rewards (same mechanism as reranker-eval.test.ts's oracle). */
function overlap(query: string, document: string): number {
  const qs = new Set(query.toLowerCase().split(/\s+/).filter(Boolean))
  let s = 0
  for (const token of document.toLowerCase().split(/\s+/)) if (qs.has(token)) s += 1
  return s
}

/** A genuinely separating reranker: scores each (query, doc) pair by token
 *  overlap, ranking relevant docs above irrelevant ones. Proven to separate in
 *  reranker-eval.test.ts when fed real probe queries. */
const oracle: RerankerAdapter = {
  name: 'oracle',
  modelId: 'fake://oracle',
  async score(q, d) { return overlap(q, d) },
  async scoreBatch(q, docs) { return docs.map(d => overlap(q, d)) },
}

/** A harmful reranker: INVERTS relevance (higher score for LESS overlap), so
 *  cross-domain distractors outrank same-domain neighbours. */
const inverter: RerankerAdapter = {
  name: 'inverter',
  modelId: 'fake://inverter',
  async score(q, d) { return 10 - overlap(q, d) },
  async scoreBatch(q, docs) { return docs.map(d => 10 - overlap(q, d)) },
}

function engrams(domains: Record<string, string[]>): FitCheckEngram[] {
  return Object.entries(domains).flatMap(([domain, stmts]) =>
    stmts.map(statement => ({ statement, domain }))
  )
}

// --- Tests ---

describe('checkRerankerFit', () => {
  it('returns fit=true with empty engrams (not enough data — benefit of the doubt)', async () => {
    const result = await checkRerankerFit([], makeAdapter({ uniformScore: 0 }))
    expect(result.fit).toBe(true)
    expect(result.n_pairs).toBe(0)
    expect(result.separability).toBe(0)
  })

  it.fails('a genuinely separating reranker yields fit=true on real same-domain data (#451)', async () => {
    // A healthy relevance reranker (oracle: scores by query/doc token overlap)
    // SHOULD be judged a fit. But #451's metric feeds two DIFFERENT same-domain
    // engrams as a (query, doc) "positive" pair — and real engrams within one
    // domain are distinct facts that share few tokens, so even a healthy
    // reranker scores them no higher than cross-domain negatives →
    // separability ≈ 0 → fit=false. The correct expectation is fit=true.
    // it.fails until #451 fixes positive-pair construction (synthesize a probe
    // query from the doc, as reranker-eval does); flip to it() when green.
    const data = engrams({
      'plur.architecture': [
        'Engrams are stored as YAML on disk',
        'Recall uses BM25 and embedding RRF fusion',
        'The reranker rescores top-K candidates',
        'Session lifecycle runs start then learn then end',
      ],
      'personal.preferences': [
        'Always use pnpm never npm',
        'Prefer concise code without excessive comments',
        'Tests must pass before committing',
        'Vitest is the configured test runner',
      ],
    })
    const result = await checkRerankerFit(data, oracle)
    expect(result.n_pairs).toBeGreaterThan(0)
    expect(result.reranker).toBe('oracle')
    expect(result.fit).toBe(true)
  })

  it('a relevance-inverting reranker is NOT a fit (fit=false)', async () => {
    // Same-domain statements here SHARE tokens, so overlap genuinely separates
    // same-domain neighbours (high) from cross-domain pairs (low). The inverter
    // flips that ranking — cross-domain negatives outscore same-domain
    // positives → separability < 0 → correctly judged not a fit.
    const data = engrams({
      'plur': [
        'plur memory engine stores engrams',
        'plur memory engine recalls engrams',
      ],
      'trading': [
        'trading bot executes market orders',
        'trading bot cancels market orders',
      ],
    })
    const result = await checkRerankerFit(data, inverter)
    expect(result.n_pairs).toBeGreaterThan(0)
    expect(result.separability).toBeLessThan(0)
    expect(result.fit).toBe(false)
  })

  it('reports separability ≈ 0 when model gives uniform scores (useless)', async () => {
    const data = engrams({
      'a': ['Engrams are atomic assertions', 'Decay reduces activation over time'],
      'b': ['BM25 scores term frequency', 'RRF fuses ranked lists'],
    })
    const result = await checkRerankerFit(data, makeAdapter({ uniformScore: 5 }))
    // pos_mean == neg_mean → separability == 0.
    expect(result.separability).toBeCloseTo(0, 5)
    expect(result.fit).toBe(false) // 0 < MIN_SEPARABILITY (0.05)
  })

  it('correctly propagates reranker name in result', async () => {
    const adapter: RerankerAdapter = {
      name: 'test-encoder',
      modelId: 'test/encoder',
      async score() { return 0 },
      async scoreBatch(_q, docs) { return docs.map(() => 0) },
    }
    const result = await checkRerankerFit(
      [{ statement: 'hello', domain: 'x' }, { statement: 'world', domain: 'y' }],
      adapter,
    )
    expect(result.reranker).toBe('test-encoder')
  })

  it('handles single-domain stores via positional fallback', async () => {
    const data = Array.from({ length: 8 }, (_, i) => ({
      statement: `Engram number ${i + 1} about the same topic`,
      domain: 'plur',
    }))
    const result = await checkRerankerFit(data, makeAdapter({ uniformScore: 1 }))
    expect(result.n_pairs).toBeGreaterThan(0)
    // Single domain → positional proxy; uniform scores → separability ≈ 0.
    expect(result.separability).toBeCloseTo(0, 5)
  })

  it('respects sampleSize limit', async () => {
    const data = Array.from({ length: 200 }, (_, i) => ({
      statement: `Engram ${i}`,
      domain: i < 100 ? 'domainA' : 'domainB',
    }))
    // Should not throw even though we have 200 engrams and sampleSize=10.
    const result = await checkRerankerFit(data, makeAdapter({ uniformScore: 0 }), { sampleSize: 10 })
    expect(result.n_pairs).toBeGreaterThan(0)
    expect(result.n_pairs).toBeLessThanOrEqual(40) // bounded by sampleSize → fewer pairs
  })

  it('computed_at is a recent timestamp', async () => {
    const before = Date.now()
    const result = await checkRerankerFit([], makeAdapter({ uniformScore: 0 }))
    const after = Date.now()
    expect(result.computed_at).toBeGreaterThanOrEqual(before)
    expect(result.computed_at).toBeLessThanOrEqual(after + 100)
  })
})
