import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'plur-purge-'))
}

function writeEngrams(path: string, engrams: any[]): void {
  mkdirSync(join(path, '..').replace(/\/\.\.$/, ''), { recursive: true })
  writeFileSync(path, yaml.dump({ engrams }), 'utf8')
}

function readEngrams(path: string): any[] {
  const raw = readFileSync(path, 'utf8')
  const data = yaml.load(raw) as any
  return data?.engrams ?? []
}

function makeEngram(id: string, conflicts: string[] = []): any {
  return {
    id,
    version: 2,
    status: 'active',
    consolidated: false,
    type: 'behavioral',
    scope: 'global',
    visibility: 'private',
    statement: `Test engram ${id}`,
    activation: {
      retrieval_strength: 0.7,
      storage_strength: 1,
      frequency: 0,
      last_accessed: '2026-05-15',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'apply' },
    knowledge_anchors: [],
    associations: [],
    derivation_count: 1,
    tags: [],
    content_hash: id,
    commitment: 'leaning',
    engram_version: 1,
    episode_ids: [],
    relations: conflicts.length > 0 ? { conflicts } : undefined,
  }
}

describe('purgeTensions', () => {
  let dir: string

  beforeEach(() => {
    dir = newDir()
    mkdirSync(join(dir, 'packs'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('clears conflicts from primary store', async () => {
    const engramsPath = join(dir, 'engrams.yaml')
    writeEngrams(engramsPath, [
      makeEngram('ENG-001', ['ENG-002', 'ENG-003']),
      makeEngram('ENG-002', ['ENG-001']),
      makeEngram('ENG-003'),
    ])

    const { Plur } = await import('../src/index.js')
    const plur = new Plur({ path: dir })

    // Auto-purge should have already run in constructor
    const engrams = readEngrams(engramsPath)
    const withConflicts = engrams.filter((e: any) => e.relations?.conflicts?.length > 0)
    expect(withConflicts).toHaveLength(0)
  })

  it('clears conflicts from project-scoped stores', async () => {
    // Primary store — no conflicts
    const primaryPath = join(dir, 'engrams.yaml')
    writeEngrams(primaryPath, [makeEngram('ENG-001')])

    // Project store — has conflicts
    const projectDir = join(dir, 'project-store')
    mkdirSync(projectDir, { recursive: true })
    const projectPath = join(projectDir, 'engrams.yaml')
    writeEngrams(projectPath, [
      makeEngram('ENG-PPL-001', ['ENG-001', 'ENG-PPL-002']),
      makeEngram('ENG-PPL-002', ['ENG-PPL-001']),
    ])

    // Config with project store
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ scope: 'project:test', path: projectPath }],
    }), 'utf8')

    const { Plur } = await import('../src/index.js')
    const plur = new Plur({ path: dir })

    // Verify project store was cleaned
    const projectEngrams = readEngrams(projectPath)
    const withConflicts = projectEngrams.filter((e: any) => e.relations?.conflicts?.length > 0)
    expect(withConflicts).toHaveLength(0)
  })

  it('tension_count reaches 0 after purge', async () => {
    const engramsPath = join(dir, 'engrams.yaml')
    writeEngrams(engramsPath, [
      makeEngram('ENG-001', ['ENG-002']),
      makeEngram('ENG-002', ['ENG-001']),
    ])

    const { Plur } = await import('../src/index.js')
    const plur = new Plur({ path: dir })
    const status = plur.status()
    expect(status.tension_count).toBe(0)
  })

  it('creates sentinel file after auto-purge', async () => {
    const engramsPath = join(dir, 'engrams.yaml')
    writeEngrams(engramsPath, [makeEngram('ENG-001', ['ENG-002'])])

    const { Plur } = await import('../src/index.js')
    new Plur({ path: dir })

    expect(existsSync(join(dir, '.tensions-purged'))).toBe(true)
  })

  it('skips auto-purge when sentinel exists', async () => {
    const engramsPath = join(dir, 'engrams.yaml')
    writeEngrams(engramsPath, [
      makeEngram('ENG-001', ['ENG-002']),
      makeEngram('ENG-002', ['ENG-001']),
    ])

    // Create sentinel BEFORE constructing Plur
    writeFileSync(join(dir, '.tensions-purged'), '2026-05-15T00:00:00Z\n', 'utf8')

    const { Plur } = await import('../src/index.js')
    const plur = new Plur({ path: dir })

    // Conflicts should still be there (purge was skipped)
    const engrams = readEngrams(engramsPath)
    const withConflicts = engrams.filter((e: any) => e.relations?.conflicts?.length > 0)
    expect(withConflicts).toHaveLength(2)
  })

  it('preserves engram content after purge (only conflicts cleared)', async () => {
    const engramsPath = join(dir, 'engrams.yaml')
    writeEngrams(engramsPath, [
      makeEngram('ENG-001', ['ENG-002']),
    ])

    const { Plur } = await import('../src/index.js')
    const plur = new Plur({ path: dir })

    const engrams = readEngrams(engramsPath)
    expect(engrams[0].id).toBe('ENG-001')
    expect(engrams[0].statement).toBe('Test engram ENG-001')
    expect(engrams[0].type).toBe('behavioral')
    expect(engrams[0].status).toBe('active')
  })

  it('manual purgeTensions returns correct counts', async () => {
    const engramsPath = join(dir, 'engrams.yaml')
    writeEngrams(engramsPath, [
      makeEngram('ENG-001', ['ENG-002', 'ENG-003']),
      makeEngram('ENG-002', ['ENG-001']),
      makeEngram('ENG-003'),
    ])

    // Delete sentinel so auto-purge doesn't interfere
    // (constructor will auto-purge, so we test via fresh call)
    const { Plur } = await import('../src/index.js')

    // Create sentinel to skip auto-purge
    writeFileSync(join(dir, '.tensions-purged'), 'skip\n', 'utf8')
    const plur = new Plur({ path: dir })

    // Remove sentinel and re-purge manually
    rmSync(join(dir, '.tensions-purged'))
    const result = plur.purgeTensions()
    expect(result.purged_count).toBe(3) // ENG-001 has 2 + ENG-002 has 1
    expect(result.engrams_modified).toBe(2) // ENG-001 and ENG-002
    expect(result.stores_cleaned).toBe(1) // primary store
  })

  it('skips remote stores (cannot write)', async () => {
    const engramsPath = join(dir, 'engrams.yaml')
    writeEngrams(engramsPath, [makeEngram('ENG-001')])

    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ scope: 'group:test', url: 'https://plur.example.com', token: 'fake' }],
    }), 'utf8')

    const { Plur } = await import('../src/index.js')
    // Should not throw trying to write to remote store
    const plur = new Plur({ path: dir })
    const result = plur.purgeTensions()
    expect(result.stores_cleaned).toBe(0)
  })
})
