import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import type { LlmFunction } from '../src/types.js'

describe('expanded search (query expansion + hybrid + RRF)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-expanded-'))
    plur = new Plur({ path: dir })
    plur.learn('The capital of France is Paris', { type: 'terminological' })
    plur.learn('TypeScript strict mode catches null errors', { type: 'behavioral' })
    plur.learn('User prefers dark theme for all editors', { type: 'behavioral' })
    plur.learn('We decided to use PostgreSQL for the database', { type: 'architectural' })
    plur.learn('The API returns XML not JSON', { type: 'behavioral' })
    plur.learn('Deploy to production requires two approvals', { type: 'procedural' })
  })

  afterEach(() => { rmSync(dir, { recursive: true }) })

  const mockLlm: LlmFunction = async (prompt) => {
    // Simulate query expansion — return 3 variants
    if (prompt.includes('database')) {
      return 'SQL data store\nPostgreSQL relational database\ndata persistence layer'
    }
    if (prompt.includes('France')) {
      return 'Paris French capital\nFrench Republic\nEuropean country France'
    }
    return 'variant one\nvariant two\nvariant three'
  }

  it('returns results with expanded queries', async () => {
    const results = await plur.recallExpanded('database', { llm: mockLlm, limit: 5 })
    expect(results.length).toBeGreaterThanOrEqual(1)
    // Should find PostgreSQL via the expanded variant
    expect(results.some(r => r.statement.includes('PostgreSQL'))).toBe(true)
  }, 30_000)

  it('falls back to original query when LLM fails', async () => {
    const failingLlm: LlmFunction = async () => {
      throw new Error('LLM unavailable')
    }
    const results = await plur.recallExpanded('database', { llm: failingLlm, limit: 5 })
    // Should still return results from the original query
    expect(Array.isArray(results)).toBe(true)
  })

  it('respects limit parameter', async () => {
    const results = await plur.recallExpanded('database', { llm: mockLlm, limit: 2 })
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('reactivates returned engrams', async () => {
    const before = plur.recall('France')[0]?.activation.frequency ?? 0
    await plur.recallExpanded('France', { llm: mockLlm, limit: 5 })
    const after = plur.recall('France')[0]?.activation.frequency ?? 0
    expect(after).toBeGreaterThan(before)
  })

  it('produces no duplicates in merged results', async () => {
    const results = await plur.recallExpanded('database', { llm: mockLlm, limit: 10 })
    const ids = results.map(r => r.id)
    expect(ids.length).toBe(new Set(ids).size)
  })
})
