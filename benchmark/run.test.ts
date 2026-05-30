/**
 * Tests for the LongMemEval benchmark harness (benchmark/run.ts).
 *
 * Verifies:
 *   - Backward compat: default (no flags) still runs the 30-scenario path.
 *   - --iterations N samples N scenarios per category deterministically.
 *   - The same seed produces identical samples across runs (reproducibility).
 *   - The JSON output contains the new headline keys: r5, r1, accuracy,
 *     latency_p50_ms / p95_ms / p99_ms, peak_rss_mb, store_size_bytes.
 *   - The harness also writes a human-readable Markdown summary alongside the JSON.
 *   - --embedder picks the requested adapter and the three stub adapters
 *     (bge-small, bge-base, embedding-gemma) fall back to the MiniLM path
 *     with a clear log line until PR 4 lands.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
import { runBenchmark, sampleScenarios, loadScenarios, percentile, CORPUS_FILES } from './run.js'
import { extractKeywords } from './scripts/import-longmemeval.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let workDir: string

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-bench-test-'))
})

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('sampleScenarios', () => {
  it('returns N scenarios per category with a fixed seed (deterministic)', () => {
    const all = loadScenarios()
    const sampleA = sampleScenarios(all, 3, 1337)
    const sampleB = sampleScenarios(all, 3, 1337)

    // Same seed → identical order and content.
    expect(sampleA.map(s => s.id)).toEqual(sampleB.map(s => s.id))

    // N per category.
    const categories = [...new Set(all.map(s => s.category))]
    for (const cat of categories) {
      const got = sampleA.filter(s => s.category === cat).length
      expect(got).toBe(3)
    }
  })

  it('different seeds produce different orderings (probabilistic, but deterministic)', () => {
    const all = loadScenarios()
    const sampleA = sampleScenarios(all, 3, 1)
    const sampleB = sampleScenarios(all, 3, 2)
    // At least one of the two seeds should differ in order/content for at least one category.
    expect(sampleA.map(s => s.id).join(',')).not.toBe(sampleB.map(s => s.id).join(','))
  })

  it('handles N larger than per-category count by sampling with replacement', () => {
    const all = loadScenarios()
    // We have 5 per category; ask for 10. This must not crash.
    const sample = sampleScenarios(all, 10, 42)
    const categories = [...new Set(all.map(s => s.category))]
    for (const cat of categories) {
      const got = sample.filter(s => s.category === cat).length
      expect(got).toBe(10)
    }
  })
})

describe('corpus loader', () => {
  it('loads the default fixture corpus (backward-compat)', () => {
    const fixture = loadScenarios()
    expect(fixture.length).toBe(30)
    const explicit = loadScenarios(undefined, 'fixture')
    expect(explicit.length).toBe(fixture.length)
    expect(explicit.map(s => s.id)).toEqual(fixture.map(s => s.id))
  })

  it('loads the committed longmemeval-s-smoke corpus with the expected shape', () => {
    const smoke = loadScenarios(undefined, 'longmemeval-s-smoke')
    expect(smoke.length).toBe(30)
    const cats = new Set(smoke.map(s => s.category))
    expect(cats.has('single_session_user')).toBe(true)
    expect(cats.has('single_session_preference')).toBe(true)
    expect(cats.has('single_session_assistant')).toBe(true)
    expect(cats.has('temporal_reasoning')).toBe(true)
    expect(cats.has('knowledge_updates')).toBe(true)
    expect(cats.has('multi_session_reasoning')).toBe(true)
    for (const s of smoke) {
      expect(s.id).toBeTruthy()
      expect(s.category).toBeTruthy()
      expect(typeof s.query).toBe('string')
      expect(s.conversations.length).toBeGreaterThan(0)
      expect(s.expected_keywords.length).toBeGreaterThan(0)
    }
  })

  it('loads the full longmemeval-s corpus when it has been generated', () => {
    // The full corpus is gitignored; skip if the contributor hasn't run the importer.
    const fullPath = path.join(__dirname, 'data', CORPUS_FILES['longmemeval-s'])
    if (!fs.existsSync(fullPath)) {
      console.log(`[skip] ${fullPath} not present — run benchmark/scripts/import-longmemeval.ts to generate it.`)
      return
    }
    const full = loadScenarios(undefined, 'longmemeval-s')
    expect(full.length).toBeGreaterThanOrEqual(475)
    expect(full.length).toBeLessThanOrEqual(525)
    const cats = new Set(full.map(s => s.category))
    expect(cats.size).toBe(6)
    for (const s of full) {
      expect(s.id).toBeTruthy()
      expect(s.category).toBeTruthy()
      expect(typeof s.query).toBe('string')
      expect(s.conversations.length).toBeGreaterThan(0)
    }
  })

  it('throws a helpful error for unknown corpus names', () => {
    expect(() => loadScenarios(undefined, 'does-not-exist' as 'fixture')).toThrow(/Unknown corpus|not found/i)
  })

  it('throws a setup-hint error when longmemeval-s is missing', () => {
    const fullPath = path.join(__dirname, 'data', CORPUS_FILES['longmemeval-s'])
    if (fs.existsSync(fullPath)) {
      return
    }
    expect(() => loadScenarios(undefined, 'longmemeval-s')).toThrow(/huggingface-cli download xiaowu0162\/longmemeval/)
  })
})

describe('extractKeywords (LongMemEval converter)', () => {
  it('pulls capitalised proper nouns out of the answer', () => {
    const kw = extractKeywords('Business Administration')
    expect(kw).toContain('Business Administration')
  })

  it('extracts numbers and units from numeric answers', () => {
    const kw = extractKeywords('25 minutes and 50 seconds (or 25:50)')
    expect(kw.some(k => /\d/.test(k))).toBe(true)
  })

  it('coerces bare numeric answers (LongMemEval ships some as ints)', () => {
    expect(() => extractKeywords(3)).not.toThrow()
    expect(extractKeywords(3)).toContain('3')
    expect(extractKeywords(1300)).toContain('1300')
  })

  it('returns at most 5 keywords (cap is enforced)', () => {
    const long = 'Alice Bob Carol Dave Eve Frank Greta Hannah Ian John'
    const kw = extractKeywords(long)
    expect(kw.length).toBeLessThanOrEqual(5)
  })

  it('falls back to long content words when no proper nouns are present', () => {
    const kw = extractKeywords('the user prefers programming languages with garbage collection')
    expect(kw.length).toBeGreaterThan(0)
  })

  it('returns an empty list for empty input', () => {
    expect(extractKeywords('')).toEqual([])
    expect(extractKeywords(null)).toEqual([])
    expect(extractKeywords(undefined)).toEqual([])
  })
})

describe('percentile (iter-2 audit M-5 — Dijkstra F-DIJK-004)', () => {
  it('p95 on 20 sorted observations returns the 19th smallest, not the max', () => {
    // Iter-2 audit M-5: the old formula floor((p/100)*len) returned index 19
    // (the maximum) on a 20-element array — wrong. The fixed formula
    // floor((p/100)*(len-1)) returns index 18 (the 19th smallest).
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1)
    // [1, 2, ..., 20]. p95 should be the 19th value = 19, NOT 20.
    expect(percentile(sorted, 95)).toBe(19)
    expect(percentile(sorted, 95)).not.toBe(20)
  })

  it('p50 on a 5-element array returns the median (index 2)', () => {
    // [10, 20, 30, 40, 50] — median is 30 (index 2).
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30)
  })

  it('p100 returns the max', () => {
    expect(percentile([1, 5, 10], 100)).toBe(10)
  })

  it('p0 returns the min', () => {
    expect(percentile([1, 5, 10], 0)).toBe(1)
  })

  it('returns 0 for empty input', () => {
    expect(percentile([], 95)).toBe(0)
  })

  it('handles single-element arrays without crashing', () => {
    expect(percentile([42], 99)).toBe(42)
    expect(percentile([42], 50)).toBe(42)
  })
})

describe('runBenchmark', () => {
  it('produces JSON output with all required headline keys at small N', async () => {
    const out = await runBenchmark({
      iterations: 3,
      embedder: 'minilm',
      searchMode: 'hybrid',
      outputDir: workDir,
      quiet: true,
      seed: 7,
    })

    expect(out.jsonPath).toMatch(/\.json$/)
    expect(fs.existsSync(out.jsonPath)).toBe(true)

    const j = JSON.parse(fs.readFileSync(out.jsonPath, 'utf-8'))

    // Headline metrics required for Sprint 0 acceptance.
    expect(j).toHaveProperty('r5')
    expect(j).toHaveProperty('r1')
    expect(j).toHaveProperty('accuracy')
    expect(j).toHaveProperty('latency_p50_ms')
    expect(j).toHaveProperty('latency_p95_ms')
    expect(j).toHaveProperty('latency_p99_ms')
    expect(j).toHaveProperty('peak_rss_mb')
    expect(j).toHaveProperty('store_size_bytes')

    // Per-category breakdown also present for the report.
    expect(j).toHaveProperty('per_category')
    expect(typeof j.per_category).toBe('object')

    // Embedder + run config captured for traceability.
    expect(j.embedder).toBe('minilm')
    expect(j.iterations_per_category).toBe(3)

    // Numeric sanity.
    expect(j.r5).toBeGreaterThanOrEqual(0)
    expect(j.r5).toBeLessThanOrEqual(100)
    expect(j.latency_p95_ms).toBeGreaterThanOrEqual(j.latency_p50_ms)
    expect(j.latency_p99_ms).toBeGreaterThanOrEqual(j.latency_p95_ms)
    expect(j.peak_rss_mb).toBeGreaterThan(0)
    expect(j.store_size_bytes).toBeGreaterThan(0)
  }, 60000)

  it('also writes a human-readable Markdown summary alongside the JSON', async () => {
    const out = await runBenchmark({
      iterations: 3,
      embedder: 'minilm',
      searchMode: 'hybrid',
      outputDir: workDir,
      quiet: true,
      seed: 11,
    })

    expect(out.mdPath).toMatch(/\.md$/)
    expect(fs.existsSync(out.mdPath)).toBe(true)

    const md = fs.readFileSync(out.mdPath, 'utf-8')
    // Headline table near the top.
    expect(md).toMatch(/#\s+PLUR Benchmark/i)
    expect(md).toMatch(/R@5/)
    expect(md).toMatch(/R@1/)
    expect(md).toMatch(/Accuracy/)
    expect(md).toMatch(/Latency p50/i)
    expect(md).toMatch(/Peak RSS/i)
    expect(md).toMatch(/Store size/i)
  }, 60000)

  it('preserves the backward-compatible 30-scenario default when no --iterations is passed', async () => {
    const out = await runBenchmark({
      // No iterations → use full default scenario set (30 questions, current behaviour).
      embedder: 'minilm',
      searchMode: 'bm25', // BM25 is faster; this is a smoke test.
      outputDir: workDir,
      quiet: true,
    })

    const j = JSON.parse(fs.readFileSync(out.jsonPath, 'utf-8'))
    // Default mode runs over the full 30-scenario set.
    expect(j.scenario_count).toBe(30)
    // Still emits the new headline keys (they are always present).
    expect(j).toHaveProperty('r5')
    expect(j).toHaveProperty('latency_p50_ms')
  }, 120000)

  it('runs over the longmemeval-s-smoke corpus end-to-end', async () => {
    const out = await runBenchmark({
      corpus: 'longmemeval-s-smoke',
      iterations: 1,
      embedder: 'minilm',
      searchMode: 'bm25',
      outputDir: workDir,
      quiet: true,
      seed: 7,
    })

    const j = JSON.parse(fs.readFileSync(out.jsonPath, 'utf-8'))
    expect(j.corpus).toBe('longmemeval-s-smoke')
    expect(j.scenario_count).toBe(6)
    expect(j).toHaveProperty('r5')
    expect(j).toHaveProperty('per_category')
    expect(Object.keys(j.per_category).length).toBe(6)
  }, 120000)

  it('accepts the four embedder names and runs the real adapter (PR 4)', async () => {
    const out = await runBenchmark({
      iterations: 1,
      embedder: 'embedding-gemma',
      // BM25 search mode keeps this test offline-safe: the harness still
      // pre-warms the embedder adapter, but recall doesn't depend on a
      // successful model load. With --search-mode=hybrid this test would
      // require the EmbeddingGemma weights to download on the CI runner.
      searchMode: 'bm25',
      outputDir: workDir,
      quiet: true,
      seed: 1,
    })

    const j = JSON.parse(fs.readFileSync(out.jsonPath, 'utf-8'))
    // Requested embedder is recorded.
    expect(j.embedder).toBe('embedding-gemma')
    // PR 4 wires real adapters for all four names — stub-fallback is gone.
    expect(j.embedder_stub_fallback).toBe(false)
  }, 120000)
})
