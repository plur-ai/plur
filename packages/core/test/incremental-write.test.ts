import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, MemoryPrimaryStore, YamlPrimaryStore, type PrimaryStore } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'

/**
 * Engine-level contract of the incremental write seam (#740).
 *
 * Two properties, one per store shape:
 *
 * 1. CAPABILITY store (append + updateMany): single-engram writes go through
 *    the targeted methods — `save()` (whole-corpus replace) is never called
 *    for a learn/feedback/pin/forget — and multi-row side-effects
 *    (superseded_by back-edges) are persisted through `updateMany`, the SAME
 *    machinery recall's activation refresh uses (#749/#755).
 *
 * 2. FALLBACK store (YAML — no capabilities): the engine reuses the corpus it
 *    already loaded under the store lock. Cost must equal the pre-seam write
 *    path exactly: one save per write, NO additional load. (#745's first cut
 *    made YamlPrimaryStore.append re-parse the corpus the caller had just
 *    loaded — learn() went from 2 parses to 3, feedback from 1 to 2. This
 *    file is the regression guard for that.)
 */

/** Delegating wrapper that counts calls without adding any capabilities. */
class CountingYamlStore implements PrimaryStore {
  readonly kind = 'yaml' as const
  loads = 0
  cachedLoads = 0
  saves = 0
  constructor(private readonly inner: YamlPrimaryStore) {}
  get location(): string | null { return this.inner.location }
  async load(): Promise<Engram[]> { this.loads++; return this.inner.load() }
  async loadCached(): Promise<Engram[]> { this.cachedLoads++; return this.inner.loadCached() }
  async save(engrams: Engram[]): Promise<void> { this.saves++; return this.inner.save(engrams) }
  invalidate(): void { this.inner.invalidate() }
  reset(): void { this.loads = 0; this.cachedLoads = 0; this.saves = 0 }
}

describe('incremental write seam through Plur (#740)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-incr-write-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  describe('capability store (MemoryPrimaryStore)', () => {
    it('learn() appends the new engram — save() is never called', async () => {
      const store = new MemoryPrimaryStore()
      const append = vi.spyOn(store, 'append')
      const save = vi.spyOn(store, 'save')
      const plur = new Plur({ path: dir, store })
      await plur.ready()
      const e = await plur.learn('use PostgreSQL for production', { type: 'behavioral' })
      expect(append).toHaveBeenCalledTimes(1)
      expect(append.mock.calls[0][0].id).toBe(e.id)
      expect(save).not.toHaveBeenCalled()
    })

    it('feedback() routes through updateMany with exactly the rated engram', async () => {
      const store = new MemoryPrimaryStore()
      const plur = new Plur({ path: dir, store })
      await plur.ready()
      const e = await plur.learn('always run tests before merging', { type: 'behavioral' })
      const updateMany = vi.spyOn(store, 'updateMany')
      const save = vi.spyOn(store, 'save')
      await plur.feedback(e.id, 'positive')
      expect(updateMany).toHaveBeenCalledTimes(1)
      expect(updateMany.mock.calls[0][0].map(x => x.id)).toEqual([e.id])
      expect(save).not.toHaveBeenCalled()
      expect((await plur.getById(e.id))?.feedback_signals.positive).toBe(1)
    })

    it('forget() and setPinned() take the targeted path too', async () => {
      const store = new MemoryPrimaryStore()
      const plur = new Plur({ path: dir, store })
      await plur.ready()
      const e = await plur.learn('prefer functional React components', { type: 'behavioral' })
      const updateMany = vi.spyOn(store, 'updateMany')
      const save = vi.spyOn(store, 'save')
      await plur.setPinned(e.id, true)
      await plur.forget(e.id)
      expect(updateMany).toHaveBeenCalledTimes(2)
      expect(save).not.toHaveBeenCalled()
      expect((await plur.getById(e.id))?.status).toBe('retired')
    })

    it('learn with supersedes persists the reverse edges via updateMany (the ffe04e0 regression)', async () => {
      // On a targeted-append store the new engram's INSERT does not carry the
      // mutated targets with it — dropping this updateMany loses the
      // superseded_by back-edges exactly as #745's first incremental cut did.
      const store = new MemoryPrimaryStore()
      const plur = new Plur({ path: dir, store })
      await plur.ready()
      const oldE = await plur.learn('plur cli version is 0.3.0')
      const updateMany = vi.spyOn(store, 'updateMany')
      const newE = await plur.learn('plur cli version is 0.16.1', { supersedes: [oldE.id] })
      expect(updateMany.mock.calls.some(c => c[0].some(x => x.id === oldE.id))).toBe(true)
      const reloaded = await plur.getById(oldE.id)
      expect(reloaded?.relations?.superseded_by).toEqual([newE.id])
    })

    it('duplicate learn (dedup hit) updates the counted engram, no corpus replace', async () => {
      const store = new MemoryPrimaryStore()
      const plur = new Plur({ path: dir, store })
      await plur.ready()
      const first = await plur.learn('deploy via blue-green strategy')
      const updateMany = vi.spyOn(store, 'updateMany')
      const save = vi.spyOn(store, 'save')
      const dup = await plur.learn('deploy via blue-green strategy')
      expect(dup.id).toBe(first.id)
      expect(updateMany).toHaveBeenCalledTimes(1)
      expect(save).not.toHaveBeenCalled()
    })
  })

  describe('fallback store (YAML — no capabilities)', () => {
    it('learn() costs one save and one authoritative load — no re-parse from the write', async () => {
      const counting = new CountingYamlStore(new YamlPrimaryStore(join(dir, 'engrams.yaml')))
      const plur = new Plur({ path: dir, store: counting })
      await plur.ready()
      counting.reset()
      await plur.learn('use PostgreSQL for production', { type: 'behavioral' })
      // learn(): one load() under the lock + one loadCached() for the merged
      // dedup view — then the write itself reuses that corpus. saves === 1 and
      // loads === 1 is the pre-seam cost; a store-level append that re-parsed
      // would show as loads === 2.
      expect(counting.saves).toBe(1)
      expect(counting.loads).toBe(1)
      expect(counting.cachedLoads).toBeLessThanOrEqual(2)
    })

    it('feedback() costs one save and one load — same as before the seam', async () => {
      const counting = new CountingYamlStore(new YamlPrimaryStore(join(dir, 'engrams.yaml')))
      const plur = new Plur({ path: dir, store: counting })
      await plur.ready()
      const e = await plur.learn('always run tests before merging', { type: 'behavioral' })
      counting.reset()
      await plur.feedback(e.id, 'positive')
      expect(counting.saves).toBe(1)
      expect(counting.loads).toBe(1)
    })

    it('learn with supersedes still writes the corpus ONCE — back-edges ride along', async () => {
      const counting = new CountingYamlStore(new YamlPrimaryStore(join(dir, 'engrams.yaml')))
      const plur = new Plur({ path: dir, store: counting })
      await plur.ready()
      const oldE = await plur.learn('plur cli version is 0.3.0')
      counting.reset()
      const newE = await plur.learn('plur cli version is 0.16.1', { supersedes: [oldE.id] })
      // The fallback save carries the mutated targets with the corpus — k
      // superseded targets must NOT cost k extra writes (or any extra parse).
      expect(counting.saves).toBe(1)
      expect(counting.loads).toBe(1)
      expect((await plur.getById(oldE.id))?.relations?.superseded_by).toEqual([newE.id])
    })
  })
})
