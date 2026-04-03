import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { installPack, listPacks, exportPack } from '../src/packs.js'
import { EngramSchema } from '../src/schemas/engram.js'
import { Plur } from '../src/index.js'

describe('pack management', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-packs-'))
    mkdirSync(join(dir, 'packs'))
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('installs a pack from a directory', () => {
    const packDir = join(dir, 'test-pack')
    mkdirSync(packDir)
    writeFileSync(join(packDir, 'SKILL.md'), '---\nname: test-pack\nversion: "1.0"\nx-datacore:\n  id: test\n  injection_policy: on_match\n  engram_count: 1\n---\n')
    writeFileSync(join(packDir, 'engrams.yaml'), 'engrams:\n  - id: ENG-2026-0101-001\n    statement: test pattern\n    type: behavioral\n    scope: global\n    status: active\n    version: 2\n    activation:\n      retrieval_strength: 0.7\n      storage_strength: 1.0\n      frequency: 0\n      last_accessed: "2026-01-01"\n')
    const result = installPack(join(dir, 'packs'), packDir)
    expect(result.installed).toBe(1)
  })

  it('lists installed packs', () => {
    const packs = listPacks(join(dir, 'packs'))
    expect(Array.isArray(packs)).toBe(true)
  })

  it('exports engrams as a pack', () => {
    const engram = EngramSchema.parse({
      id: 'ENG-2026-0319-001',
      statement: 'Test engram',
      type: 'behavioral',
      scope: 'global',
      status: 'active',
      visibility: 'public',
    })
    const outputDir = join(dir, 'exported-pack')
    const result = exportPack([engram], outputDir, {
      name: 'my-export',
      version: '1.0.0',
      description: 'Test export',
    })
    expect(result.engram_count).toBe(1)

    // Verify it can be re-imported
    const installResult = installPack(join(dir, 'packs'), outputDir)
    expect(installResult.installed).toBe(1)
  })

  it('installed pack engrams are findable via recall (issue #13)', () => {
    // Set up a Plur instance with a temp directory
    const plurDir = mkdtempSync(join(tmpdir(), 'plur-recall-'))
    mkdirSync(join(plurDir, 'packs'), { recursive: true })
    writeFileSync(join(plurDir, 'engrams.yaml'), 'engrams: []\n')
    const plur = new Plur({ path: plurDir })

    // Create and install a pack with a stoicism engram
    const packSource = join(plurDir, 'stoicism-source')
    mkdirSync(packSource)
    writeFileSync(join(packSource, 'SKILL.md'), '---\nname: stoicism-applied\nversion: "1.0"\n---\n')
    writeFileSync(join(packSource, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0101-001
    statement: Stoic communication is not suppression of emotion but strategic channeling of response
    type: behavioral
    scope: global
    status: active
    version: 2
    domain: philosophy.stoicism
    tags: [stoicism, communication]
    activation:
      retrieval_strength: 0.7
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-01-01"
`)
    plur.installPack(packSource)

    // Debug: check list and status
    const allEngrams = plur.list()
    console.log('All engrams via list():', allEngrams.length, allEngrams.map(e => e.id))
    const status = plur.status()
    console.log('Status engram_count:', status.engram_count, 'pack_count:', status.pack_count)

    // Recall should find the pack engram
    const results = plur.recall('stoicism philosophy communication')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].statement).toContain('Stoic communication')

    // Status should count the pack engram
    expect(status.engram_count).toBeGreaterThanOrEqual(1)
    expect(status.pack_count).toBe(1)

    rmSync(plurDir, { recursive: true })
  })
})
