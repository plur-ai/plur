/**
 * Per-store reranker eval gate — #451 (last task).
 *
 * A cross-encoder reranker can be net-negative out-of-domain. Before the
 * default ever flips ON, each store needs a quick self-check: sample the
 * store's own engrams, synthesize probe queries from their statements,
 * and compare rerank-on ordering against the RRF-only ordering. The source
 * engram of each probe is the known-relevant document, so a reranker that
 * demotes it below distractors is measurably harmful ON THIS STORE.
 *
 * The verdict is ADVISORY: it is cached per store, surfaced via plur_doctor
 * and a loud-once log line on the reranker-enable path — never a silent
 * auto-disable. Stub rerankers stand in for the real models so no test
 * downloads anything.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { setEmbeddingsEnabled } from '../src/embeddings.js'
import {
  synthesizeProbeQuery,
  runRerankerSelfEval,
  rerankerEvalCachePath,
  loadRerankerEvalCache,
  saveRerankerEvalResult,
  isRerankerEvalStale,
  rerankerEvalAdvisory,
  RERANKER_EVAL_MIN_PROBES,
  RERANKER_EVAL_STALENESS_MS,
  type RerankerEvalResult,
} from '../src/reranker-eval.js'
import { _setCachedReranker, _resetRerankerCache, resetRerankerStatus } from '../src/rerankers/index.js'
import type { RerankerAdapter } from '../src/rerankers/types.js'
import type { Engram } from '../src/schemas/engram.js'

// Deterministic + offline: the eval gate's contract is about ORDERING
// comparison, not embedding quality. BM25-only keeps the RRF baseline
// bit-stable across machines and avoids the ONNX model load entirely.
beforeAll(() => setEmbeddingsEnabled(false, 'reranker-eval tests run BM25-only'))
afterAll(() => setEmbeddingsEnabled(true))

// ─── Test corpus ─────────────────────────────────────────────────────

/** Statements long enough to yield ≥4 content words each — probe-eligible. */
const STATEMENTS = [
  'The staging deploy target for the ingestion service is cluster-2 in Frankfurt',
  'Karl prefers TypeScript strict mode enabled for every new package in the monorepo',
  'The nightly benchmark harness runs LongMemEval fixtures against the hybrid search pipeline',
  'Postgres connection pooling for the enterprise server uses pgbouncer in transaction mode',
  'The Telegram bot forwards trading alerts to the meridian channel every morning',
  'Grafana dashboards for the reranker latency live under the retrieval folder',
  'The YAML store keeps engram truth while PGLite carries the derived vector index',
  'OpenClaw sessions auto-inject engrams through the context engine assembler hook',
  'The outbox queue retries failed remote writes on every session start event',
  'BM25 tokenization lowercases statements and strips punctuation before scoring',
  'Reciprocal rank fusion merges lexical and semantic result lists with constant sixty',
  'The dedup pipeline hashes statement content before invoking the LLM judge',
]

