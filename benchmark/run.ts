#!/usr/bin/env npx tsx
/**
 * LongMemEval Benchmark Runner for PLUR — Sprint 0 edition.
 *
 * Tests memory retrieval quality across 6 categories and now captures
 * latency p50/p95/p99 + peak RSS + on-disk store size so the Sprint 0 final
 * run (Phase C: N=500 per category) can fill the headline table.
 *
 * Usage:
 *   npx tsx benchmark/run.ts                                # default 30-scenario smoke run
 *   npx tsx benchmark/run.ts --iterations 500               # N per category, seeded
 *   npx tsx benchmark/run.ts --embedder embedding-gemma     # pick an adapter
 *   npx tsx benchmark/run.ts --search-mode hybrid|bm25|semantic
 *   npx tsx benchmark/run.ts --category temporal_reasoning
 *   npx tsx benchmark/run.ts --seed 1337                    # reproducible sampling
 *   npx tsx benchmark/run.ts --output /tmp/results          # override output dir
 *   npx tsx benchmark/run.ts --corpus fixture|longmemeval-s|longmemeval-s-smoke
 *
 * Corpus selection:
 *   --corpus fixture            (default) the 30-scenario hand-curated set
 *                               in benchmark/data/scenarios.yaml. Backward
 *                               compatible — existing pipelines unaffected.
 *   --corpus longmemeval-s      The full official LongMemEval-S (500 questions,
 *                               Wu et al 2024). Loads longmemeval-s.yaml — must
 *                               be generated first via:
 *                                 huggingface-cli download xiaowu0162/longmemeval ...
 *                                 npx tsx benchmark/scripts/import-longmemeval.ts
 *   --corpus longmemeval-s-smoke   30-scenario subset of the real LongMemEval-S
 *                                  (committed; for tests and quick smoke runs).
 *
 * Outputs:
 *   <output>/<sha>-<ts>.json    machine-readable summary + per-scenario results
 *   <output>/<sha>-<ts>.md      human-readable headline table
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import yaml from '../packages/core/node_modules/js-yaml/index.js'
import { Plur } from '../packages/core/src/index.js'
import {
  getEmbedder as getEmbedderAdapter,
  EMBEDDER_NAMES as KNOWN_EMBEDDERS_FROM_CORE,
  type EmbedderAdapter,
} from '../packages/core/src/embedders/index.js'
import { resetEmbedder } from '../packages/core/src/embeddings.js'

// ─── ESM-safe __dirname ─────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ─── Types ──────────────────────────────────────────────────────────

export type EmbedderName = 'minilm' | 'bge-small' | 'bge-base' | 'embedding-gemma'

/**
 * Available corpora. The harness is corpus-agnostic — same scoring code runs
 * over the hand-curated fixture and the real LongMemEval-S so we can compare
 * apples-to-apples once the real corpus is generated.
 */
export type CorpusName = 'fixture' | 'longmemeval-s' | 'longmemeval-s-smoke'

export const CORPUS_FILES: Record<CorpusName, string> = {
  'fixture': 'scenarios.yaml',
  'longmemeval-s': 'longmemeval-s.yaml',
  'longmemeval-s-smoke': 'longmemeval-s-smoke.yaml',
}

export interface Scenario {
  id: string
  category: string
  conversations: Array<{ session: number; turns: Array<{ role: string; content: string }> }>
  query: string
  expected_answer: string
  expected_keywords: string[]
}

export interface ScenarioResult {
  id: string
  category: string
  query: string
  expected_keywords: string[]
  retrieved_statements: string[]
  hit_at_1: boolean
  hit_at_5: boolean
  hit_at_10: boolean
  mrr: number
  accuracy: boolean
  rank: number | null
  latency_ms: number
}

