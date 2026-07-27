import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { YamlPrimaryStore } from '../src/store/yaml-primary-store.js'
import { MemoryPrimaryStore } from '../src/store/memory-primary-store.js'
import { loadEngrams, saveEngrams } from '../src/engrams.js'
import type { PrimaryStore } from '../src/store/primary-store.js'
import type { Engram } from '../src/schemas/engram.js'

/**
 * Convergence Phase 1 — `PrimaryStore` is the source-of-truth seam that the
 * `Plur` class persists through. These tests pin the contract that both
 * implementations must satisfy, so a Phase 5 Postgres store has something
 * concrete to conform to.
 */

function engram(id: string, statement = 'a statement'): Engram {
  return {
    id,
    statement,
    type: 'behavioral',
    domain: 'test',
    status: 'active',
    scope: 'global',
    version: 2,
    consolidated: false,
    visibility: 'private',
    tags: [],
    activation: { retrieval_strength: 0.8, storage_strength: 1.0, frequency: 1, last_accessed: '2026-07-01' },
    associations: [],
    knowledge_anchors: [],
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    pack: null,
    abstract: null,
    derived_from: null,
    derivation_count: 0,
    reference_count: 0,
    recurrence_count: 0,
    sources: [],
    engram_version: 1,
    episode_ids: [],
    polarity: null,
  } as unknown as Engram
}

describe('PrimaryStore contract (shared by every implementation)', () => {
  let dir: string
  const cases: { name: string; make: () => PrimaryStore }[] = [
    { name: 'YamlPrimaryStore', make: () => new YamlPrimaryStore(join(dir, 'engrams.yaml')) },
    { name: 'MemoryPrimaryStore', make: () => new MemoryPrimaryStore() },
  ]

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-primary-store-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  for (const { name, make } of cases) {
    describe(name, () => {
      it('starts empty', async () => {
        const store = make()
        expect(await store.load()).toEqual([])
        expect(await store.loadCached()).toEqual([])
      })

      it('round-trips a save through load()', async () => {
        const store = make()
        await store.save([engram('ENG-2026-0701-001')])
        expect((await store.load()).map(e => e.id)).toEqual(['ENG-2026-0701-001'])
      })

      it('loadCached() reflects a save made through the same store', async () => {
        const store = make()
        // Warm the cache first — the regression this guards (#25) is a cached
        // pre-write snapshot surviving a write.
        expect(await store.loadCached()).toEqual([])
        await store.save([engram('ENG-2026-0701-002')])
        expect((await store.loadCached()).map(e => e.id)).toEqual(['ENG-2026-0701-002'])
      })

      it('save() replaces the whole contents rather than appending', async () => {
        const store = make()
        await store.save([engram('ENG-2026-0701-003'), engram('ENG-2026-0701-004')])
        await store.save([engram('ENG-2026-0701-005')])
        expect((await store.load()).map(e => e.id)).toEqual(['ENG-2026-0701-005'])
      })

      it('mutating a loaded array does not mutate stored state', async () => {
        const store = make()
        await store.save([engram('ENG-2026-0701-006', 'original')])
        const loaded = await store.load()
        loaded[0].statement = 'tampered'
        loaded.push(engram('ENG-2026-0701-007'))
        const reread = await store.load()
        expect(reread).toHaveLength(1)
        expect(reread[0].statement).toBe('original')
      })

      it('invalidate() does not lose persisted data', async () => {
        const store = make()
        await store.save([engram('ENG-2026-0701-008')])
        store.invalidate()
        expect((await store.load()).map(e => e.id)).toEqual(['ENG-2026-0701-008'])
      })
    })
  }
})

describe('YamlPrimaryStore — ADR-0001 compatibility', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-yaml-store-'))
    path = join(dir, 'engrams.yaml')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reports kind and location', () => {
    const store = new YamlPrimaryStore(path)
    expect(store.kind).toBe('yaml')
    expect(store.location).toBe(path)
  })

  it('reads a file written by saveEngrams() and writes one readable by loadEngrams()', async () => {
    // Byte-level interop with the pre-refactor helpers is the whole point: an
    // existing ~/.plur/engrams.yaml must keep working untouched.
    saveEngrams(path, [engram('ENG-2026-0701-100', 'written by the old helper')])
    const store = new YamlPrimaryStore(path)
    expect((await store.load())[0].statement).toBe('written by the old helper')

    await store.save([engram('ENG-2026-0701-101', 'written by the store')])
    expect(loadEngrams(path)[0].statement).toBe('written by the store')
  })

  it('does not create the file merely by being constructed or read', async () => {
    const store = new YamlPrimaryStore(path)
    await store.load()
    await store.loadCached()
    expect(existsSync(path)).toBe(false)
  })

  it('loadCached() serves a cached snapshot while mtime is unchanged', async () => {
    saveEngrams(path, [engram('ENG-2026-0701-102')])
    const store = new YamlPrimaryStore(path)
    const first = await store.loadCached()
    const second = await store.loadCached()
    // Same array identity proves the second call did not re-parse the file.
    expect(second).toBe(first)
  })

  it('loadCached() picks up an out-of-band write with a newer mtime', async () => {
    saveEngrams(path, [engram('ENG-2026-0701-103')])
    const store = new YamlPrimaryStore(path)
    expect((await store.loadCached()).map(e => e.id)).toEqual(['ENG-2026-0701-103'])
    // Simulate another process replacing the file.
    saveEngrams(path, [engram('ENG-2026-0701-104')])
    store.invalidate()
    expect((await store.loadCached()).map(e => e.id)).toEqual(['ENG-2026-0701-104'])
  })

  it('load() bypasses the cache entirely', async () => {
    saveEngrams(path, [engram('ENG-2026-0701-105')])
    const store = new YamlPrimaryStore(path)
    await store.loadCached()
    saveEngrams(path, [engram('ENG-2026-0701-106')])
    expect((await store.load()).map(e => e.id)).toEqual(['ENG-2026-0701-106'])
  })

  it('returns [] for an unparseable file rather than throwing', async () => {
    writeFileSync(path, ':\n  not: [valid', 'utf8')
    const store = new YamlPrimaryStore(path)
    expect(await store.load()).toEqual([])
  })
})

describe('MemoryPrimaryStore', () => {
  it('reports kind and a null location', () => {
    const store = new MemoryPrimaryStore()
    expect(store.kind).toBe('memory')
    expect(store.location).toBeNull()
  })

  it('accepts a seed and clones it so the caller cannot mutate stored state', async () => {
    const seed = [engram('ENG-2026-0701-200', 'seeded')]
    const store = new MemoryPrimaryStore(seed)
    seed[0].statement = 'mutated after construction'
    expect((await store.load())[0].statement).toBe('seeded')
  })
})
