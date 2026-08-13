import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, ReadonlyStoreError, ReadonlyStoreGuard, YamlPrimaryStore, MemoryPrimaryStore, type PrimaryStore } from '../src/index.js'
import { loadEngrams, saveEngrams } from '../src/engrams.js'
import type { Engram } from '../src/schemas/engram.js'

/**
 * Read-only Plur mode (#731).
 *
 * The contract under test, in priority order:
 *   1. recall() SUCCEEDS on a read-only instance — the activation refresh is
 *      skipped silently, never allowed to fail the read. (#745's first cut
 *      threw ReadonlyStoreError from inside `_reactivateResults` on every
 *      recall with >= 1 result, which is exactly the "refusing the write makes
 *      the read wrong" failure mode #731 warned about.)
 *   2. Every mutator throws the TYPED error, including remote-routed paths
 *      (learnRouted, flushOutbox) that never touch the guarded PrimaryStore.
 *   3. No disk side-effects from reads: no store bytes changed, no `.lock`
 *      files, no startup-migration sentinel.
 */
describe('read-only Plur mode (#731)', () => {
  let dir: string
  let engramId: string

  const engramsFile = () => join(dir, 'engrams.yaml')
  const bytes = () => readFileSync(engramsFile(), 'utf8')

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-readonly-'))
    const writable = new Plur({ path: dir })
    await writable.ready()
    const e = await writable.learn('use PostgreSQL for the production database', { type: 'behavioral', domain: 'test' })
    await writable.learn('always run the tests before merging', { type: 'behavioral', domain: 'test' })
    engramId = e.id
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('recall succeeds and returns results', async () => {
    const ro = new Plur({ path: dir, readonly: true })
    const results = await ro.recall('PostgreSQL database')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].statement).toContain('PostgreSQL')
  })

  it('recallHybrid succeeds too — every recall flavour routes through the same reactivation', async () => {
    const ro = new Plur({ path: dir, readonly: true })
    const results = await ro.recallHybrid('PostgreSQL database')
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('recall does NOT refresh activation — the store file is byte-identical afterwards', async () => {
    const before = bytes()
    const ro = new Plur({ path: dir, readonly: true })
    const results = await ro.recall('PostgreSQL database')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(bytes()).toBe(before)
    // Contrast: the same recall on a WRITABLE instance rewrites activation
    // (frequency/last_accessed), proving the skip above is the readonly flag
    // and not recall having stopped reactivating.
    const rw = new Plur({ path: dir })
    await rw.recall('PostgreSQL database')
    const after = loadEngrams(engramsFile())
    expect(after.find(e => e.id === engramId)?.activation.frequency).toBeGreaterThan(0)
  })

  it('recall creates no .lock files — the read path skips lock acquisition', async () => {
    const ro = new Plur({ path: dir, readonly: true })
    await ro.recall('PostgreSQL database')
    const locks = readdirSync(dir).filter(f => f.endsWith('.lock'))
    expect(locks).toEqual([])
  })

  it('learn throws ReadonlyStoreError', async () => {
    const ro = new Plur({ path: dir, readonly: true })
    await expect(ro.learn('a new fact')).rejects.toBeInstanceOf(ReadonlyStoreError)
  })

  it('learnRouted throws ReadonlyStoreError BEFORE any remote routing', async () => {
    // The remote write path (appendAndGetServerId) never touches the guarded
    // PrimaryStore — the gate must fire before scope resolution can route the
    // write to a server.
    const ro = new Plur({ path: dir, readonly: true })
    await expect(ro.learnRouted('a new fact', { scope: 'group:acme/eng' })).rejects.toBeInstanceOf(ReadonlyStoreError)
  })

  it('feedback throws ReadonlyStoreError', async () => {
    const ro = new Plur({ path: dir, readonly: true })
    await expect(ro.feedback(engramId, 'positive')).rejects.toBeInstanceOf(ReadonlyStoreError)
  })

  it('forget throws ReadonlyStoreError', async () => {
    const ro = new Plur({ path: dir, readonly: true })
    await expect(ro.forget(engramId)).rejects.toBeInstanceOf(ReadonlyStoreError)
  })

  it('purgeTensions throws ReadonlyStoreError', async () => {
    const ro = new Plur({ path: dir, readonly: true })
    await expect(ro.purgeTensions()).rejects.toBeInstanceOf(ReadonlyStoreError)
  })

  it('the remaining mutators throw it too', async () => {
    const ro = new Plur({ path: dir, readonly: true })
    const existing = loadEngrams(engramsFile())[0]
    await expect(ro.setPinned(engramId, true)).rejects.toBeInstanceOf(ReadonlyStoreError)
    await expect(ro.updateEngram(existing)).rejects.toBeInstanceOf(ReadonlyStoreError)
    await expect(ro.compact()).rejects.toBeInstanceOf(ReadonlyStoreError)
    await expect(ro.flushOutbox()).rejects.toBeInstanceOf(ReadonlyStoreError)
    await expect(ro.learnAsync('another fact')).rejects.toBeInstanceOf(ReadonlyStoreError)
    await expect(ro.saveMetaEngrams([existing])).rejects.toBeInstanceOf(ReadonlyStoreError)
  })

  it('the error is typed by name, distinguishable from a store failure', async () => {
    const ro = new Plur({ path: dir, readonly: true })
    const err = await ro.learn('x').catch(e => e)
    expect(err.name).toBe('ReadonlyStoreError')
    expect(err.message).toMatch(/read-only/)
  })

  it('after failed writes the store file is untouched', async () => {
    const before = bytes()
    const ro = new Plur({ path: dir, readonly: true })
    await ro.learn('x').catch(() => {})
    await ro.feedback(engramId, 'negative').catch(() => {})
    await ro.forget(engramId).catch(() => {})
    expect(bytes()).toBe(before)
  })

  it('secondary stores are guarded too — _storeAt wraps them (#731)', async () => {
    // forget/feedback/recurrence on a store engram write through
    // `_storeAt(storeInfo.path)`, not the primary store. Wrapping only the
    // primary would leave every `stores:` file writable from a "read-only"
    // engine — this pins the wrap itself.
    const storeDir = mkdtempSync(join(tmpdir(), 'plur-readonly-store-'))
    try {
      const storePath = join(storeDir, 'engrams.yaml')
      const seed = loadEngrams(engramsFile())
      saveEngrams(storePath, seed)
      const before = readFileSync(storePath, 'utf8')
      const ro = new Plur({ path: dir, readonly: true })
      const secondary = (ro as any)._storeAt(storePath) as PrimaryStore
      expect(secondary).toBeInstanceOf(ReadonlyStoreGuard)
      await expect(secondary.save([])).rejects.toBeInstanceOf(ReadonlyStoreError)
      expect(readFileSync(storePath, 'utf8')).toBe(before)
    } finally {
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('the startup tension migration is skipped: no write, and no sentinel claiming it ran', async () => {
    // Craft a legacy conflict and remove the sentinel so a writable instance
    // WOULD purge on construction.
    const sentinel = join(dir, '.tensions-purged')
    rmSync(sentinel, { force: true })
    const engrams = loadEngrams(engramsFile())
    engrams[0].relations = {
      broader: [], narrower: [], related: [], supersedes: [], superseded_by: [],
      conflicts: [engrams[1].id],
    }
    saveEngrams(engramsFile(), engrams)
    const before = bytes()

    const ro = new Plur({ path: dir, readonly: true })
    await ro.ready()
    expect(bytes()).toBe(before)
    // Crucially the sentinel must NOT exist: stamping it from a read-only
    // instance would record the migration as done without it ever running.
    expect(existsSync(sentinel)).toBe(false)

    // A writable instance then genuinely performs it.
    const rw = new Plur({ path: dir })
    await rw.ready()
    expect(existsSync(sentinel)).toBe(true)
    expect(loadEngrams(engramsFile())[0].relations?.conflicts).toEqual([])
  })

  it('a readonly instance and a writable instance coexist on one path', async () => {
    const ro = new Plur({ path: dir, readonly: true })
    const rw = new Plur({ path: dir })
    const learned = await rw.learn('written by the writable instance')
    const seen = await ro.getById(learned.id)
    expect(seen?.statement).toBe('written by the writable instance')
  })
})

describe('ReadonlyStoreGuard', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-ro-guard-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const seedEngram = (id: string): Engram => ({
    id,
    statement: 'a statement',
    type: 'behavioral',
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
  } as unknown as Engram)

  /** Minimal PrimaryStore with NO optional capabilities. */
  const bareStore = (): PrimaryStore => ({
    kind: 'memory',
    location: null,
    load: async () => [seedEngram('ENG-2026-0101-001')],
    loadCached: async () => [seedEngram('ENG-2026-0101-001')],
    save: async () => {},
    invalidate: () => {},
  })

  it('delegates reads and mirrors kind/location', async () => {
    const inner = new MemoryPrimaryStore([seedEngram('ENG-2026-0101-001')])
    const guard = new ReadonlyStoreGuard(inner)
    expect(guard.kind).toBe('memory')
    expect(guard.location).toBeNull()
    expect((await guard.load()).map(e => e.id)).toEqual(['ENG-2026-0101-001'])
    expect((await guard.loadCached()).length).toBe(1)
    expect((await guard.loadByIds!(['ENG-2026-0101-001'])).length).toBe(1)
  })

  it('rejects save, append and updateMany with ReadonlyStoreError', async () => {
    const guard = new ReadonlyStoreGuard(new MemoryPrimaryStore())
    await expect(guard.save([])).rejects.toBeInstanceOf(ReadonlyStoreError)
    await expect(guard.append!(seedEngram('ENG-2026-0101-002'))).rejects.toBeInstanceOf(ReadonlyStoreError)
    await expect(guard.updateMany!([])).rejects.toBeInstanceOf(ReadonlyStoreError)
  })

  it('does NOT invent estimateCount for a store that has none', () => {
    // Backend selection treats an absent estimate as "small" via its own
    // fallback. A guard that coerced this to `0` would be asserting an exact
    // size the inner store never claimed.
    const guard = new ReadonlyStoreGuard(bareStore())
    expect(guard.estimateCount).toBeUndefined()
  })

  it('forwards estimateCount when the inner store has one', () => {
    const inner = new MemoryPrimaryStore([seedEngram('ENG-2026-0101-001')])
    const guard = new ReadonlyStoreGuard(inner)
    expect(guard.estimateCount!()).toBe(1)
  })

  it('mirrors the optional capability surface of the inner store', () => {
    const guard = new ReadonlyStoreGuard(bareStore())
    expect(guard.loadByIds).toBeUndefined()
    expect(guard.append).toBeUndefined()
    expect(guard.updateMany).toBeUndefined()
  })

  it('withExclusiveAccess runs the callback without acquiring a lock (no .lock file)', async () => {
    const file = join(dir, 'engrams.yaml')
    saveEngrams(file, [seedEngram('ENG-2026-0101-001')])
    const guard = new ReadonlyStoreGuard(new YamlPrimaryStore(file))
    const out = await guard.withExclusiveAccess(async () => 42)
    expect(out).toBe(42)
    expect(readdirSync(dir).filter(f => f.endsWith('.lock'))).toEqual([])
  })
})
