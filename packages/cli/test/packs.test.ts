import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur packs', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  it('packs list returns empty on fresh store', () => {
    const output = JSON.parse(run('packs list'))
    expect(output.packs).toBeInstanceOf(Array)
    expect(output.count).toBe(0)
  })

  it('packs list returns count field', () => {
    const output = JSON.parse(run('packs list'))
    expect(typeof output.count).toBe('number')
  })

  it('packs without subcommand defaults to list', () => {
    const output = JSON.parse(run('packs'))
    expect(output.packs).toBeInstanceOf(Array)
    expect(output.count).toBeGreaterThanOrEqual(0)
  })

  it('packs install adds a pack', () => {
    // Create a minimal pack directory with valid engrams
    const packDir = mkdtempSync(join(tmpdir(), 'test-pack-'))
    try {
      writeFileSync(join(packDir, 'manifest.yaml'), 'name: test-pack\nversion: 1.0.0\n')
      // Write a valid engram YAML — loadEngrams expects { engrams: [...] }
      const engramYaml = [
        'engrams:',
        '  - id: ENG-0001',
        '    version: 2',
        '    status: active',
        '    consolidated: false',
        '    type: behavioral',
        '    scope: global',
        '    visibility: private',
        '    statement: test engram from pack',
        '    activation:',
        '      retrieval_strength: 0.7',
        '      storage_strength: 1.0',
        '      frequency: 0',
        '      last_accessed: "2024-01-01"',
        '    feedback_signals:',
        '      positive: 0',
        '      negative: 0',
        '      neutral: 0',
        '    knowledge_anchors: []',
        '    associations: []',
        '    derivation_count: 1',
        '    tags: []',
        '    pack: null',
        '    abstract: null',
        '    derived_from: null',
        '    polarity: null',
      ].join('\n')
      writeFileSync(join(packDir, 'engrams.yaml'), engramYaml)
      const output = JSON.parse(run(`packs install ${packDir}`))
      expect(output.installed).toBe(1)
      expect(output.name).toBeDefined()
    } finally {
      rmSync(packDir, { recursive: true })
    }
  })

  it('packs install exits 1 with no source', () => {
    expect(() => run('packs install')).toThrow()
  })

  it('invalid subcommand exits 1', () => {
    expect(() => run('packs badcmd')).toThrow()
  })
})
