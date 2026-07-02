/**
 * Tests for the LongMemEval benchmark harness (benchmark/run.ts).
 *
 * Verifies:
 *   - The vendored inline fixture (below) drives the whole suite — since #336
 *     the tracked corpus files live in plur-bench, so a fresh clone of this
 *     repo has an empty benchmark/data/ and the tests must not depend on it.
 *   - Corpus path resolution (#336): --data-dir / PLUR_BENCH_DATA_DIR override,
 *     repo-local default, plur-bench checkout fallback (PLUR_BENCH_REPO).
 *   - --iterations N samples N scenarios per category deterministically.
 *   - The same seed produces identical samples across runs (reproducibility).
 *   - The JSON output contains the headline keys: r5, r1, accuracy,
 *     latency_p50_ms / p95_ms / p99_ms, peak_rss_mb, store_size_bytes.
 *   - The harness also writes a human-readable Markdown summary alongside the JSON.
 *   - --embedder picks the requested adapter (all four names run real adapters).
 *   - PLUR_BENCH_RESULTS_DIR redirects result output when no outputDir is given.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'url'
import {
  runBenchmark,
  sampleScenarios,
  loadScenarios,
  resolveCorpusPath,
  percentile,
  CORPUS_FILES,
  type Scenario,
} from './run.js'
import { extractKeywords } from './scripts/import-longmemeval.js'
import * as rerankers from '../packages/core/src/rerankers/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ─── Vendored inline fixture (#336) ─────────────────────────────────
// A tiny 12-scenario corpus (2 per category) so the suite never depends on
// the tracked benchmark/data/scenarios.yaml — that file moved to plur-bench
// (corpus/monorepo/scenarios.yaml) and is absent in fresh clones / CI.
const VENDORED_SCENARIOS: Scenario[] = [
  {
    id: 'vf-user-1',
    category: 'single_session_user',
    conversations: [{ session: 1, turns: [
      { role: 'user', content: 'I just moved to Lisbon and started work as a marine biologist at the oceanarium.' },
      { role: 'assistant', content: 'Lisbon is a great city for marine research — congratulations on the new role.' },
    ] }],
    query: 'What is the user\'s job?',
    expected_answer: 'marine biologist',
    expected_keywords: ['marine biologist'],
  },
  {
    id: 'vf-user-2',
    category: 'single_session_user',
    conversations: [{ session: 1, turns: [
      { role: 'user', content: 'My dog Biscuit is a three-year-old corgi who steals socks.' },
    ] }],
    query: 'What is the name of the user\'s dog?',
    expected_answer: 'Biscuit',
    expected_keywords: ['Biscuit'],
  },
  {
    id: 'vf-pref-1',
    category: 'single_session_preference',
    conversations: [{ session: 1, turns: [
      { role: 'user', content: 'Please always answer me in bullet points, I hate long paragraphs.' },
      { role: 'assistant', content: 'Understood — bullet points from now on.' },
    ] }],
    query: 'How does the user prefer answers formatted?',
    expected_answer: 'bullet points',
    expected_keywords: ['bullet points'],
  },
  {
    id: 'vf-pref-2',
    category: 'single_session_preference',
    conversations: [{ session: 1, turns: [
      { role: 'user', content: 'I am vegetarian, so never suggest recipes with meat.' },
    ] }],
    query: 'What dietary restriction does the user have?',
    expected_answer: 'vegetarian',
    expected_keywords: ['vegetarian'],
  },
  {
    id: 'vf-assist-1',
    category: 'single_session_assistant',
    conversations: [{ session: 1, turns: [
      { role: 'user', content: 'What port does the staging server use?' },
      { role: 'assistant', content: 'The staging server listens on port 8443 behind the nginx proxy.' },
    ] }],
    query: 'What port did the assistant say the staging server uses?',
    expected_answer: '8443',
    expected_keywords: ['8443'],
  },
  {
    id: 'vf-assist-2',
    category: 'single_session_assistant',
    conversations: [{ session: 1, turns: [
      { role: 'user', content: 'Which pasta shape did you recommend for the pesto?' },
      { role: 'assistant', content: 'I recommended trofie — it holds pesto genovese better than spaghetti.' },
    ] }],
    query: 'What pasta shape did the assistant recommend?',
    expected_answer: 'trofie',
    expected_keywords: ['trofie'],
  },
  {
    id: 'vf-temporal-1',
    category: 'temporal_reasoning',
    conversations: [{ session: 1, turns: [
      { role: 'user', content: 'I signed the apartment lease on March 3rd, two weeks before my birthday.' },
    ] }],
    query: 'When did the user sign the apartment lease?',
    expected_answer: 'March 3rd',
    expected_keywords: ['March 3'],
  },
  {
    id: 'vf-temporal-2',
    category: 'temporal_reasoning',
    conversations: [{ session: 1, turns: [
      { role: 'user', content: 'The marathon is on October 12th and I started training in June.' },
    ] }],
    query: 'When is the marathon?',
    expected_answer: 'October 12th',
    expected_keywords: ['October 12'],
  },
  {
    id: 'vf-update-1',
    category: 'knowledge_updates',
    conversations: [
      { session: 1, turns: [{ role: 'user', content: 'I drive a silver Honda Civic.' }] },
      { session: 2, turns: [{ role: 'user', content: 'Update: I sold the Civic and now drive a blue Mazda 3.' }] },
    ],
    query: 'What car does the user drive now?',
    expected_answer: 'blue Mazda 3',
    expected_keywords: ['Mazda'],
  },
  {
    id: 'vf-update-2',
    category: 'knowledge_updates',
    conversations: [
      { session: 1, turns: [{ role: 'user', content: 'My office is in the Almaden building.' }] },
      { session: 2, turns: [{ role: 'user', content: 'We relocated — my office is now in the Coleman tower, floor 9.' }] },
    ],
    query: 'Which building is the user\'s office in now?',
    expected_answer: 'Coleman tower',
    expected_keywords: ['Coleman'],
  },
  {
    id: 'vf-multi-1',
    category: 'multi_session_reasoning',
    conversations: [
      { session: 1, turns: [{ role: 'user', content: 'My sister Ana lives in Porto.' }] },
      { session: 2, turns: [{ role: 'user', content: 'Ana just adopted a parrot called Rio.' }] },
    ],
    query: 'What pet does the user\'s sister have?',
    expected_answer: 'a parrot called Rio',
    expected_keywords: ['parrot', 'Rio'],
  },
  {
    id: 'vf-multi-2',
    category: 'multi_session_reasoning',
    conversations: [
      { session: 1, turns: [{ role: 'user', content: 'I am reading a sci-fi novel called Glass Orbit.' }] },
      { session: 2, turns: [{ role: 'user', content: 'Finished Glass Orbit — the twist was that the station AI wrote the distress calls.' }] },
    ],
    query: 'What was the twist in the novel the user read?',
    expected_answer: 'the station AI wrote the distress calls',
    expected_keywords: ['AI', 'distress'],
  },
]

const VENDORED_CATEGORIES = [...new Set(VENDORED_SCENARIOS.map(s => s.category))]

let workDir: string
/** Directory holding the vendored fixture as scenarios.yaml — passed as dataDir. */
let fixtureDataDir: string

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-bench-test-'))
  fixtureDataDir = path.join(workDir, 'data')
  fs.mkdirSync(fixtureDataDir, { recursive: true })
  // JSON is a subset of YAML — js-yaml loads it fine, no dumper needed.
  fs.writeFileSync(
    path.join(fixtureDataDir, CORPUS_FILES['fixture']),
    JSON.stringify(VENDORED_SCENARIOS, null, 2),
  )
})

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('sampleScenarios', () => {
  it('returns N scenarios per category with a fixed seed (deterministic)', () => {
    const all = loadScenarios(undefined, 'fixture', fixtureDataDir)
    const sampleA = sampleScenarios(all, 2, 1337)
    const sampleB = sampleScenarios(all, 2, 1337)

    // Same seed → identical order and content.
    expect(sampleA.map(s => s.id)).toEqual(sampleB.map(s => s.id))

    // N per category.
    for (const cat of VENDORED_CATEGORIES) {
      const got = sampleA.filter(s => s.category === cat).length
      expect(got).toBe(2)
    }
  })

  it('different seeds produce different orderings (probabilistic, but deterministic)', () => {
    const all = loadScenarios(undefined, 'fixture', fixtureDataDir)
    // n=5 over a pool of 2/category → 30 seeded draws; two seeds colliding on
    // all of them is ~2^-30.
    const sampleA = sampleScenarios(all, 5, 1)
    const sampleB = sampleScenarios(all, 5, 2)
    expect(sampleA.map(s => s.id).join(',')).not.toBe(sampleB.map(s => s.id).join(','))
  })

  it('handles N larger than per-category count by sampling with replacement', () => {
    const all = loadScenarios(undefined, 'fixture', fixtureDataDir)
    // The vendored fixture has 2 per category; ask for 5. This must not crash.
    const sample = sampleScenarios(all, 5, 42)
    for (const cat of VENDORED_CATEGORIES) {
      const got = sample.filter(s => s.category === cat).length
      expect(got).toBe(5)
    }
  })
})

