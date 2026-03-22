import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import type { LlmFunction } from '../src/types.js'

describe('agentic search', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-agentic-'))
    plur = new Plur({ path: dir })
    // Seed some engrams
    plur.learn('The capital of France is Paris', { type: 'terminological' })
    plur.learn('TypeScript strict mode catches null errors', { type: 'behavioral' })
    plur.learn('User prefers dark theme for all editors', { type: 'behavioral' })
    plur.learn('We decided to use PostgreSQL for the database', { type: 'architectural' })
    plur.learn('The API returns XML not JSON', { type: 'behavioral' })
    plur.learn('Meeting scheduled for Friday at 3pm', { type: 'behavioral' })
    plur.learn('Python is used for data analysis scripts', { type: 'procedural' })
    plur.learn('Deploy to production requires two approvals', { type: 'procedural' })
  })

  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('returns Promise in agentic mode', async () => {
    const mockLlm: LlmFunction = async (prompt) => {
      // Simulate LLM selecting first item from whatever BM25 returns
      return '1'
    }

    const result = plur.recallAsync('database', { llm: mockLlm, limit: 5 })
    expect(result).toBeInstanceOf(Promise)
    const engrams = await result
    expect(engrams.length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to BM25 results when LLM fails', async () => {
    const failingLlm: LlmFunction = async () => {
      throw new Error('LLM unavailable')
    }

    const result = await plur.recallAsync('database', { llm: failingLlm, limit: 5 })
    // Should fall back to BM25 results, not crash
    expect(Array.isArray(result)).toBe(true)
  })

  it('handles "none" response from LLM', async () => {
    const noneLlm: LlmFunction = async () => 'none'

    const result = await plur.recallAsync('quantum physics', { llm: noneLlm, limit: 5 })
    expect(result).toHaveLength(0)
  })

  it('returns sync results in fast mode (default)', () => {
    const result = plur.recall('database')
    // Fast mode returns synchronously
    expect(Array.isArray(result)).toBe(true)
    expect(result).not.toBeInstanceOf(Promise)
  })

  it('reactivates engrams in agentic mode', async () => {
    const mockLlm: LlmFunction = async () => '1'

    const before = plur.recall('France')[0]?.activation.frequency ?? 0
    await plur.recallAsync('France', { llm: mockLlm, limit: 5 })
    const after = plur.recall('France')[0]?.activation.frequency ?? 0
    expect(after).toBeGreaterThan(before)
  })
})
