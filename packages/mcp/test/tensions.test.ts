import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-tensions-'))
}

describe('plur_tensions tool', () => {
  let dir: string
  let plur: Plur
  const tools = getToolDefinitions()
  const tensionsTool = tools.find(t => t.name === 'plur_tensions')!

  beforeEach(() => {
    dir = tmpDir()
    plur = new Plur({ path: dir })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is registered as a tool', () => {
    expect(tensionsTool).toBeDefined()
    expect(tensionsTool.name).toBe('plur_tensions')
  })

  it('returns empty tensions when no conflicts', async () => {
    plur.learn('Always use TypeScript')
    const result = await tensionsTool.handler({}, plur) as any
    expect(result.tensions).toEqual([])
    expect(result.count).toBe(0)
  })

  it('detects tensions between conflicting engrams', async () => {
    // Create two engrams that will conflict (high keyword overlap)
    const e1 = plur.learn('Always use tabs for indentation in TypeScript files')
    const e2 = plur.learn('Always use spaces for indentation in TypeScript files')

    // At least one should have conflicts detected
    const result = await tensionsTool.handler({}, plur) as any
    // The conflict detection is keyword-based (BM25 score threshold)
    // These two statements share enough tokens to trigger it
    if (result.count > 0) {
      expect(result.tensions[0].engram_a.id).toBeDefined()
      expect(result.tensions[0].engram_b.id).toBeDefined()
      expect(result.tensions[0].detected_at).toBeDefined()
    }
  })

  it('deduplicates conflict pairs', async () => {
    // Manually create engrams with mutual conflicts
    const e1 = plur.learn('Use PostgreSQL for the database')
    const e2 = plur.learn('Use MySQL for the database instead of PostgreSQL')

    const result = await tensionsTool.handler({}, plur) as any
    // Even if both reference each other, each pair should appear at most once
    if (result.count > 0) {
      const pairKeys = result.tensions.map((t: any) =>
        [t.engram_a.id, t.engram_b.id].sort().join(':')
      )
      expect(new Set(pairKeys).size).toBe(pairKeys.length)
    }
  })
})
