import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

/** Minimal valid engram for store YAML files */
function makeEngram(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ENG-2026-0401-001',
    version: 2,
    status: 'active',
    consolidated: false,
    type: 'behavioral',
    scope: 'global',
    visibility: 'private',
    statement: 'Test engram from store',
    activation: {
      retrieval_strength: 0.7,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2026-04-01',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    associations: [],
    derivation_count: 1,
    tags: [],
    pack: null,
    abstract: null,
    derived_from: null,
    polarity: null,
    ...overrides,
  }
}

// storePrefix('datafund') → 'DA' (first 2 chars of single-word scope)
const NS_ID = 'ENG-DA-2026-0401-001'

describe('Multi-store', () => {
  let primaryDir: string
  let storeDir: string
  let storePath: string

  beforeEach(() => {
    primaryDir = mkdtempSync(join(tmpdir(), 'plur-primary-'))
    storeDir = mkdtempSync(join(tmpdir(), 'plur-store-'))
    storePath = join(storeDir, 'engrams.yaml')
  })

  afterEach(() => {
    rmSync(primaryDir, { recursive: true })
    rmSync(storeDir, { recursive: true })
  })

  function writeStoreEngrams(engrams: unknown[]) {
    writeFileSync(storePath, yaml.dump({ engrams }, { lineWidth: 120, noRefs: true }))
  }

  function writeConfig(stores: Array<{ path: string; scope: string; shared?: boolean; readonly?: boolean }>) {
    writeFileSync(join(primaryDir, 'config.yaml'), yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }))
  }

  function createPlur() {
    return new Plur({ path: primaryDir })
  }

  it('recall finds engrams from both primary and store', () => {
    writeStoreEngrams([makeEngram({ statement: 'Store uses PostgreSQL for persistence' })])
    writeConfig([{ path: storePath, scope: 'datafund' }])
    const plur = createPlur()
    plur.learn('Primary uses Redis for caching', { scope: 'global' })

    const results = plur.recall('PostgreSQL Redis persistence caching')
    const statements = results.map(e => e.statement)
    expect(statements).toContain('Store uses PostgreSQL for persistence')
    expect(statements).toContain('Primary uses Redis for caching')
  })

  it('learn writes only to primary', () => {
    writeStoreEngrams([makeEngram()])
    writeConfig([{ path: storePath, scope: 'datafund' }])
    const plur = createPlur()
    plur.learn('New learning goes to primary only', { scope: 'global' })

    // Primary should have the new engram
    const primaryRaw = yaml.load(readFileSync(join(primaryDir, 'engrams.yaml'), 'utf8')) as any
    expect(primaryRaw.engrams.some((e: any) => e.statement === 'New learning goes to primary only')).toBe(true)

    // Store should be unchanged — still only the original engram
    const storeRaw = yaml.load(readFileSync(storePath, 'utf8')) as any
    expect(storeRaw.engrams).toHaveLength(1)
    expect(storeRaw.engrams[0].id).toBe('ENG-2026-0401-001')
  })

  it('learn generates IDs without collision', () => {
    writeStoreEngrams([makeEngram({ id: 'ENG-2026-0401-001' })])
    writeConfig([{ path: storePath, scope: 'datafund' }])
    const plur = createPlur()
    plur.learn('First primary engram', { scope: 'global' })
    const first = plur.list()[0]
    const second = plur.learn('Second primary engram', { scope: 'global' })
    expect(second.id).not.toBe(first.id)
    expect(second.id).not.toBe('ENG-2026-0401-001')
    expect(second.id).toMatch(/^ENG-/)
  })

  it('feedback on writable store engram persists', () => {
    writeStoreEngrams([makeEngram({ statement: 'Writable store engram for feedback' })])
    writeConfig([{ path: storePath, scope: 'datafund', readonly: false }])
    const plur = createPlur()

    plur.feedback(NS_ID, 'positive')

    // Verify the store file was updated
    const storeRaw = yaml.load(readFileSync(storePath, 'utf8')) as any
    const updated = storeRaw.engrams.find((e: any) => e.id === 'ENG-2026-0401-001')
    expect(updated.feedback_signals.positive).toBe(1)
    expect(updated.activation.retrieval_strength).toBe(0.75)
  })

  it('feedback on readonly store engram throws', () => {
    writeStoreEngrams([makeEngram()])
    writeConfig([{ path: storePath, scope: 'datafund', readonly: true }])
    const plur = createPlur()

    expect(() => plur.feedback(NS_ID, 'positive')).toThrow('readonly store')
  })

  it('forget on writable store engram works', () => {
    writeStoreEngrams([makeEngram()])
    writeConfig([{ path: storePath, scope: 'datafund', readonly: false }])
    const plur = createPlur()

    plur.forget(NS_ID, 'no longer needed')

    const storeRaw = yaml.load(readFileSync(storePath, 'utf8')) as any
    const retired = storeRaw.engrams.find((e: any) => e.id === 'ENG-2026-0401-001')
    expect(retired.status).toBe('retired')
  })

  it('forget on readonly store engram throws', () => {
    writeStoreEngrams([makeEngram()])
    writeConfig([{ path: storePath, scope: 'datafund', readonly: true }])
    const plur = createPlur()

    expect(() => plur.forget(NS_ID, 'test')).toThrow('readonly store')
  })

  it('getById finds store engrams by namespaced ID', () => {
    writeStoreEngrams([makeEngram({ statement: 'Findable by namespaced ID' })])
    writeConfig([{ path: storePath, scope: 'datafund' }])
    const plur = createPlur()

    const found = plur.getById(NS_ID)
    expect(found).not.toBeNull()
    expect(found!.statement).toBe('Findable by namespaced ID')
    expect(found!.id).toBe(NS_ID)
  })

  it('status counts across stores', () => {
    // 2 primary engrams
    const plur0 = new Plur({ path: primaryDir })
    plur0.learn('Primary one', { scope: 'global' })
    plur0.learn('Primary two', { scope: 'global' })

    // 3 store engrams
    writeStoreEngrams([
      makeEngram({ id: 'ENG-2026-0401-001', statement: 'Store one' }),
      makeEngram({ id: 'ENG-2026-0401-002', statement: 'Store two' }),
      makeEngram({ id: 'ENG-2026-0401-003', statement: 'Store three' }),
    ])
    writeConfig([{ path: storePath, scope: 'datafund' }])
    const plur = createPlur()

    const st = plur.status()
    expect(st.engram_count).toBe(5)
  })

  it('inject includes store engrams', () => {
    writeStoreEngrams([makeEngram({ statement: 'Always validate user input before processing' })])
    writeConfig([{ path: storePath, scope: 'datafund' }])
    const plur = createPlur()

    const result = plur.inject('validate user input')
    expect(result.count).toBeGreaterThan(0)
    expect(result.directives + result.constraints + result.consider).toContain('validate')
  })

  it('scope validation: global narrowed to store scope', () => {
    writeStoreEngrams([makeEngram({ scope: 'global', statement: 'Global narrowed to datafund' })])
    writeConfig([{ path: storePath, scope: 'datafund' }])
    const plur = createPlur()

    const found = plur.getById(NS_ID)
    expect(found).not.toBeNull()
    expect(found!.scope).toBe('datafund')
  })

  it('scope validation: mismatch skipped', () => {
    writeStoreEngrams([makeEngram({ scope: 'personal', statement: 'Should be skipped' })])
    writeConfig([{ path: storePath, scope: 'datafund' }])
    const plur = createPlur()

    // The engram should not appear because scope 'personal' mismatches store scope 'datafund'
    const found = plur.getById(NS_ID)
    expect(found).toBeNull()

    const st = plur.status()
    expect(st.engram_count).toBe(0)
  })
})
