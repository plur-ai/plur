/**
 * Targeted write-path seams (#827, #828).
 *
 * 0.16 and 0.17 gave a row store seams to serve READS from its own indexes
 * (`role: 'primary'` + `searchBM25`) and to write back only the rows that
 * changed (`loadByIds` + `updateMany`). The write path never got the same
 * treatment: `learn()` materialised the corpus twice — once to look for a
 * duplicate statement, once to derive the next id — and `feedback()`
 * materialised it to fetch a single row by primary key.
 *
 * These tests pin the two properties that make the fix meaningful:
 *
 *   1. With the capabilities present, the engine performs ZERO full-corpus
 *      loads. Asserted with a counting store, never with timing — "fast
 *      enough" is not a property, "did not call load()" is.
 *   2. With them absent, behaviour is exactly what it was, and no partial
 *      implementation can be talked into destroying the corpus.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { dump } from 'js-yaml'
import { Plur } from '../src/index.js'
import { YamlPrimaryStore } from '../src/store/yaml-primary-store.js'
import { logger } from '../src/logger.js'
import type { Engram } from '../src/schemas/engram.js'
import type { PrimaryStore, PrimaryStoreKind } from '../src/store/primary-store.js'

/**
 * A row-store stand-in that COUNTS whole-corpus reads.
 *
 * Deliberately not built on `MemoryPrimaryStore` or `YamlPrimaryStore`: the
 * targeted methods here read `this.rows` directly rather than going through
 * `load()`, so the counter measures exactly one thing — how many times the
 * ENGINE asked for the whole corpus. A spy whose own `loadByIds` called
 * `load()` internally would report a full load for every targeted query and
 * measure nothing at all.
 */
class CountingStore implements PrimaryStore {
  readonly kind: PrimaryStoreKind = 'memory'
  readonly location: string | null = null

  /** Whole-corpus reads (`load` + `loadCached`) requested by the engine. */
  fullLoads = 0
  findByHashCalls = 0
  nextIdCalls = 0
  appendCalls = 0
  updateManyCalls = 0
  loadByIdsCalls = 0

  protected rows: Engram[] = []

  async load(): Promise<Engram[]> {
    this.fullLoads++
    return this.rows.map(e => structuredClone(e))
  }

  async loadCached(): Promise<Engram[]> {
    return this.load()
  }

  async save(engrams: Engram[]): Promise<void> {
    this.rows = engrams.map(e => structuredClone(e))
  }

  invalidate(): void {
    // Nothing is cached — the store IS the memory.
  }

  async append(engram: Engram): Promise<void> {
    this.appendCalls++
    if (this.rows.some(e => e.id === engram.id)) {
      throw new Error(`append: engram ${engram.id} already exists`)
    }
    this.rows.push(structuredClone(engram))
  }

  async updateMany(engrams: Engram[]): Promise<void> {
    this.updateManyCalls++
    for (const engram of engrams) {
      const idx = this.rows.findIndex(e => e.id === engram.id)
      if (idx === -1) this.rows.push(structuredClone(engram))
      else this.rows[idx] = structuredClone(engram)
    }
  }

  async loadByIds(ids: string[]): Promise<Engram[]> {
    this.loadByIdsCalls++
    const wanted = new Set(ids)
    return this.rows.filter(e => wanted.has(e.id)).map(e => structuredClone(e))
  }

  async findActiveByContentHash(hash: string, scope: string): Promise<Engram | null> {
    this.findByHashCalls++
    const hit = this.rows.find(
      e => e.status === 'active' && (e as any).content_hash === hash && e.scope === scope,
    )
    return hit ? structuredClone(hit) : null
  }

  async nextEngramId(datePrefix: string): Promise<string> {
    this.nextIdCalls++
    const used = this.rows
      .filter(e => e.id.startsWith(datePrefix))
      .map(e => parseInt(e.id.slice(datePrefix.length), 10))
      .filter(n => !isNaN(n))
    const next = used.length > 0 ? Math.max(...used) + 1 : 1
    return `${datePrefix}${String(next).padStart(3, '0')}`
  }