function mkEngram(id: string, statement: string): Engram {
  return {
    id,
    statement,
    type: 'behavioral',
    scope: 'global',
    domain: 'plur.test',
    status: 'active',
    tags: [],
    activation: {
      retrieval_strength: 1.0,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2026-07-02',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  } as unknown as Engram
}

const CORPUS: Engram[] = STATEMENTS.map((s, i) => mkEngram(`ENG-2026-0702-${String(i + 1).padStart(3, '0')}`, s))

// ─── Stub rerankers ──────────────────────────────────────────────────

/**
 * Oracle: scores each doc by token overlap with the query — since probe
 * queries are synthesized from the source statement's own tokens, the source
 * doc wins. This is the "reranker helps (or at least does not hurt)" control.
 */
const oracle: RerankerAdapter = {
  name: 'oracle',
  modelId: 'fake://oracle',
  async score(q, d) { return overlap(q, d) },
  async scoreBatch(q, docs) { return docs.map(d => overlap(q, d)) },
}

function overlap(query: string, document: string): number {
  const qs = new Set(query.toLowerCase().split(/\s+/).filter(Boolean))
  let s = 0
  for (const token of document.toLowerCase().split(/\s+/)) if (qs.has(token)) s += 1
  return s
}

/**
 * Adversary: inverts whatever order it is given (later docs score higher),
 * so the RRF top-1 source engram gets demoted to the bottom of the pool.
 * This is the "reranker is net-negative on this store" control.
 */
const adversary: RerankerAdapter = {
  name: 'adversary',
  modelId: 'fake://adversary',
  async score() { return 0 },
  async scoreBatch(_q, docs) { return docs.map((_d, i) => i) },
}

/** Broken: always throws — an eval run must propagate this, not swallow it. */
const broken: RerankerAdapter = {
  name: 'broken',
  modelId: 'fake://broken',
  async score() { throw new Error('model load failed') },
  async scoreBatch() { throw new Error('model load failed') },
}

// ─── synthesizeProbeQuery ────────────────────────────────────────────

describe('synthesizeProbeQuery (#451)', () => {
  it('is deterministic for the same statement + seed', () => {
    const s = STATEMENTS[0]
    expect(synthesizeProbeQuery(s, 1337)).toBe(synthesizeProbeQuery(s, 1337))
  })

  it('draws only content words from the statement', () => {
    const q = synthesizeProbeQuery(STATEMENTS[0], 1337)
    expect(q).toBeTruthy()
    const statementTokens = new Set(STATEMENTS[0].toLowerCase().split(/[^a-z0-9-]+/i).filter(Boolean))
    for (const token of q!.split(' ')) {
      expect(statementTokens.has(token)).toBe(true)
    }
  })

  it('strips stopwords', () => {
    const q = synthesizeProbeQuery('the cat is on the mat and it is very happy today', 1)
    expect(q).toBeTruthy()
    for (const stop of ['the', 'is', 'on', 'and', 'it', 'very']) {
      expect(q!.split(' ')).not.toContain(stop)
    }
  })

  it('returns null for statements too short to probe', () => {
    expect(synthesizeProbeQuery('short one', 1337)).toBeNull()
    expect(synthesizeProbeQuery('', 1337)).toBeNull()
    expect(synthesizeProbeQuery('the of and to a in', 1337)).toBeNull()
  })

  it('different seeds can select different word subsets (seeded, not prefix-only)', () => {
    const s = STATEMENTS.join(' ') // long statement, many content words
    const variants = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(seed => synthesizeProbeQuery(s, seed)))
    expect(variants.size).toBeGreaterThan(1)
  })
})

// ─── runRerankerSelfEval ─────────────────────────────────────────────

describe('runRerankerSelfEval (#451)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-rerank-eval-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('an order-agreeing reranker is not harmful on the store', async () => {
    const result = await runRerankerSelfEval(CORPUS, oracle, { storagePath: dir, seed: 1337 })
    expect(result.verdict).not.toBe('harmful')
    expect(result.verdict).not.toBe('insufficient-data')
    expect(result.delta_mrr).toBeGreaterThanOrEqual(-0.05)
    expect(result.scored_probes).toBeGreaterThanOrEqual(RERANKER_EVAL_MIN_PROBES)
    expect(result.reranker).toBe('oracle')
    expect(result.model_id).toBe('fake://oracle')
    expect(result.engram_count).toBe(CORPUS.length)
    expect(result.seed).toBe(1337)
    expect(Date.parse(result.evaluated_at)).not.toBeNaN()
  })

  it('an order-inverting reranker is harmful on the store', async () => {
    const result = await runRerankerSelfEval(CORPUS, adversary, { storagePath: dir, seed: 1337 })
    expect(result.verdict).toBe('harmful')
    expect(result.delta_mrr).toBeLessThan(0)
    expect(result.rerank_mrr).toBeLessThan(result.rrf_mrr)
  })

  it('is deterministic: same corpus + seed + adapter → identical metrics', async () => {
    const a = await runRerankerSelfEval(CORPUS, adversary, { storagePath: dir, seed: 7 })
    const b = await runRerankerSelfEval(CORPUS, adversary, { storagePath: dir, seed: 7 })
    expect(a.rrf_mrr).toBe(b.rrf_mrr)
    expect(a.rerank_mrr).toBe(b.rerank_mrr)
    expect(a.sample_size).toBe(b.sample_size)
    expect(a.verdict).toBe(b.verdict)
  })

  it('returns insufficient-data when too few engrams are probe-eligible', async () => {
    const tiny = CORPUS.slice(0, 2)
    const result = await runRerankerSelfEval(tiny, oracle, { storagePath: dir })
    expect(result.verdict).toBe('insufficient-data')
  })

  it('throws when handed the off sentinel — evaluating nothing is a caller bug', async () => {
    const off: RerankerAdapter = {
      name: 'off',
      modelId: '<off>',
      async score() { return 0 },
      async scoreBatch(_q, docs) { return docs.map(() => 0) },
    }
    await expect(runRerankerSelfEval(CORPUS, off, { storagePath: dir })).rejects.toThrow(/off/i)
  })

  it('propagates reranker failures instead of silently falling back', async () => {
    await expect(runRerankerSelfEval(CORPUS, broken, { storagePath: dir })).rejects.toThrow('model load failed')
  })

  it('respects the sample option', async () => {
    const result = await runRerankerSelfEval(CORPUS, oracle, { storagePath: dir, sample: 6 })
    expect(result.sample_size).toBeLessThanOrEqual(6)
  })
})

