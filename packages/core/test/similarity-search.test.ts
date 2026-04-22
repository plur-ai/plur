import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import type { SimilarityResult } from '../src/index.js'

describe('similaritySearch (embedding search with cosine scores)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-similarity-'))
    plur = new Plur({ path: dir })
    plur.learn('The capital of France is Paris', { type: 'terminological' })
    plur.learn('TypeScript strict mode catches null errors at compile time', { type: 'behavioral' })
    plur.learn('User prefers dark theme for all code editors', { type: 'behavioral' })
    plur.learn('Deploy to production requires two senior approvals', { type: 'procedural' })
  })

  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('returns {engram, score}[] with scores in [0, 1]', async () => {
    const results: SimilarityResult[] = await plur.similaritySearch('France Paris')
    expect(Array.isArray(results)).toBe(true)
    // If embeddings are available, we get scored results
    // If not (CI without model), we get an empty array — both are valid
    for (const r of results) {
      expect(r).toHaveProperty('engram')
      expect(r).toHaveProperty('score')
      expect(typeof r.score).toBe('number')
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(1)
      expect(r.engram).toHaveProperty('id')
      expect(r.engram).toHaveProperty('statement')
    }
  })

  it('results are sorted by score descending', async () => {
    const results = await plur.similaritySearch('TypeScript compiler errors')
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
    }
  })

  it('returns empty array for empty store', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'plur-similarity-empty-'))
    const emptyPlur = new Plur({ path: emptyDir })
    const results = await emptyPlur.similaritySearch('anything')
    expect(results).toEqual([])
    rmSync(emptyDir, { recursive: true })
  })

  it('respects limit parameter', async () => {
    const results = await plur.similaritySearch('code', { limit: 2 })
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('filters by scope when provided', async () => {
    // Add a scoped engram
    plur.learn('Python uses indentation for blocks', { type: 'behavioral', scope: 'project:alpha' })
    const results = await plur.similaritySearch('Python indentation', { scope: 'project:alpha' })
    // All returned engrams should be either global or matching scope (scope filter includes global)
    for (const r of results) {
      expect(
        r.engram.scope === 'global' || r.engram.scope === 'project:alpha' || r.engram.scope.startsWith('project:alpha')
      ).toBe(true)
    }
  })

  it('filters by domain when provided', async () => {
    plur.learn('Redis is used for caching', { type: 'architectural', domain: 'infrastructure' })
    const results = await plur.similaritySearch('caching', { domain: 'infrastructure' })
    for (const r of results) {
      expect(r.engram.domain).toMatch(/^infrastructure/)
    }
  })
})
