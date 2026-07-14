import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

describe('hybrid search (BM25 + embeddings via RRF)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-hybrid-'))
    plur = new Plur({ path: dir })
    // Seed engrams with varied content
    plur.learn('The capital of France is Paris', { type: 'terminological' })
    plur.learn('TypeScript strict mode catches null errors at compile time', { type: 'behavioral' })
    plur.learn('User prefers dark theme for all code editors', { type: 'behavioral' })
    plur.learn('We decided to use PostgreSQL for the main database', { type: 'architectural' })
    plur.learn('The REST API returns JSON responses with snake_case keys', { type: 'behavioral' })
    plur.learn('Python is used for data analysis and ML scripts', { type: 'procedural' })
    plur.learn('Deploy to production requires two senior approvals', { type: 'procedural' })
    plur.learn('The French language is beautiful and widely spoken in Europe', { type: 'terminological' })
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
    const before = plur.recall('France')[0]?.activation.frequency ?? 0
    await plur.recallHybrid('France')
    const after = plur.recall('France')[0]?.activation.frequency ?? 0
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
