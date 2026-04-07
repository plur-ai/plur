import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { runMigrations, rollbackMigrations, getSchemaVersion, setSchemaVersion, ALL_MIGRATIONS, CURRENT_SCHEMA_VERSION } from '../src/migrations/index.js'
import { saveEngrams, loadEngrams } from '../src/engrams.js'
import type { Engram } from '../src/schemas/engram.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-migrations-'))
}

function makeEngram(overrides: Partial<Engram> = {}): Engram {
  return {
    id: overrides.id ?? 'ENG-2026-0406-001',
    version: 2,
    status: 'active',
    consolidated: false,
    type: 'behavioral',
    scope: 'global',
    visibility: 'private',
    statement: 'Test engram',
    activation: {
      retrieval_strength: 0.7,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2026-04-06',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_anchors: [],
    associations: [],
    derivation_count: 1,
    tags: [],
    pack: null,
    abstract: null,
    derived_from: null,
    polarity: null,
    ...overrides,
  } as Engram
}

describe('migrations', () => {
  let dir: string
  let engramsPath: string
  let configPath: string

  beforeEach(() => {
    dir = tmpDir()
    engramsPath = path.join(dir, 'engrams.yaml')
    configPath = path.join(dir, 'config.yaml')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('getSchemaVersion / setSchemaVersion', () => {
    it('returns 0 when no config exists', () => {
      expect(getSchemaVersion(configPath)).toBe(0)
    })

    it('returns 0 when config has no schema_version', () => {
      fs.writeFileSync(configPath, yaml.dump({ auto_learn: true }))
      expect(getSchemaVersion(configPath)).toBe(0)
    })

    it('reads and writes schema_version', () => {
      setSchemaVersion(configPath, 3)
      expect(getSchemaVersion(configPath)).toBe(3)
    })

    it('preserves other config fields', () => {
      fs.writeFileSync(configPath, yaml.dump({ auto_learn: false, injection_budget: 3000 }))
      setSchemaVersion(configPath, 5)
      const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
      expect(raw.auto_learn).toBe(false)
      expect(raw.injection_budget).toBe(3000)
      expect(raw.schema_version).toBe(5)
    })
  })

  describe('runMigrations', () => {
    it('applies all migrations from version 0', () => {
      const engram = makeEngram()
      saveEngrams(engramsPath, [engram])
      const result = runMigrations(engramsPath, configPath)
      expect(result.applied.length).toBe(ALL_MIGRATIONS.length)
      expect(result.schema_version).toBe(CURRENT_SCHEMA_VERSION)
    })

    it('creates backup before migrating', () => {
      const engram = makeEngram()
      saveEngrams(engramsPath, [engram])
      const result = runMigrations(engramsPath, configPath)
      expect(result.backup_path).toBeTruthy()
      expect(fs.existsSync(result.backup_path!)).toBe(true)
    })

    it('skips when already at latest version', () => {
      saveEngrams(engramsPath, [makeEngram()])
      setSchemaVersion(configPath, CURRENT_SCHEMA_VERSION)
      const result = runMigrations(engramsPath, configPath)
      expect(result.applied.length).toBe(0)
      expect(result.backup_path).toBeNull()
    })

    it('applies only pending migrations', () => {
      saveEngrams(engramsPath, [makeEngram()])
      setSchemaVersion(configPath, 2) // Already at version 2
      const result = runMigrations(engramsPath, configPath)
      expect(result.applied.length).toBe(ALL_MIGRATIONS.length - 2)
      expect(result.schema_version).toBe(CURRENT_SCHEMA_VERSION)
    })

    it('updates schema_version in config after migration', () => {
      saveEngrams(engramsPath, [makeEngram()])
      runMigrations(engramsPath, configPath)
      expect(getSchemaVersion(configPath)).toBe(CURRENT_SCHEMA_VERSION)
    })

    it('handles empty engrams file', () => {
      // No engrams file at all
      const result = runMigrations(engramsPath, configPath)
      expect(result.applied.length).toBe(ALL_MIGRATIONS.length)
      expect(result.schema_version).toBe(CURRENT_SCHEMA_VERSION)
    })
  })

  describe('rollbackMigrations', () => {
    it('rolls back to target version', () => {
      saveEngrams(engramsPath, [makeEngram()])
      setSchemaVersion(configPath, CURRENT_SCHEMA_VERSION)
      const result = rollbackMigrations(engramsPath, configPath, 2)
      expect(result.applied.length).toBe(CURRENT_SCHEMA_VERSION - 2)
      expect(result.schema_version).toBe(2)
      expect(getSchemaVersion(configPath)).toBe(2)
    })

    it('does nothing when already at target', () => {
      setSchemaVersion(configPath, 3)
      saveEngrams(engramsPath, [makeEngram()])
      const result = rollbackMigrations(engramsPath, configPath, 3)
      expect(result.applied.length).toBe(0)
    })

    it('rejects negative target version', () => {
      setSchemaVersion(configPath, 3)
      saveEngrams(engramsPath, [makeEngram()])
      expect(() => rollbackMigrations(engramsPath, configPath, -1)).toThrow('negative')
    })

    it('creates backup before rollback', () => {
      saveEngrams(engramsPath, [makeEngram()])
      setSchemaVersion(configPath, CURRENT_SCHEMA_VERSION)
      const result = rollbackMigrations(engramsPath, configPath, 0)
      expect(result.backup_path).toBeTruthy()
      expect(fs.existsSync(result.backup_path!)).toBe(true)
    })
  })

  describe('ALL_MIGRATIONS', () => {
    it('has unique IDs', () => {
      const ids = ALL_MIGRATIONS.map(m => m.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('has all expected stubs', () => {
      const ids = ALL_MIGRATIONS.map(m => m.id)
      expect(ids).toContain('20260406-001-add-commitment')
      expect(ids).toContain('20260406-002-add-content-hash')
      expect(ids).toContain('20260406-003-populate-memory-class')
      expect(ids).toContain('20260406-004-populate-cognitive-level')
      expect(ids).toContain('20260406-005-add-version-field')
    })

    it('each migration preserves engrams through up/down cycle', () => {
      const engrams = [makeEngram(), makeEngram({ id: 'ENG-2026-0406-002', statement: 'Another' })]
      for (const m of ALL_MIGRATIONS) {
        const up = m.up([...engrams])
        const down = m.down([...up])
        expect(down.length).toBe(engrams.length)
      }
    })
  })
})
