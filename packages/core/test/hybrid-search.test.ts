import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { setEmbeddingsEnabled } from '../src/embeddings.js'

describe('hybrid search (BM25 + embeddings via RRF)', () => {
  let dir: string
  let plur: Plur

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-hybrid-'))
    plur = new Plur({ path: dir })
    // Seed engrams with varied content
    await plur.learn('The capital of France is Paris', { type: 'terminological' })
    await plur.learn('TypeScript strict mode catches null errors at compile time', { type: 'behavioral' })
    await plur.learn('User prefers dark theme for all code editors', { type: 'behavioral' })
    await plur.learn('We decided to use PostgreSQL for the main database', { type: 'architectural' })
    await plur.learn('The REST API returns JSON responses with snake_case keys', { type: 'behavioral' })
    await plur.learn('Python is used for data analysis and ML scripts', { type: 'procedural' })
    await plur.learn('Deploy to production requires two senior approvals', { type: 'procedural' })
    await plur.learn('The French language is beautiful and widely spoken in Europe', { type: 'terminological' })
  })

  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('resolves to relevance-ranked engrams — a keyword query top-ranks its match', async () => {
    // Was a tautology (toBeInstanceOf(Promise) + Array.isArray, true for any
    // async fn). The real contract: awaiting yields ranked engrams and the one
    // strong keyword hit sorts to the top.
    const results = await plur.recallHybrid('database')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].statement).toContain('database')
  })

  it('finds engrams that match by keyword (BM25 strength)', async () => {
    const results = await plur.recallHybrid('PostgreSQL database')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].statement).toContain('PostgreSQL')
  })

  it('scores a genuine-nonsense query below a real keyword hit (miss signal)', async () => {
    // "returns empty for nonsense" was never the contract — recallHybrid does
    // not hard-filter, so a nonsense query still returns ranked engrams via
    // embedding similarity. The real signal a caller thresholds on is topScore:
    // a query with no keyword match cannot outscore a genuine keyword hit.
    const hit = await plur.recallHybridWithMeta('PostgreSQL database')
    const miss = await plur.recallHybridWithMeta('xyzzy plugh')
    expect(hit.topScore).not.toBeNull()
    if (miss.topScore === null) {
      expect(miss.engrams).toHaveLength(0)
    } else {
      expect(miss.topScore as number).toBeLessThan(hit.topScore as number)
    }
  })

  it('respects limit parameter', async () => {
    const results = await plur.recallHybrid('code', { limit: 3 })
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('reactivates returned engrams', async () => {
    const before = (await plur.recall('France'))[0]?.activation.frequency ?? 0
    await plur.recallHybrid('France')
    const after = (await plur.recall('France'))[0]?.activation.frequency ?? 0
    expect(after).toBeGreaterThan(before)
  })

  it('merges results from both BM25 and semantic — no duplicates', async () => {
    const results = await plur.recallHybrid('France Paris', { limit: 10 })
    const ids = results.map(r => r.id)
    const unique = new Set(ids)
    expect(ids.length).toBe(unique.size) // No duplicates
  })

  it('surfaces a numeric topScore on a hit (for the miss-signal threshold)', async () => {
    const meta = await plur.recallHybridWithMeta('PostgreSQL database')
    expect(meta.engrams.length).toBeGreaterThanOrEqual(1)
    expect(typeof meta.topScore).toBe('number')
    expect(meta.topScore as number).toBeGreaterThan(0)
  })

  it('topScore is null when no engrams exist at all', async () => {
    const empty = new Plur({ path: mkdtempSync(join(tmpdir(), 'plur-empty-')) })
    const meta = await empty.recallHybridWithMeta('anything')
    expect(meta.engrams).toHaveLength(0)
    expect(meta.topScore).toBeNull()
  })
})

describe('hybrid search limit — 50-floor regression (#770)', () => {
  // The internal over-fetch floors (Math.max(limit * 3, 50) for the reranker
  // path, Math.max(limit, 50) for aggregation queries) must not leak through
  // as the returned count. These tests seed >50 engrams so the floor kicks in,
  // then verify the caller's limit is the ceiling on what comes back.
  //
  // Embeddings are disabled: this is a COUNT correctness test. BM25-only is
  // fast and exercises the same limit-enforcement code path.
  // recallHybridWithMeta is called directly because the MCP layer calls it
  // directly (bypassing the outer slice guard in recallHybrid).
  let dir: string
  let plur: Plur

  beforeAll(async () => {
    setEmbeddingsEnabled(false, 'limit regression test — BM25-only for speed')
    dir = mkdtempSync(join(tmpdir(), 'plur-limit-floor-'))
    plur = new Plur({ path: dir })
    const topics = [
      'cats', 'dogs', 'fish', 'birds', 'rabbits', 'hamsters', 'turtles', 'snakes',
      'lions', 'tigers', 'bears', 'wolves', 'foxes', 'deer', 'moose', 'elk',
      'Python', 'TypeScript', 'Rust', 'Go', 'Java', 'C++', 'Ruby', 'Swift',
      'React', 'Vue', 'Angular', 'Svelte', 'Next.js', 'Remix', 'Astro', 'Nuxt',
      'PostgreSQL', 'MySQL', 'SQLite', 'MongoDB', 'Redis', 'Cassandra', 'DynamoDB',
      'AWS', 'GCP', 'Azure', 'Vercel', 'Netlify', 'Heroku', 'Render', 'Fly.io',
      'Docker', 'Kubernetes', 'Terraform', 'Ansible', 'GitHub', 'GitLab', 'Bitbucket',
    ]
    for (const topic of topics) {
      await plur.learn(`${topic} is a popular technology used by developers worldwide`, { type: 'terminological' })
    }
  }, 120_000)

  afterAll(() => {
    setEmbeddingsEnabled(true)
    rmSync(dir, { recursive: true })
  })

  it('recallHybrid with limit:5 returns ≤5 even with >50 engrams seeded', async () => {
    const results = await plur.recallHybrid('technology developers', { limit: 5 })
    expect(results.length).toBeLessThanOrEqual(5)
  })

  it('recallHybrid aggregation query with limit:5 returns ≤5 — effectiveLimit 50-floor must not leak', async () => {
    const results = await plur.recallHybrid('all the technologies used by developers', { limit: 5 })
    expect(results.length).toBeLessThanOrEqual(5)
  })

  it('recallHybridWithMeta with limit:5 returns ≤5 — MCP tool calls this directly', async () => {
    const meta = await plur.recallHybridWithMeta('technology developers', { limit: 5 })
    expect(meta.engrams.length).toBeLessThanOrEqual(5)
  })

  it('recallHybridWithMeta aggregation query with limit:5 returns ≤5', async () => {
    const meta = await plur.recallHybridWithMeta('all the technologies used by developers', { limit: 5 })
    expect(meta.engrams.length).toBeLessThanOrEqual(5)
  })
})