export interface RunOptions {
  /** Per-category sample count. When undefined, runs the full default scenario set. */
  iterations?: number
  embedder?: EmbedderName
  /** 'hybrid' (default), 'bm25', or 'semantic'. */
  searchMode?: string
  category?: string
  /** Deterministic seed for sampling. Default 1337. */
  seed?: number
  /** Where to write the JSON + Markdown output. Default: benchmark/results. */
  outputDir?: string
  /** Silence per-query log output. */
  quiet?: boolean
  /**
   * Cross-encoder reranker stage (#220). Default: 'off' (backward-compatible
   * with prior reports). Use 'on' to enable the BGE reranker for every
   * recall call so the report reflects rerank-on numbers.
   */
  rerank?: 'on' | 'off'
  /** Which corpus to load (default 'fixture' for backward compat). */
  corpus?: CorpusName
  /**
   * Persistent PLUR store path. When set, the harness uses this directory
   * instead of mktempdir, skips ingestion if the store already contains
   * engrams, and DOES NOT delete it on exit. Use to reuse an ingested
   * corpus across multiple config variants (rerank on/off, intent on/off,
   * etc.) without re-ingesting ~30k engrams on every run.
   *
   * IMPORTANT: only safe to reuse across runs that share the same embedder
   * and same corpus, since the stored vectors are embedder-specific.
   */
  plurPath?: string
  /**
   * When true and plurPath is set, force re-ingestion even if the store
   * already has engrams. Useful when the corpus or scenario set changed.
   */
  forceIngest?: boolean
}

export interface RunOutput {
  jsonPath: string
  mdPath: string
  summary: BenchmarkSummary
  results: ScenarioResult[]
}

export interface BenchmarkSummary {
  commit: string
  timestamp: string
  embedder: EmbedderName
  embedder_stub_fallback: boolean
  search_mode: string
  /** Cross-encoder reranker state (#220). 'on' or 'off' — what was REQUESTED. */
  rerank: 'on' | 'off'
  /**
   * How many queries the reranker ACTUALLY reordered. When `rerank: 'on'` but
   * this is < scenario_count, the reranker fell back (model unavailable) on
   * those queries and their numbers are RRF-only — do not read them as reranked.
   */
  reranked_queries: number
  corpus: CorpusName
  scenario_count: number
  iterations_per_category: number | null
  seed: number
  // Headline metrics (LongMemEval taxonomy):
  r5: number          // % of queries with the right engram in the top 5 (a.k.a. Hit@5).
  r1: number          // % of queries with the right engram at rank 1 (a.k.a. Hit@1).
  accuracy: number    // % of queries where every expected_keyword is found in top 10.
  // Latency over recall() / recallHybrid() / recallSemantic() per query, in ms:
  latency_p50_ms: number
  latency_p95_ms: number
  latency_p99_ms: number
  // Footprint:
  peak_rss_mb: number
  store_size_bytes: number
  // Per-category breakdown:
  per_category: Record<string, {
    r5: number
    r1: number
    hit10: number
    mrr: number
    accuracy: number
    latency_p50_ms: number
    latency_p95_ms: number
    latency_p99_ms: number
    count: number
  }>
}

// ─── Loaders ────────────────────────────────────────────────────────

export function loadScenarios(filterCategory?: string, corpus: CorpusName = 'fixture'): Scenario[] {
  const file = CORPUS_FILES[corpus]
  if (!file) {
    throw new Error(`Unknown corpus "${corpus}". Use one of: ${Object.keys(CORPUS_FILES).join(', ')}`)
  }
  const fullPath = path.join(__dirname, 'data', file)
  if (!fs.existsSync(fullPath)) {
    // Special handling for the real LongMemEval-S — it is gitignored because
    // of size; the user has to generate it first. Surface the exact command
    // instead of a generic ENOENT.
    if (corpus === 'longmemeval-s') {
      throw new Error(
        `LongMemEval-S corpus not found at ${fullPath}.\n\n` +
        `Generate it locally with:\n` +
        `  huggingface-cli download xiaowu0162/longmemeval --repo-type dataset \\\n` +
        `    --local-dir benchmark/data/longmemeval-source/\n` +
        `  npx tsx benchmark/scripts/import-longmemeval.ts\n\n` +
        `Or use --corpus longmemeval-s-smoke for the committed 30-scenario subset.`
      )
    }
    throw new Error(`Corpus file not found: ${fullPath}`)
  }
  const raw = fs.readFileSync(fullPath, 'utf-8')
  let scenarios = yaml.load(raw) as Scenario[]
  if (filterCategory) scenarios = scenarios.filter(s => s.category === filterCategory)
  return scenarios
}

