/**
 * Contract tests for EngramStore implementations.
 * Both YamlStore and SqliteStore must pass all tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { YamlStore } from '../src/store/yaml-store.js'
import { SqliteStore } from '../src/store/sqlite-store.js'
import { createStore, migrateStore } from '../src/store/factory.js'
import type { EngramStore } from '../src/store/types.js'
import type { Engram } from '../src/schemas/engram.js'

function makeEngram(id: string, overrides?: Partial<Engram>): Engram {
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

function runContractTests(name: string, createTestStore: (dir: string) => EngramStore) {
  describe(`EngramStore contract: ${name}`, () => {
    let dir: string
    let store: EngramStore

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), `plur-store-${name}-`))
      store = createTestStore(dir)
    })
    afterEach(async () => {
      await store.close()
      rmSync(dir, { recursive: true })
    })

    it('starts empty', async () => {
      const engrams = await store.load()
      expect(engrams).toHaveLength(0)
      expect(await store.count()).toBe(0)
    })

    it('save and load round-trips', async () => {
      const e1 = makeEngram('ENG-2026-0406-001')
      const e2 = makeEngram('ENG-2026-0406-002', { status: 'retired' })
      await store.save([e1, e2])

      const loaded = await store.load()
      expect(loaded).toHaveLength(2)
      expect(loaded.find(e => e.id === 'ENG-2026-0406-001')?.statement).toBe('Test engram ENG-2026-0406-001')
      expect(loaded.find(e => e.id === 'ENG-2026-0406-002')?.status).toBe('retired')
    })

    it('append adds without losing existing', async () => {
      const e1 = makeEngram('ENG-2026-0406-001')
      await store.save([e1])
      const e2 = makeEngram('ENG-2026-0406-002')
      await store.append(e2)

      const loaded = await store.load()
      expect(loaded).toHaveLength(2)
    })

    it('getById returns engram or null', async () => {
      const e1 = makeEngram('ENG-2026-0406-001')
      await store.save([e1])

      const found = await store.getById('ENG-2026-0406-001')
      expect(found).not.toBeNull()
      expect(found!.statement).toBe('Test engram ENG-2026-0406-001')

      const missing = await store.getById('ENG-NONEXISTENT')
      expect(missing).toBeNull()
    })

    it('remove deletes engram and returns true/false', async () => {
      const e1 = makeEngram('ENG-2026-0406-001')
      await store.save([e1])

      const removed = await store.remove('ENG-2026-0406-001')
      expect(removed).toBe(true)
      expect(await store.count()).toBe(0)

      const removeMissing = await store.remove('ENG-NONEXISTENT')
      expect(removeMissing).toBe(false)
    })

    it('count filters by status', async () => {
      await store.save([
        makeEngram('ENG-2026-0406-001', { status: 'active' }),
        makeEngram('ENG-2026-0406-002', { status: 'active' }),
        makeEngram('ENG-2026-0406-003', { status: 'retired' }),
      ])

      expect(await store.count()).toBe(3)
      expect(await store.count({ status: 'active' })).toBe(2)
      expect(await store.count({ status: 'retired' })).toBe(1)
      expect(await store.count({ status: 'dormant' })).toBe(0)
    })

    it('save replaces all previous data', async () => {
      await store.save([makeEngram('ENG-2026-0406-001')])
      await store.save([makeEngram('ENG-2026-0406-002')])

      const loaded = await store.load()
      expect(loaded).toHaveLength(1)
      expect(loaded[0].id).toBe('ENG-2026-0406-002')
    })

    it('preserves all engram fields through round-trip', async () => {
      const engram = makeEngram('ENG-2026-0406-001', {
        domain: 'infrastructure.servers',
        tags: ['ssh', 'deployment'],
        rationale: 'Standard practice',
        polarity: 'do',
      })
      await store.save([engram])

      const loaded = await store.load()
      expect(loaded[0].domain).toBe('infrastructure.servers')
      expect(loaded[0].tags).toEqual(['ssh', 'deployment'])
      expect(loaded[0].rationale).toBe('Standard practice')
      expect(loaded[0].polarity).toBe('do')
    })
  })
}

// Run contract tests for both implementations
runContractTests('yaml', (dir) => new YamlStore(join(dir, 'engrams.yaml')))
runContractTests('sqlite', (dir) => new SqliteStore(join(dir, 'engrams.db')))

// Factory and migration tests
describe('Store factory', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-factory-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('creates YamlStore by default', () => {
    const store = createStore({ backend: 'yaml', path: dir })
    expect(store).toBeInstanceOf(YamlStore)
  })

  it('creates SqliteStore when configured', () => {
    const store = createStore({ backend: 'sqlite', path: dir })
    expect(store).toBeInstanceOf(SqliteStore)
  })
})

describe('Store migration', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-migrate-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('migrates yaml to sqlite', async () => {
    const yamlStore = new YamlStore(join(dir, 'engrams.yaml'))
    const sqliteStore = new SqliteStore(join(dir, 'engrams.db'))

    await yamlStore.save([
      makeEngram('ENG-2026-0406-001'),
      makeEngram('ENG-2026-0406-002'),
    ])

    const count = await migrateStore(yamlStore, sqliteStore)
    expect(count).toBe(2)

    const loaded = await sqliteStore.load()
    expect(loaded).toHaveLength(2)
    await sqliteStore.close()
  })

  it('migrates sqlite to yaml', async () => {
    const sqliteStore = new SqliteStore(join(dir, 'engrams.db'))
    const yamlStore = new YamlStore(join(dir, 'engrams.yaml'))

    await sqliteStore.save([
      makeEngram('ENG-2026-0406-001'),
      makeEngram('ENG-2026-0406-002'),
      makeEngram('ENG-2026-0406-003'),
    ])

    const count = await migrateStore(sqliteStore, yamlStore)
    expect(count).toBe(3)

    const loaded = await yamlStore.load()
    expect(loaded).toHaveLength(3)
    await sqliteStore.close()
  })
})
