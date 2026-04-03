import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { installPack, uninstallPack, listPacks, exportPack, previewPack } from '../src/packs.js'
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

    // Recall should find the pack engram
    const results = plur.recall('stoicism philosophy communication')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].statement).toContain('Stoic communication')

    // Status should count the pack engram
    const status = plur.status()
    expect(status.engram_count).toBeGreaterThanOrEqual(1)
    expect(status.pack_count).toBe(1)

    rmSync(plurDir, { recursive: true })
  })

  it('preview shows manifest, engrams, and security scan', () => {
    const packDir = join(dir, 'preview-pack')
    mkdirSync(packDir)
    writeFileSync(join(packDir, 'SKILL.md'), '---\nname: preview-test\nversion: "2.0"\ncreator: tester\ndescription: A test pack\n---\n')
    writeFileSync(join(packDir, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0101-001
    statement: Always use descriptive variable names
    type: behavioral
    scope: global
    status: active
    visibility: public
    version: 2
    domain: coding.style
    tags: [coding, naming]
    activation:
      retrieval_strength: 0.7
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-01-01"
  - id: ENG-2026-0101-002
    statement: Prefer composition over inheritance in TypeScript
    type: architectural
    scope: global
    status: active
    visibility: public
    version: 2
    domain: coding.patterns
    tags: [typescript, patterns]
    activation:
      retrieval_strength: 0.7
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-01-01"
`)
    const preview = previewPack(packDir)
    expect(preview.manifest.name).toBe('preview-test')
    expect(preview.manifest.version).toBe('2.0')
    expect(preview.manifest.creator).toBe('tester')
    expect(preview.engram_count).toBe(2)
    expect(preview.engrams).toHaveLength(2)
    expect(preview.engrams[0].statement).toContain('descriptive variable')
    expect(preview.engrams[0].domain).toBe('coding.style')
    expect(preview.engrams[0].tags).toContain('coding')
    expect(preview.security.clean).toBe(true)
    // Global scope engrams trigger a warning (expected)
    expect(preview.warnings.some(w => w.includes('global scope'))).toBe(true)
  })

  it('preview flags security issues', () => {
    const packDir = join(dir, 'sketchy-pack')
    mkdirSync(packDir)
    writeFileSync(join(packDir, 'SKILL.md'), '---\nname: sketchy\nversion: "1.0"\n---\n')
    writeFileSync(join(packDir, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0101-001
    statement: Set api_key = AKIA1234567890ABCDEF for AWS authentication
    type: procedural
    scope: global
    status: active
    version: 2
    visibility: public
    activation:
      retrieval_strength: 0.7
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-01-01"
`)
    const preview = previewPack(packDir)
    expect(preview.security.clean).toBe(false)
    expect(preview.security.issues.some(i => i.type === 'secret')).toBe(true)
  })

  it('install blocks packs containing secrets', () => {
    const packDir = join(dir, 'secret-pack')
    mkdirSync(packDir)
    writeFileSync(join(packDir, 'SKILL.md'), '---\nname: secret-pack\nversion: "1.0"\n---\n')
    writeFileSync(join(packDir, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0101-001
    statement: Deploy with key AKIA1234567890ABCDEF to production
    type: procedural
    scope: global
    status: active
    version: 2
    visibility: public
    activation:
      retrieval_strength: 0.7
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-01-01"
`)
    expect(() => installPack(join(dir, 'packs'), packDir)).toThrow(/secrets/)
  })

  it('install records registry entry with metadata', () => {
    const packDir = join(dir, 'registry-pack')
    mkdirSync(packDir)
    writeFileSync(join(packDir, 'SKILL.md'), '---\nname: registry-test\nversion: "1.0"\ncreator: alice\n---\n')
    writeFileSync(join(packDir, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0101-001
    statement: Test registry tracking
    type: behavioral
    scope: global
    status: active
    version: 2
    activation:
      retrieval_strength: 0.7
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-01-01"
`)
    const result = installPack(join(dir, 'packs'), packDir)
    expect(result.registry).toBeDefined()
    expect(result.registry.name).toBe('registry-test')
    expect(result.registry.version).toBe('1.0')
    expect(result.registry.creator).toBe('alice')
    expect(result.registry.installed_at).toBeTruthy()
    expect(result.registry.source).toContain('registry-pack')
    expect(result.registry.integrity).toMatch(/^sha256:/)

    // Registry file should exist
    const registryFile = join(dir, 'packs', 'registry.yaml')
    expect(existsSync(registryFile)).toBe(true)
  })

  it('listPacks includes registry metadata', () => {
    const packDir = join(dir, 'listed-pack')
    mkdirSync(packDir)
    writeFileSync(join(packDir, 'SKILL.md'), '---\nname: listed-test\nversion: "1.0"\n---\n')
    writeFileSync(join(packDir, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0101-001
    statement: Test listing
    type: behavioral
    scope: global
    status: active
    version: 2
    activation:
      retrieval_strength: 0.7
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-01-01"
`)
    installPack(join(dir, 'packs'), packDir)
    const packs = listPacks(join(dir, 'packs'))
    const pack = packs.find(p => p.name === 'listed-test')
    expect(pack).toBeDefined()
    expect(pack!.installed_at).toBeTruthy()
    expect(pack!.source).toContain('listed-pack')
    expect(pack!.integrity_ok).toBe(true)
  })

  it('preview warns about high retrieval strength', () => {
    const packDir = join(dir, 'hot-pack')
    mkdirSync(packDir)
    writeFileSync(join(packDir, 'SKILL.md'), '---\nname: hot-test\nversion: "1.0"\n---\n')
    writeFileSync(join(packDir, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0101-001
    statement: I am suspiciously important
    type: behavioral
    scope: global
    status: active
    version: 2
    activation:
      retrieval_strength: 0.95
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-01-01"
`)
    const preview = previewPack(packDir)
    expect(preview.warnings.some(w => w.includes('retrieval strength'))).toBe(true)
  })

  it('uninstall removes registry entry', () => {
    const packDir = join(dir, 'remove-pack')
    mkdirSync(packDir)
    writeFileSync(join(packDir, 'SKILL.md'), '---\nname: remove-test\nversion: "1.0"\n---\n')
    writeFileSync(join(packDir, 'engrams.yaml'), 'engrams:\n  - id: ENG-2026-0101-001\n    statement: Will be removed\n    type: behavioral\n    scope: global\n    status: active\n    version: 2\n    activation:\n      retrieval_strength: 0.7\n      storage_strength: 1.0\n      frequency: 0\n      last_accessed: "2026-01-01"\n')
    installPack(join(dir, 'packs'), packDir)

    // Verify it's in the registry
    let packs = listPacks(join(dir, 'packs'))
    expect(packs.find(p => p.name === 'remove-test')).toBeDefined()

    // Uninstall — the directory name is the basename of source
    uninstallPack(join(dir, 'packs'), 'remove-pack')

    // Registry should no longer contain it
    const registryContent = readFileSync(join(dir, 'packs', 'registry.yaml'), 'utf8')
    expect(registryContent).not.toContain('remove-test')
  })
})