// ─── Seeded sampling ────────────────────────────────────────────────

/**
 * Deterministic per-category sampler. Given an `N`, returns N scenarios from
 * each category, sampled with a seeded PRNG. When N exceeds the per-category
 * pool we sample with replacement so callers can request the full Sprint 0
 * LongMemEval-S size (N=500) even though the local fixture only has 5/category.
 */
export function sampleScenarios(all: Scenario[], n: number, seed: number): Scenario[] {
  const categories = [...new Set(all.map(s => s.category))].sort()
  const rng = mulberry32(seed >>> 0)
  const out: Scenario[] = []

  for (const cat of categories) {
    const pool = all.filter(s => s.category === cat)
    if (pool.length === 0) continue

    if (n <= pool.length) {
      // Sample without replacement — Fisher–Yates partial shuffle.
      const idx = Array.from({ length: pool.length }, (_, i) => i)
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        ;[idx[i], idx[j]] = [idx[j], idx[i]]
      }
      for (let i = 0; i < n; i++) out.push(pool[idx[i]])
    } else {
      // Sample with replacement (needed when n > pool.length).
      for (let i = 0; i < n; i++) {
        const j = Math.floor(rng() * pool.length)
        out.push(pool[j])
      }
    }
  }
  return out
}

/** mulberry32 — small, fast, well-distributed PRNG with explicit seed. */
function mulberry32(seed: number): () => number {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function keywordMatch(statement: string, keywords: string[]): boolean {
  const lower = statement.toLowerCase()
  return keywords.some(kw => lower.includes(kw.toLowerCase()))
}

function findRank(results: Array<{ statement: string }>, keywords: string[]): number | null {
  for (let i = 0; i < results.length; i++) {
    if (keywordMatch(results[i].statement, keywords)) return i + 1
  }
  return null
}

export function percentile(sorted: number[], p: number): number {
  // Iter-2 audit M-5 (Dijkstra F-DIJK-004): fix off-by-one at the high end.
  // The previous `floor((p/100) * len)` returned index 19 for p=95 on a
  // 20-element array (the maximum), which equals max(). The simple-discrete
  // formula `floor((p/100) * (len-1))` returns index 18 (the 19th smallest)
  // — matching numpy.percentile(..., method='lower'). For N=500 this
  // shifts p95 by exactly one observation.
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)))
  return sorted[idx]
}

function dirSize(dir: string): number {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) total += dirSize(full)
      else if (entry.isFile()) total += fs.statSync(full).size
    }
  } catch { /* path gone */ }
  return total
}

function commitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || 'unknown'
  } catch { return 'unknown' }
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// Source of truth for embedder names lives in @plur-ai/core. Post-Sprint-0
// follow-up: openai-3-large is now runnable in the harness when
// OPENAI_API_KEY is set, so we can produce gbrain-comparable numbers on
// real LongMemEval-S. The wrapper costs real money per run — caller's
// responsibility, not a CI default.
const HARNESS_EXCLUDED: ReadonlySet<EmbedderName> = new Set()
const KNOWN_EMBEDDERS: EmbedderName[] = KNOWN_EMBEDDERS_FROM_CORE.filter(
  (n) => !HARNESS_EXCLUDED.has(n),
)

// ─── Main harness ───────────────────────────────────────────────────