describe('corpus path resolution (#336)', () => {
  it('explicit dataDir wins and is exclusive (no fallback)', () => {
    expect(resolveCorpusPath('anything.yaml', '/explicit/dir')).toBe(path.join('/explicit/dir', 'anything.yaml'))
  })

  it('PLUR_BENCH_DATA_DIR env var overrides default resolution', () => {
    process.env.PLUR_BENCH_DATA_DIR = fixtureDataDir
    try {
      expect(resolveCorpusPath('scenarios.yaml')).toBe(path.join(fixtureDataDir, 'scenarios.yaml'))
      // End-to-end through the loader too.
      const scenarios = loadScenarios()
      expect(scenarios.length).toBe(VENDORED_SCENARIOS.length)
      expect(scenarios[0].id).toBe('vf-user-1')
    } finally {
      delete process.env.PLUR_BENCH_DATA_DIR
    }
  })

  it('falls back to a plur-bench checkout (corpus/monorepo/, then corpus/)', () => {
    const benchRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-bench-repo-'))
    try {
      fs.mkdirSync(path.join(benchRepo, 'corpus', 'monorepo'), { recursive: true })
      fs.writeFileSync(path.join(benchRepo, 'corpus', 'monorepo', 'only-in-monorepo.yaml'), '[]')
      fs.writeFileSync(path.join(benchRepo, 'corpus', 'only-in-corpus-root.yaml'), '[]')
      process.env.PLUR_BENCH_REPO = benchRepo

      // Neither file exists repo-locally → both resolve from the checkout.
      expect(resolveCorpusPath('only-in-monorepo.yaml'))
        .toBe(path.join(benchRepo, 'corpus', 'monorepo', 'only-in-monorepo.yaml'))
      expect(resolveCorpusPath('only-in-corpus-root.yaml'))
        .toBe(path.join(benchRepo, 'corpus', 'only-in-corpus-root.yaml'))
    } finally {
      delete process.env.PLUR_BENCH_REPO
      fs.rmSync(benchRepo, { recursive: true, force: true })
    }
  })

  it('returns the repo-local path when nothing resolves (canonical error location)', () => {
    const resolved = resolveCorpusPath('does-not-exist-anywhere.yaml')
    expect(resolved).toBe(path.join(__dirname, 'data', 'does-not-exist-anywhere.yaml'))
  })

  it('loadScenarios raises a plur-bench setup hint when a corpus file is missing', () => {
    // The vendored fixture dir only contains scenarios.yaml.
    expect(() => loadScenarios(undefined, 'longmemeval-s-smoke', fixtureDataDir))
      .toThrow(/plur-bench|--data-dir/)
  })
})

