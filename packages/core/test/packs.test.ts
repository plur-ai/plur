import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { installPack, listPacks, exportPack } from '../src/packs.js'
import { EngramSchema } from '../src/schemas/engram.js'

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
})