export async function runBenchmark(opts: RunOptions = {}): Promise<RunOutput> {
  const embedder: EmbedderName = (opts.embedder ?? 'minilm') as EmbedderName
  if (!KNOWN_EMBEDDERS.includes(embedder)) {
    throw new Error(`Unknown embedder "${embedder}". Use one of: ${KNOWN_EMBEDDERS.join(', ')}`)
  }

  // PR 4: all four embedders have real adapters behind them. We route the
  // active model through the EmbedderAdapter factory + PLUR_EMBEDDER env var,
  // so the engine actually switches embedding model when --embedder changes.
  const adapter: EmbedderAdapter = getEmbedderAdapter(embedder)
  // Force the engine to pick the same embedder we are about to benchmark.
  // Reset any embedder pipeline cached by a previous run in this process so
  // back-to-back bake-off runs don't stick to whichever model loaded first.
  process.env.PLUR_EMBEDDER = embedder
  resetEmbedder()
  // Pre-warm the adapter so first-query latency includes one cold load
  // instead of polluting the first scenario's p50 reading. Swallow errors —
  // if the load fails (e.g. the model isn't reachable on a sandboxed CI
  // runner) the engine still degrades gracefully to BM25-only via
  // embeddings.ts and the run produces a valid (lower-recall) report.
  const embedderStubFallback = false
  try {
    await adapter.embed('warmup')
    if (!opts.quiet) {
      console.log(`[embedder] "${embedder}" loaded (${adapter.modelId}, ${adapter.dim}d).`)
    }
  } catch (err) {
    if (!opts.quiet) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[embedder] "${embedder}" cold-load failed: ${msg}`)
      console.log('[embedder] continuing — hybrid search will fall back to BM25 for any missed embeddings.')
    }
  }

  const searchMode = opts.searchMode ?? 'hybrid'
  const seed = opts.seed ?? 1337
  const outputDir = opts.outputDir ?? path.join(__dirname, 'results')
  const corpus: CorpusName = opts.corpus ?? 'fixture'

  // Pick scenarios. With --iterations, sample N per category deterministically.
  // Without --iterations, use the full default scenario set (backward-compat).
  const all = loadScenarios(opts.category, corpus)
  const scenarios = opts.iterations !== undefined
    ? sampleScenarios(all, opts.iterations, seed)
    : all

  if (!scenarios.length) {
    throw new Error('No scenarios found.')
  }

  // Per-run PLUR store. Either:
  //   (a) auto-mkdtemp — fresh isolated store, deleted on exit (default)
  //   (b) opts.plurPath — persistent reusable store, kept on exit
  //
  // Persistent mode lets follow-on runs reuse a corpus-ingested store
  // (same embedder + same corpus) without re-ingesting ~30k engrams every
  // time. Saves hours per run on real LongMemEval-S.
  const useEphemeral = !opts.plurPath
  let tmpDir: string
  if (useEphemeral) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-bench-'))
  } else {
    tmpDir = opts.plurPath!
    fs.mkdirSync(tmpDir, { recursive: true })
  }
  const engramsYamlPath = path.join(tmpDir, 'engrams.yaml')
  if (!fs.existsSync(engramsYamlPath)) fs.writeFileSync(engramsYamlPath, '[]')
  const episodesYamlPath = path.join(tmpDir, 'episodes.yaml')
  if (!fs.existsSync(episodesYamlPath)) fs.writeFileSync(episodesYamlPath, '[]')
  // allow_secrets: true — the LongMemEval-S corpus contains demo strings that
  // trip the secret-detection guard ("password_assignment", "api_key_assigned",
  // etc.). They are benchmark fixtures, not real secrets; the guard would
  // otherwise abort ingestion partway through.
  fs.writeFileSync(
    path.join(tmpDir, 'config.yaml'),
    'auto_learn: true\nindex: false\nallow_secrets: true\n',
  )

  const plur = new Plur({ path: tmpDir })

  // ─── Ingest ──────────────────────────────────────────────────────
  // Skip ingestion when the persistent store already has engrams — unless
  // --force-ingest is set. Detection: count entries in engrams.yaml at load.
  const existingCount = plur.list().length
  const shouldSkipIngest =
    !useEphemeral && existingCount > 0 && !opts.forceIngest

  let engramCount = existingCount
  // Use a Set on scenario ID to dedupe ingestion when N > pool.length (sampling
  // with replacement returns the same conversation more than once).
  const ingestedScenarios = new Set<string>()
  if (shouldSkipIngest) {
    if (!opts.quiet) {
      console.log(`Reusing persistent store at ${tmpDir} (${existingCount} engrams already present, skipping ingest).\n`)
    }
  } else {
    for (const scenario of scenarios) {
      if (ingestedScenarios.has(scenario.id)) continue
      ingestedScenarios.add(scenario.id)
      for (const session of scenario.conversations) {
        for (const turn of session.turns) {
          if (turn.role === 'user') {
            plur.learn(turn.content, { type: 'behavioral', source: `benchmark:${scenario.id}:s${session.session}` })
            engramCount++
          } else if (turn.role === 'assistant') {
            plur.learn(turn.content, { type: 'behavioral', source: `benchmark:${scenario.id}:s${session.session}:assistant` })
            engramCount++
          }
        }
      }
    }
    if (!opts.quiet) {
      console.log(`Ingested ${engramCount} engrams from ${ingestedScenarios.size} unique scenarios (${scenarios.length} query rounds).\n`)
    }
  }

  // Track peak RSS continuously while we hammer recall().
  let peakRssBytes = process.memoryUsage().rss

  // ─── Query ───────────────────────────────────────────────────────
  // #220: cross-encoder reranker is opt-in via --rerank on. When on, every
  // recall call passes `rerank: true` so the BGE reranker reshuffles the
  // top-K candidates and the report reflects rerank-on numbers.
  const rerankOn = opts.rerank === 'on'
  const results: ScenarioResult[] = []
  // How many queries the cross-encoder actually reordered. When rerank is
  // requested but this stays 0 (reranker unavailable / fell back), the run's
  // numbers are RRF-only and the summary must say so — otherwise a silent
  // fallback mislabels RRF results as rerank-on.
  let rerankedQueries = 0
  for (const scenario of scenarios) {
    let retrieved: Array<{ id: string; statement: string }>
    const t0 = process.hrtime.bigint()
    if (searchMode === 'bm25') {
      retrieved = plur.recall(scenario.query, { limit: 10 })
    } else if (searchMode === 'semantic') {
      retrieved = await plur.recallSemantic(scenario.query, { limit: 10, rerank: rerankOn })
    } else {
      // Meta variant so we can observe whether the reranker ACTUALLY ran
      // (reranked > 0) vs. silently fell back to RRF order.
      const meta = await plur.recallHybridWithMeta(scenario.query, { limit: 10, rerank: rerankOn })
      retrieved = meta.engrams
      if ((meta.reranked ?? 0) > 0) rerankedQueries++
    }
    const t1 = process.hrtime.bigint()
    const latency_ms = Number(t1 - t0) / 1_000_000

    const rss = process.memoryUsage().rss
    if (rss > peakRssBytes) peakRssBytes = rss

    const rank = findRank(retrieved, scenario.expected_keywords)
    const allKeywordsFound = scenario.expected_keywords.every(kw =>
      retrieved.some(r => r.statement.toLowerCase().includes(kw.toLowerCase()))
    )

    const result: ScenarioResult = {
      id: scenario.id,
      category: scenario.category,
      query: scenario.query,
      expected_keywords: scenario.expected_keywords,
      retrieved_statements: retrieved.map(r => r.statement).slice(0, 5),
      hit_at_1: rank === 1,
      hit_at_5: rank !== null && rank <= 5,
      hit_at_10: rank !== null && rank <= 10,
      mrr: rank !== null ? 1 / rank : 0,
      accuracy: allKeywordsFound,
      rank,
      latency_ms,
    }
    results.push(result)

    if (!opts.quiet) {
      const mark = result.hit_at_10 ? '[o]' : '[x]'
      const matches = scenario.expected_keywords.filter(kw =>
        retrieved.some(r => r.statement.toLowerCase().includes(kw.toLowerCase()))
      )
      console.log(`  ${mark} ${scenario.id}: rank=${rank ?? 'miss'} lat=${latency_ms.toFixed(1)}ms mrr=${result.mrr.toFixed(3)} matches=[${matches.join(', ')}]`)
    }
  }

  // ─── Aggregate ───────────────────────────────────────────────────
  const r5 = results.filter(r => r.hit_at_5).length / results.length * 100
  const r1 = results.filter(r => r.hit_at_1).length / results.length * 100
  const accuracy = results.filter(r => r.accuracy).length / results.length * 100

  const allLatencies = results.map(r => r.latency_ms).sort((a, b) => a - b)
  const latency_p50_ms = percentile(allLatencies, 50)
  const latency_p95_ms = percentile(allLatencies, 95)
  const latency_p99_ms = percentile(allLatencies, 99)

  // Store footprint: total bytes on disk for the temp PLUR dir at end of run.
  const store_size_bytes = dirSize(tmpDir)
  const peak_rss_mb = Math.round((peakRssBytes / (1024 * 1024)) * 100) / 100

  const categories = [...new Set(results.map(r => r.category))]
  const per_category: BenchmarkSummary['per_category'] = {}
  for (const cat of categories) {
    const cr = results.filter(r => r.category === cat)
    const lat = cr.map(r => r.latency_ms).sort((a, b) => a - b)
    per_category[cat] = {
      r5: cr.filter(r => r.hit_at_5).length / cr.length * 100,
      r1: cr.filter(r => r.hit_at_1).length / cr.length * 100,
      hit10: cr.filter(r => r.hit_at_10).length / cr.length * 100,
      mrr: cr.reduce((s, r) => s + r.mrr, 0) / cr.length,
      accuracy: cr.filter(r => r.accuracy).length / cr.length * 100,
      latency_p50_ms: percentile(lat, 50),
      latency_p95_ms: percentile(lat, 95),
      latency_p99_ms: percentile(lat, 99),
      count: cr.length,
    }
  }

  const summary: BenchmarkSummary = {
    commit: commitSha(),
    timestamp: new Date().toISOString(),
    embedder,
    embedder_stub_fallback: embedderStubFallback,
    search_mode: searchMode,
    rerank: rerankOn ? 'on' : 'off',
    reranked_queries: rerankedQueries,
    corpus,
    scenario_count: results.length,
    iterations_per_category: opts.iterations ?? null,
    seed,
    r5,
    r1,
    accuracy,
    latency_p50_ms,
    latency_p95_ms,
    latency_p99_ms,
    peak_rss_mb,
    store_size_bytes,
    per_category,
  }

  if (!opts.quiet) {
    printSummary(summary)
  }

  // ─── Write outputs ───────────────────────────────────────────────
  fs.mkdirSync(outputDir, { recursive: true })
  const baseName = `${summary.commit}-${isoStamp()}`
  const jsonPath = path.join(outputDir, `${baseName}.json`)
  const mdPath = path.join(outputDir, `${baseName}.md`)

  fs.writeFileSync(jsonPath, JSON.stringify({ ...summary, results }, null, 2))
  fs.writeFileSync(mdPath, renderMarkdown(summary))

  if (!opts.quiet) {
    console.log(`\nJSON saved to: ${jsonPath}`)
    console.log(`Markdown saved to: ${mdPath}`)
  }

  // Cleanup the per-run store ONLY if it was ephemeral. Persistent stores
  // (--plur-path) are kept for reuse by follow-on runs.
  if (useEphemeral) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } else if (!opts.quiet) {
    console.log(`Persistent store retained at: ${tmpDir}`)
  }

  return { jsonPath, mdPath, summary, results }
}

function printSummary(s: BenchmarkSummary) {
  console.log('\n\nResults Summary')
  console.log('===============\n')
  console.log(`Embedder:        ${s.embedder}${s.embedder_stub_fallback ? ' (stub fallback → minilm)' : ''}`)
  console.log(`Search mode:     ${s.search_mode}`)
  console.log(`Reranker:        ${s.rerank}${s.rerank === 'on' ? ` (engaged ${s.reranked_queries}/${s.scenario_count} queries)` : ''}`)
  if (s.rerank === 'on' && s.reranked_queries === 0) {
    console.log(`  ⚠  rerank was REQUESTED but the reranker never ran (model unavailable / fell back) —`)
    console.log(`     these numbers are RRF-only, NOT reranked. Warm the reranker model and re-run to measure rerank.`)
  } else if (s.rerank === 'on' && s.reranked_queries < s.scenario_count) {
    console.log(`  ⚠  rerank ran on only ${s.reranked_queries}/${s.scenario_count} queries — the rest are RRF-only.`)
  }
  console.log(`Corpus:          ${s.corpus}`)
  console.log(`Scenarios:       ${s.scenario_count}${s.iterations_per_category !== null ? ` (N=${s.iterations_per_category}/category, seed=${s.seed})` : ''}`)
  console.log(`Commit:          ${s.commit}`)
  console.log()
  console.log('Overall:')
  console.log(`  R@5:           ${s.r5.toFixed(1)}%`)
  console.log(`  R@1:           ${s.r1.toFixed(1)}%`)
  console.log(`  Accuracy:      ${s.accuracy.toFixed(1)}% (all keywords found)`)
  console.log()
  console.log('Latency:')
  console.log(`  p50:           ${s.latency_p50_ms.toFixed(2)}ms`)
  console.log(`  p95:           ${s.latency_p95_ms.toFixed(2)}ms`)
  console.log(`  p99:           ${s.latency_p99_ms.toFixed(2)}ms`)
  console.log()
  console.log('Footprint:')
  console.log(`  Peak RSS:      ${s.peak_rss_mb} MB`)
  console.log(`  Store size:    ${s.store_size_bytes} bytes`)
  console.log()
  console.log('Per Category:')
  console.log(`${'Category'.padEnd(30)} ${'R@5'.padEnd(8)} ${'R@1'.padEnd(8)} ${'MRR'.padEnd(8)} ${'p95'.padEnd(8)}`)
  console.log('-'.repeat(70))
  for (const [cat, m] of Object.entries(s.per_category)) {
    console.log(`${cat.padEnd(30)} ${(m.r5.toFixed(0) + '%').padEnd(8)} ${(m.r1.toFixed(0) + '%').padEnd(8)} ${m.mrr.toFixed(3).padEnd(8)} ${(m.latency_p95_ms.toFixed(1) + 'ms').padEnd(8)}`)
  }
}

function renderMarkdown(s: BenchmarkSummary): string {
  const lines: string[] = []
  lines.push(`# PLUR Benchmark — ${s.commit} (${s.timestamp})`)
  lines.push('')
  lines.push(`Embedder: \`${s.embedder}\`${s.embedder_stub_fallback ? ' (stub fallback → minilm, real adapter lands in PR 4)' : ''}`)
  lines.push(`Search mode: \`${s.search_mode}\``)
  lines.push(`Reranker: \`${s.rerank}\`${s.rerank === 'on' ? ` (engaged ${s.reranked_queries}/${s.scenario_count})` : ''}`)
  if (s.rerank === 'on' && s.reranked_queries < s.scenario_count) {
    lines.push(`> ⚠ rerank requested but engaged ${s.reranked_queries}/${s.scenario_count} queries — ${s.reranked_queries === 0 ? 'numbers are RRF-only, not reranked' : 'remaining queries are RRF-only'}.`)
  }
  lines.push(`Corpus: \`${s.corpus}\``)
  lines.push(`Scenarios: ${s.scenario_count}${s.iterations_per_category !== null ? ` (N=${s.iterations_per_category}/category, seed=${s.seed})` : ' (default fixture)'}`)
  lines.push('')
  lines.push('## Headline')
  lines.push('')
  lines.push('| Metric | Value |')
  lines.push('|---|---|')
  lines.push(`| R@5 | ${s.r5.toFixed(1)}% |`)
  lines.push(`| R@1 | ${s.r1.toFixed(1)}% |`)
  lines.push(`| Accuracy | ${s.accuracy.toFixed(1)}% |`)
  lines.push(`| Latency p50 | ${s.latency_p50_ms.toFixed(2)} ms |`)
  lines.push(`| Latency p95 | ${s.latency_p95_ms.toFixed(2)} ms |`)
  lines.push(`| Latency p99 | ${s.latency_p99_ms.toFixed(2)} ms |`)
  lines.push(`| Peak RSS | ${s.peak_rss_mb} MB |`)
  lines.push(`| Store size | ${s.store_size_bytes} bytes |`)
  lines.push('')
  lines.push('## Per Category')
  lines.push('')
  lines.push('| Category | N | R@5 | R@1 | Hit@10 | MRR | Accuracy | p50 ms | p95 ms | p99 ms |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const [cat, m] of Object.entries(s.per_category)) {
    lines.push(`| ${cat} | ${m.count} | ${m.r5.toFixed(1)}% | ${m.r1.toFixed(1)}% | ${m.hit10.toFixed(1)}% | ${m.mrr.toFixed(3)} | ${m.accuracy.toFixed(1)}% | ${m.latency_p50_ms.toFixed(2)} | ${m.latency_p95_ms.toFixed(2)} | ${m.latency_p99_ms.toFixed(2)} |`)
  }
  lines.push('')
  return lines.join('\n')
}

// ─── CLI entry point ────────────────────────────────────────────────

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--iterations' && argv[i + 1]) opts.iterations = parseInt(argv[++i], 10)
    else if (a === '--embedder' && argv[i + 1]) opts.embedder = argv[++i] as EmbedderName
    else if (a === '--search-mode' && argv[i + 1]) opts.searchMode = argv[++i]
    else if (a === '--category' && argv[i + 1]) opts.category = argv[++i]
    else if (a === '--seed' && argv[i + 1]) opts.seed = parseInt(argv[++i], 10)
    else if ((a === '--output' || a === '--output-dir') && argv[i + 1]) opts.outputDir = argv[++i]
    else if (a === '--quiet') opts.quiet = true
    else if (a === '--rerank' && argv[i + 1]) {
      const r = argv[++i]
      if (r !== 'on' && r !== 'off') {
        throw new Error(`--rerank takes "on" or "off", got "${r}"`)
      }
      opts.rerank = r
    }
    else if (a === '--corpus' && argv[i + 1]) {
      const c = argv[++i] as CorpusName
      if (!(c in CORPUS_FILES)) {
        throw new Error(`Unknown corpus "${c}". Use one of: ${Object.keys(CORPUS_FILES).join(', ')}`)
      }
      opts.corpus = c
    }
    else if (a === '--plur-path' && argv[i + 1]) opts.plurPath = argv[++i]
    else if (a === '--force-ingest') opts.forceIngest = true
  }
  return opts
}

const isMain = (() => {
  // Detect "run directly" in both ESM and tsx modes.
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename)
  } catch { return false }
})()

if (isMain) {
  runBenchmark(parseArgs(process.argv.slice(2))).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