// ─── cache + staleness ───────────────────────────────────────────────

describe('reranker eval cache (#451)', () => {
  let dir: string

  const result = (over: Partial<RerankerEvalResult> = {}): RerankerEvalResult => ({
    version: 1,
    reranker: 'ms-marco-minilm-l6',
    model_id: 'Xenova/ms-marco-MiniLM-L-6-v2',
    evaluated_at: new Date().toISOString(),
    engram_count: 100,
    eligible_count: 80,
    sample_size: 20,
    scored_probes: 18,
    seed: 1337,
    top_k: 10,
    rrf_mrr: 0.8,
    rerank_mrr: 0.85,
    delta_mrr: 0.05,
    rrf_hit1: 0.7,
    rerank_hit1: 0.75,
    promotions: 4,
    demotions: 1,
    mean_rerank_ms: 12,
    verdict: 'beneficial',
    ...over,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-rerank-cache-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('save + load roundtrips per reranker name', () => {
    saveRerankerEvalResult(dir, result())
    saveRerankerEvalResult(dir, result({ reranker: 'bge-reranker-v2-m3', verdict: 'harmful', delta_mrr: -0.2 }))
    const cache = loadRerankerEvalCache(dir)
    expect(cache['ms-marco-minilm-l6']?.verdict).toBe('beneficial')
    expect(cache['bge-reranker-v2-m3']?.verdict).toBe('harmful')
    expect(existsSync(rerankerEvalCachePath(dir))).toBe(true)
  })

  it('re-saving the same reranker overwrites its entry', () => {
    saveRerankerEvalResult(dir, result({ verdict: 'neutral' }))
    saveRerankerEvalResult(dir, result({ verdict: 'harmful' }))
    expect(loadRerankerEvalCache(dir)['ms-marco-minilm-l6']?.verdict).toBe('harmful')
  })

  it('tolerates a corrupt cache file (returns empty, does not throw)', () => {
    writeFileSync(rerankerEvalCachePath(dir), '{ not json')
    expect(loadRerankerEvalCache(dir)).toEqual({})
  })

  it('missing cache file loads as empty', () => {
    expect(loadRerankerEvalCache(dir)).toEqual({})
  })

  it('fresh result with stable store size is not stale', () => {
    expect(isRerankerEvalStale(result(), 100)).toBe(false)
    expect(isRerankerEvalStale(result(), 110)).toBe(false) // 10% drift ok
  })

  it('age beyond the staleness bound marks the result stale', () => {
    const old = result({ evaluated_at: new Date(Date.now() - RERANKER_EVAL_STALENESS_MS - 1000).toISOString() })
    expect(isRerankerEvalStale(old, 100)).toBe(true)
  })

  it('a store that grew or shrank >20% marks the result stale', () => {
    expect(isRerankerEvalStale(result(), 130)).toBe(true)
    expect(isRerankerEvalStale(result(), 70)).toBe(true)
  })
})

// ─── advisory (log/doctor — never auto-disable) ──────────────────────

describe('rerankerEvalAdvisory (#451)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-rerank-adv-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const harmful: RerankerEvalResult = {
    version: 1,
    reranker: 'ms-marco-minilm-l6',
    model_id: 'Xenova/ms-marco-MiniLM-L-6-v2',
    evaluated_at: new Date().toISOString(),
    engram_count: 12,
    eligible_count: 12,
    sample_size: 12,
    scored_probes: 12,
    seed: 1337,
    top_k: 10,
    rrf_mrr: 0.9,
    rerank_mrr: 0.4,
    delta_mrr: -0.5,
    rrf_hit1: 0.9,
    rerank_hit1: 0.3,
    promotions: 0,
    demotions: 9,
    mean_rerank_ms: 10,
    verdict: 'harmful',
  }

  it('returns null when no eval has been cached', () => {
    expect(rerankerEvalAdvisory(dir, 'ms-marco-minilm-l6', 12)).toBeNull()
  })

  it('returns null for a beneficial/neutral verdict', () => {
    saveRerankerEvalResult(dir, { ...harmful, verdict: 'neutral', delta_mrr: 0 })
    expect(rerankerEvalAdvisory(dir, 'ms-marco-minilm-l6', 12)).toBeNull()
  })

  it('returns an advisory message for a harmful verdict — mentioning it stays enabled', () => {
    saveRerankerEvalResult(dir, harmful)
    const msg = rerankerEvalAdvisory(dir, 'ms-marco-minilm-l6', 12)
    expect(msg).toBeTruthy()
    expect(msg).toContain('net-negative')
    expect(msg).toContain('ms-marco-minilm-l6')
    // Advisory, not a kill switch: reranking stays on, the message says so.
    expect(msg!.toLowerCase()).toContain('advisory')
    expect(msg).toContain('plur_doctor')
  })

  it('flags staleness in the advisory when the cached verdict is old', () => {
    saveRerankerEvalResult(dir, {
      ...harmful,
      evaluated_at: new Date(Date.now() - RERANKER_EVAL_STALENESS_MS - 1000).toISOString(),
    })
    const msg = rerankerEvalAdvisory(dir, 'ms-marco-minilm-l6', 12)
    expect(msg).toBeTruthy()
    expect(msg!.toLowerCase()).toContain('stale')
  })

  it('is per-reranker: a harmful bge verdict does not warn for the tiny tier', () => {
    saveRerankerEvalResult(dir, { ...harmful, reranker: 'bge-reranker-v2-m3' })
    expect(rerankerEvalAdvisory(dir, 'ms-marco-minilm-l6', 12)).toBeNull()
  })
})

