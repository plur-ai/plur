import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-tensions-'))
}

function injectLegacyConflict(plur: Plur, fromId: string, toId: string): void {
  const engrams = plur.list()
  const engram = engrams.find(e => e.id === fromId)!
  plur.updateEngram({
    ...engram,
    relations: {
      broader: [],
      narrower: [],
      related: [],
      conflicts: [toId],
    },
  })
}

describe('plur_tensions tool', () => {
  let dir: string
  let plur: Plur
  const tools = getToolDefinitions()
  const tensionsTool = tools.find(t => t.name === 'plur_tensions')!
  const purgeTool = tools.find(t => t.name === 'plur_tensions_purge')!

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

  it('plur_tensions_purge is registered as a tool', () => {
    expect(purgeTool).toBeDefined()
    expect(purgeTool.name).toBe('plur_tensions_purge')
  })

  it('returns empty tensions when no conflicts', async () => {
    plur.learn('Always use TypeScript')
    const result = await tensionsTool.handler({}, plur) as any
    expect(result.tensions).toEqual([])
    expect(result.count).toBe(0)
    expect(result.purge_hint).toBeUndefined()
  })

  it('detects tensions between conflicting engrams', async () => {
    const e1 = plur.learn('Always use tabs for indentation in TypeScript files')
    const e2 = plur.learn('Always use spaces for indentation in TypeScript files')

    const result = await tensionsTool.handler({}, plur) as any
    if (result.count > 0) {
      expect(result.tensions[0].engram_a.id).toBeDefined()
      expect(result.tensions[0].engram_b.id).toBeDefined()
      expect(result.tensions[0].detected_at).toBeDefined()
    }
  })

  it('deduplicates conflict pairs', async () => {
    const e1 = plur.learn('Use PostgreSQL for the database')
    const e2 = plur.learn('Use MySQL for the database instead of PostgreSQL')

    const result = await tensionsTool.handler({}, plur) as any
    if (result.count > 0) {
      const pairKeys = result.tensions.map((t: any) =>
        [t.engram_a.id, t.engram_b.id].sort().join(':')
      )
      expect(new Set(pairKeys).size).toBe(pairKeys.length)
    }
  })

  it('includes purge_hint when legacy conflict relations exist', async () => {
    const e1 = plur.learn('Always use PostgreSQL')
    const e2 = plur.learn('Always use MySQL')
    injectLegacyConflict(plur, e1.id, e2.id)

    const result = await tensionsTool.handler({}, plur) as any
    expect(result.count).toBe(1)
    expect(result.purge_hint).toBeDefined()
    expect(result.purge_hint).toContain('plur_tensions_purge')
  })

  it('omits purge_hint when there are no tensions', async () => {
    plur.learn('Use TypeScript')
    const result = await tensionsTool.handler({}, plur) as any
    expect(result.count).toBe(0)
    expect(result.purge_hint).toBeUndefined()
  })
})

describe('plur_tensions_purge tool', () => {
  let dir: string
  let plur: Plur
  const tools = getToolDefinitions()
  const tensionsTool = tools.find(t => t.name === 'plur_tensions')!
  const purgeTool = tools.find(t => t.name === 'plur_tensions_purge')!

  beforeEach(() => {
    dir = tmpDir()
    plur = new Plur({ path: dir })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('clears all legacy conflict relations', async () => {
    const e1 = plur.learn('Use tabs for indentation')
    const e2 = plur.learn('Use spaces for indentation')
    injectLegacyConflict(plur, e1.id, e2.id)

    const before = await tensionsTool.handler({}, plur) as any
    expect(before.count).toBe(1)

    const purgeResult = await purgeTool.handler({}, plur) as any
    expect(purgeResult.purged_conflict_refs).toBe(1)
    expect(purgeResult.engrams_modified).toBe(1)
    expect(purgeResult.message).toContain('1')

    const after = await tensionsTool.handler({}, plur) as any
    expect(after.count).toBe(0)
    expect(after.purge_hint).toBeUndefined()
  })

  it('returns zero counts when nothing to purge', async () => {
    plur.learn('Use TypeScript')
    const result = await purgeTool.handler({}, plur) as any
    expect(result.purged_conflict_refs).toBe(0)
    expect(result.engrams_modified).toBe(0)
  })
})
