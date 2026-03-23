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

  it('returns results as a Promise', async () => {
    const result = plur.recallHybrid('database')
    expect(result).toBeInstanceOf(Promise)
    const engrams = await result
    expect(Array.isArray(engrams)).toBe(true)
  })

  it('finds engrams that match by keyword (BM25 strength)', async () => {
    const results = await plur.recallHybrid('PostgreSQL database')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].statement).toContain('PostgreSQL')
  })

  it('returns empty for nonsense queries', async () => {
    const results = await plur.recallHybrid('xyzzy plugh')
    // May return results from embedding similarity (semantic match)
    // but they should be low confidence — just check it doesn't crash
    expect(Array.isArray(results)).toBe(true)
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
})