describe('corpus loader', () => {
  it('loads the vendored fixture corpus', () => {
    const fixture = loadScenarios(undefined, 'fixture', fixtureDataDir)
    expect(fixture.length).toBe(VENDORED_SCENARIOS.length)
    expect(new Set(fixture.map(s => s.category)).size).toBe(6)
    const implicitDefault = loadScenarios(undefined, undefined, fixtureDataDir)
    expect(implicitDefault.map(s => s.id)).toEqual(fixture.map(s => s.id))
  })

  // The tracked 30-scenario scenarios.yaml moved to plur-bench (#336). Dev
  // checkouts may still have it locally (gitignored) or resolve it from a
  // sibling plur-bench checkout; fresh clones (CI) skip this test.
  it.skipIf(!fs.existsSync(resolveCorpusPath('scenarios.yaml')))('resolves the 30-scenario fixture via default resolution when available', () => {
    const fixture = loadScenarios()
    expect(fixture.length).toBe(30)
    expect(new Set(fixture.map(s => s.category)).size).toBe(6)
  })

  // The longmemeval-s-smoke corpus (21k lines) lives in plur-bench, not this
  // repo (#336). Skip when it isn't resolvable locally (reproduce via
  // benchmark/scripts/import-longmemeval.ts or a plur-bench checkout).
  it.skipIf(!fs.existsSync(resolveCorpusPath(CORPUS_FILES['longmemeval-s-smoke'])))('loads the longmemeval-s-smoke corpus with the expected shape', () => {
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
    // The full corpus is not committed anywhere (~260 MB); skip if the
    // contributor hasn't run the importer.
    const fullPath = resolveCorpusPath(CORPUS_FILES['longmemeval-s'])
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
    if (fs.existsSync(resolveCorpusPath(CORPUS_FILES['longmemeval-s']))) {
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
      dataDir: fixtureDataDir,
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
      dataDir: fixtureDataDir,
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

  it('runs the full fixture set when no --iterations is passed (backward-compat)', async () => {
    const out = await runBenchmark({
      // No iterations → use full default scenario set (current behaviour).
      embedder: 'minilm',
      searchMode: 'bm25', // BM25 is faster; this is a smoke test.
      outputDir: workDir,
      dataDir: fixtureDataDir,
      quiet: true,
    })

    const j = JSON.parse(fs.readFileSync(out.jsonPath, 'utf-8'))
    // Default mode runs over the full fixture scenario set.
    expect(j.scenario_count).toBe(VENDORED_SCENARIOS.length)
    // Still emits the new headline keys (they are always present).
    expect(j).toHaveProperty('r5')
    expect(j).toHaveProperty('latency_p50_ms')
  }, 120000)

  it('PLUR_BENCH_RESULTS_DIR redirects output when no outputDir is given', async () => {
    const resultsDir = path.join(workDir, 'env-results')
    process.env.PLUR_BENCH_RESULTS_DIR = resultsDir
    try {
      const out = await runBenchmark({
        iterations: 1,
        embedder: 'minilm',
        searchMode: 'bm25',
        dataDir: fixtureDataDir,
        quiet: true,
        seed: 3,
      })
      expect(path.dirname(out.jsonPath)).toBe(resultsDir)
      expect(fs.existsSync(out.jsonPath)).toBe(true)
    } finally {
      delete process.env.PLUR_BENCH_RESULTS_DIR
    }
  }, 120000)

  // Skipped unless the smoke corpus is resolvable locally (#336 — it lives in plur-bench, not this repo).
  it.skipIf(!fs.existsSync(resolveCorpusPath(CORPUS_FILES['longmemeval-s-smoke'])))('runs over the longmemeval-s-smoke corpus end-to-end', async () => {
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
      dataDir: fixtureDataDir,
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

describe('reranker pre-flight probe (#341)', () => {
  it('aborts with a descriptive error when --rerank on and the reranker fails to load', async () => {
    // Spy on getReranker and return a broken adapter (simulates corrupt model cache).
    const spy = vi.spyOn(rerankers, 'getReranker').mockReturnValue({
      name: 'bge-reranker-v2-m3',
      modelId: 'mock-broken',
      score: async () => { throw new Error('model load failed: corrupt cache') },
      scoreBatch: async () => { throw new Error('model load failed: corrupt cache') },
    })

    try {
      await expect(
        runBenchmark({ iterations: 1, searchMode: 'bm25', rerank: 'on', outputDir: workDir, dataDir: fixtureDataDir, quiet: true }),
      ).rejects.toThrow('Reranker pre-flight failed')
    } finally {
      spy.mockRestore()
    }
  }, 30000)
})