// ─── Plur integration ────────────────────────────────────────────────

describe('Plur.rerankerSelfEval + advisory on the enable path (#451)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-rerank-plur-'))
    plur = new Plur({ path: dir })
    for (const s of STATEMENTS) plur.learn(s, { scope: 'global' })
    _resetRerankerCache()
    resetRerankerStatus()
  })
  afterEach(() => {
    delete process.env.PLUR_RERANKER
    _resetRerankerCache()
    resetRerankerStatus()
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs the self-eval against the store and caches the verdict', async () => {
    process.env.PLUR_RERANKER = 'ms-marco-minilm-l6'
    _setCachedReranker('ms-marco-minilm-l6', { ...adversary, name: 'ms-marco-minilm-l6' })
    const { result, cached } = await plur.rerankerSelfEval()
    expect(cached).toBe(false)
    expect(result.verdict).toBe('harmful')
    expect(result.reranker).toBe('ms-marco-minilm-l6')
    // Cached on disk, keyed by reranker name.
    const disk = loadRerankerEvalCache(plur.status().storage_root)
    expect(disk['ms-marco-minilm-l6']?.verdict).toBe('harmful')
  })

  it('returns the cached verdict on the second call; force re-runs', async () => {
    process.env.PLUR_RERANKER = 'ms-marco-minilm-l6'
    _setCachedReranker('ms-marco-minilm-l6', { ...adversary, name: 'ms-marco-minilm-l6' })
    const first = await plur.rerankerSelfEval()
    expect(first.cached).toBe(false)
    const second = await plur.rerankerSelfEval()
    expect(second.cached).toBe(true)
    expect(second.result.evaluated_at).toBe(first.result.evaluated_at)
    const forced = await plur.rerankerSelfEval({ force: true })
    expect(forced.cached).toBe(false)
  })

  it("throws when PLUR_RERANKER=off (off-sentinel cannot be eval'd)", async () => {
    process.env.PLUR_RERANKER = 'off'
    await expect(plur.rerankerSelfEval()).rejects.toThrow(/PLUR_RERANKER|reranker/i)
  })

  it('rerankerEvalStatus reads the cached verdict without running anything', async () => {
    expect(plur.rerankerEvalStatus('ms-marco-minilm-l6')).toBeNull()
    process.env.PLUR_RERANKER = 'ms-marco-minilm-l6'
    _setCachedReranker('ms-marco-minilm-l6', { ...adversary, name: 'ms-marco-minilm-l6' })
    await plur.rerankerSelfEval()
    const status = plur.rerankerEvalStatus('ms-marco-minilm-l6')
    expect(status).not.toBeNull()
    expect(status!.result.verdict).toBe('harmful')
    expect(status!.stale).toBe(false)
  })

  it('logs the harmful advisory ONCE when the env-configured reranker engages — and keeps reranking', async () => {
    process.env.PLUR_RERANKER = 'ms-marco-minilm-l6'
    _setCachedReranker('ms-marco-minilm-l6', { ...adversary, name: 'ms-marco-minilm-l6' })
    await plur.rerankerSelfEval()

    // Fresh instance simulates a new process picking up the cached verdict.
    const fresh = new Plur({ path: dir })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const first = await fresh.recallHybridWithMeta('staging deploy target cluster', { limit: 5 })
      // NOT auto-disabled: the reranker still engaged.
      expect(first.reranked).toBeGreaterThan(0)
      const warnings = () => spy.mock.calls
        .filter(c => String(c[0]).includes('plur:warning') && c.map(String).join(' ').includes('net-negative'))
        .length
      expect(warnings()).toBe(1)
      // Second recall: advisory does not repeat.
      await fresh.recallHybridWithMeta('staging deploy target cluster', { limit: 5 })
      expect(warnings()).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('does not log an advisory when the cached verdict is not harmful', async () => {
    process.env.PLUR_RERANKER = 'ms-marco-minilm-l6'
    _setCachedReranker('ms-marco-minilm-l6', { ...oracle, name: 'ms-marco-minilm-l6' })
    await plur.rerankerSelfEval()

    const fresh = new Plur({ path: dir })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await fresh.recallHybridWithMeta('staging deploy target cluster', { limit: 5 })
      const warned = spy.mock.calls.some(c => c.map(String).join(' ').includes('net-negative'))
      expect(warned).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})