  /** Read the rows WITHOUT counting a load — for assertions only. */
  peek(): Engram[] {
    return this.rows
  }

  resetCounts(): void {
    this.fullLoads = 0
    this.findByHashCalls = 0
    this.nextIdCalls = 0
    this.appendCalls = 0
    this.updateManyCalls = 0
    this.loadByIdsCalls = 0
  }
}

/**
 * The derive seams WITHOUT the targeted-write seams — the half-implemented
 * shape the optional-method interface permits, and the one that would be
 * catastrophic if the engine took the targeted READ and then wrote a
 * whole-corpus `save()` of the stand-in array.
 */
class DeriveOnlyStore extends CountingStore {
  readonly refusesUnreadable = true
  // append / updateMany / loadByIds deliberately absent.
  append = undefined as any
  updateMany = undefined as any
  loadByIds = undefined as any
}

const TEMP_DIRS: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-write-seams-'))
  TEMP_DIRS.push(dir)
  return dir
}

afterEach(() => {
  while (TEMP_DIRS.length) rmSync(TEMP_DIRS.pop()!, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// #828 — learn()
// ---------------------------------------------------------------------------

describe('#828 learn() write-path seams', () => {
  it('performs no full-corpus load when the store implements the seams', async () => {
    const store = new CountingStore()
    const plur = new Plur({ path: tempDir(), store, autoDiscover: false })
    await plur.ready()

    // Seed through the public API, then measure only the learn under test.
    for (let i = 0; i < 5; i++) {
      await plur.learn(`seeded engram ${i} about deployment rollout`, { scope: 'global' })
    }
    store.resetCounts()

    const engram = await plur.learn('a brand new statement nobody has learned yet', { scope: 'global' })

    expect(store.fullLoads).toBe(0)
    expect(store.findByHashCalls).toBe(1)
    expect(store.nextIdCalls).toBe(1)
    expect(store.appendCalls).toBe(1)
    expect(store.peek().some(e => e.id === engram.id)).toBe(true)
  })

  it('uses the store id allocator for the new engram id', async () => {
    const store = new CountingStore()
    const plur = new Plur({ path: tempDir(), store, autoDiscover: false })
    await plur.ready()

    const day = new Date().toISOString().slice(0, 10)
    const first = await plur.learn('the first statement of the day', { scope: 'global' })
    const second = await plur.learn('the second statement of the day', { scope: 'global' })

    expect(first.id).toBe(`ENG-${day}-001`)
    expect(second.id).toBe(`ENG-${day}-002`)
    expect(store.nextIdCalls).toBe(2)
  })

  it('deduplicates through the store and persists the reference_count increment', async () => {
    const store = new CountingStore()
    const plur = new Plur({ path: tempDir(), store, autoDiscover: false })
    await plur.ready()

    const original = await plur.learn('always run pnpm build before publishing', { scope: 'global' })
    store.resetCounts()

    const again = await plur.learn('always run pnpm build before publishing', { scope: 'global' })

    expect(again.id).toBe(original.id)
    expect(store.fullLoads).toBe(0)
    expect(store.findByHashCalls).toBe(1)
    // The increment landed on the row, not just on the returned object.
    const stored = store.peek().find(e => e.id === original.id)!
    expect((stored as any).reference_count).toBe(2)
    expect(store.peek().filter(e => e.status === 'active')).toHaveLength(1)
    // No new id was allocated for a duplicate.
    expect(store.nextIdCalls).toBe(0)
    expect(store.appendCalls).toBe(0)
  })

  /**
   * The documented consequence of a scope-BOUND dedup seam, pinned so it can
   * only change deliberately.
   *
   * On the corpus-scanning path the second learn is a cross-scope recurrence:
   * it graduates the existing engram (#176) instead of creating a row. The
   * seam is contractually unable to answer "same hash, ANY other scope" —
   * that is the disclosure it exists to prevent — so under delegation the
   * primary half of that check is skipped and the statement becomes its own
   * engram in its own scope. See `PrimaryStore.findActiveByContentHash`.
   */
  it('does not graduate a cross-scope recurrence — the dedup seam is scope-bound', async () => {
    const store = new CountingStore()
    const plur = new Plur({ path: tempDir(), store, autoDiscover: false })
    await plur.ready()

    const a = await plur.learn('deploys go out on Tuesdays', { scope: 'global' })
    const b = await plur.learn('deploys go out on Tuesdays', { scope: 'project:widget' })

    expect(b.id).not.toBe(a.id)
    expect(b.scope).toBe('project:widget')
    expect(store.peek()).toHaveLength(2)
    // The other scope's engram was neither broadened nor escalated.
    const untouched = store.peek().find(e => e.id === a.id)!
    expect(untouched.scope).toBe('global')
    expect((untouched as any).recurrence_count).toBe(0)
  })

  it('still writes superseded_by back-edges without loading the corpus', async () => {
    const store = new CountingStore()
    const plur = new Plur({ path: tempDir(), store, autoDiscover: false })
    await plur.ready()

    const old = await plur.learn('the old way of configuring the linter', { scope: 'global' })
    store.resetCounts()

    const fresh = await plur.learn('the new way of configuring the linter', {
      scope: 'global',
      supersedes: [old.id],
    })

    expect(store.fullLoads).toBe(0)
    const stored = store.peek().find(e => e.id === old.id)!
    expect(stored.relations?.superseded_by).toContain(fresh.id)
  })

  it('does not lose the corpus when the derive seams arrive without the write seams', async () => {
    const store = new DeriveOnlyStore()
    const plur = new Plur({ path: tempDir(), store, autoDiscover: false })
    await plur.ready()

    for (let i = 0; i < 8; i++) {
      await plur.learn(`corpus engram ${i} about incident response`, { scope: 'global' })
    }
    expect(store.peek()).toHaveLength(8)

    await plur.learn('a ninth statement that must not eat the other eight', { scope: 'global' })

    expect(store.peek()).toHaveLength(9)
    // Delegation is OFF without the targeted-write seams: the engine still
    // loads the corpus, because the whole-corpus save is the only write it has.
    expect(store.fullLoads).toBeGreaterThan(0)
  })

  it('warns at attachment when only one of the derive seams is implemented', () => {
    const spy = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    try {
      class HalfDerive extends CountingStore {
        findActiveByContentHash = undefined as any
      }
      // eslint-disable-next-line no-new
      new Plur({ path: tempDir(), store: new HalfDerive(), autoDiscover: false })
      const hits = spy.mock.calls.filter(c => String(c[0]).includes('nextEngramId'))
      expect(hits.length).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('#828 YamlPrimaryStore behaviour is unchanged', () => {
  let dir: string
  beforeEach(() => { dir = tempDir() })

  it('deduplicates, allocates sequential ids, and graduates cross-scope recurrence', async () => {
    const store = new YamlPrimaryStore(join(dir, 'engrams.yaml'))
    const plur = new Plur({ path: dir, store, autoDiscover: false })
    await plur.ready()

    const day = new Date().toISOString().slice(0, 10)
    const first = await plur.learn('rollbacks are always announced in the channel', { scope: 'global' })
    expect(first.id).toBe(`ENG-${day}-001`)

    // Exact dedup in the same scope.
    const dup = await plur.learn('rollbacks are always announced in the channel', { scope: 'global' })
    expect(dup.id).toBe(first.id)
    expect((dup as any).reference_count).toBe(2)

    // Sequential allocation continues from the corpus.
    const second = await plur.learn('a different statement entirely', { scope: 'global' })
    expect(second.id).toBe(`ENG-${day}-002`)
  })

  it('graduates a cross-scope recurrence on the corpus-scanning path', async () => {
    const store = new YamlPrimaryStore(join(dir, 'engrams.yaml'))
    const plur = new Plur({ path: dir, store, autoDiscover: false })
    await plur.ready()

    const a = await plur.learn('secrets never go in the repo', { scope: 'project:alpha' })
    const b = await plur.learn('secrets never go in the repo', { scope: 'project:beta' })

    // Same engram, escalated — not a second row.
    expect(b.id).toBe(a.id)
    expect((b as any).recurrence_count).toBe(1)
    expect((await plur.list()).filter(e => e.status === 'active')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// #827 — feedback()
// ---------------------------------------------------------------------------

describe('#827 feedback() fetches by id', () => {
  it('performs no full-corpus load when the store implements loadByIds', async () => {
    const store = new CountingStore()
    const plur = new Plur({ path: tempDir(), store, autoDiscover: false })
    await plur.ready()

    const engram = await plur.learn('prefer explicit imports over barrel files', { scope: 'global' })
    for (let i = 0; i < 5; i++) {
      await plur.learn(`filler engram ${i} about code style`, { scope: 'global' })
    }
    store.resetCounts()

    await plur.feedback(engram.id, 'positive')

    expect(store.fullLoads).toBe(0)
    expect(store.loadByIdsCalls).toBe(1)
    const stored = store.peek().find(e => e.id === engram.id)!
    expect(stored.feedback_signals.positive).toBe(1)
  })

  it('leaves the rest of the corpus intact', async () => {
    const store = new CountingStore()
    const plur = new Plur({ path: tempDir(), store, autoDiscover: false })
    await plur.ready()

    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      ids.push((await plur.learn(`engram ${i} about observability`, { scope: 'global' })).id)
    }
    await plur.feedback(ids[2], 'negative')

    expect(store.peek()).toHaveLength(6)
    expect(store.peek().find(e => e.id === ids[2])!.feedback_signals.negative).toBe(1)
  })

  it('still falls through to a secondary store for an id the primary does not hold', async () => {
    const dir = tempDir()
    const storeDir = join(dir, 'stores')
    mkdirSync(storeDir, { recursive: true })
    const teamPath = join(storeDir, 'team.yaml')

    const store = new CountingStore()
    const plur = new Plur({ path: dir, store, autoDiscover: false })
    await plur.ready()

    // A secondary store engram, written directly so it does not pass through
    // the primary store at all.
    const teamEngram = await plur.learn('a statement that will move to the team store', { scope: 'group:team' })
    const raw = structuredClone(store.peek().find(e => e.id === teamEngram.id)!)
    writeFileSync(teamPath, dump({ engrams: [raw] }), 'utf8')
    await plur.forget(teamEngram.id, undefined, { force: true })
    plur.config.stores = [{ scope: 'group:team', path: teamPath }]

    const all = await plur.list()
    const namespaced = all.find(e => (e as any)._originalId === raw.id)!
    expect(namespaced).toBeDefined()

    await plur.feedback(namespaced.id, 'positive')

    // The primary store was consulted first and missed; the secondary took it.
    const reloaded = await plur.list()
    const after = reloaded.find(e => (e as any)._originalId === raw.id)!
    expect(after.feedback_signals.positive).toBe(1)
  })

  it('behaves identically on YamlPrimaryStore', async () => {
    const dir = tempDir()
    const store = new YamlPrimaryStore(join(dir, 'engrams.yaml'))
    const plur = new Plur({ path: dir, store, autoDiscover: false })
    await plur.ready()

    const engram = await plur.learn('run the smoke tests after publishing', { scope: 'global' })
    await plur.feedback(engram.id, 'positive')
    await plur.feedback(engram.id, 'negative')

    const stored = (await plur.list()).find(e => e.id === engram.id)!
    expect(stored.feedback_signals.positive).toBe(1)
    expect(stored.feedback_signals.negative).toBe(1)
  })

  it('does not delete the corpus on a store with loadByIds but no updateMany', async () => {
    const dir = tempDir()
    class HalfTargeted extends YamlPrimaryStore {
      async loadByIds(ids: string[]): Promise<Engram[]> {
        const all = await this.load()
        return all.filter(e => ids.includes(e.id))
      }
      // updateMany deliberately absent.
    }
    const store = new HalfTargeted(join(dir, 'engrams.yaml'))
    const plur = new Plur({ path: dir, store, autoDiscover: false })
    await plur.ready()

    const ids: string[] = []
    for (let i = 0; i < 7; i++) {
      ids.push((await plur.learn(`half-targeted engram ${i} about caching`, { scope: 'global' })).id)
    }

    await plur.feedback(ids[0], 'positive')

    expect((await plur.list())).toHaveLength(7)
  })
})
