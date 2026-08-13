/**
 * A store that implements `loadByIds` but not `updateMany` must not lose its
 * corpus to an ordinary recall.
 *
 * `_reactivateResults` used to pick the two independently:
 *
 *   const allEngrams = store.loadByIds ? await store.loadByIds(resultIds) : await load()
 *   ...
 *   if (store.updateMany) await store.updateMany(touched)
 *   else await this._writeEngrams(path, allEngrams)   // FULL REPLACE
 *
 * With `loadByIds` present and `updateMany` absent, `allEngrams` is only the
 * recalled handful and it goes to a whole-file replace — so a read deletes
 * every engram that was not in the current page of results.
 *
 * Both methods are optional on `PrimaryStore`. Implementing the cheap targeted
 * READ first is the obvious order to build them in, and it is the one that
 * destroys data. No in-tree store does this (Postgres has both, YAML has
 * neither), so nothing would have caught it until someone wrote a store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import { YamlPrimaryStore } from '../src/store/yaml-primary-store.js'
import { logger } from '../src/logger.js'
import type { Engram } from '../src/schemas/engram.js'

/**
 * A YAML store with `loadByIds` bolted on and NO `updateMany` — exactly the
 * half-implemented shape the interface permits.
 */
class HalfTargetedStore extends YamlPrimaryStore {
  loadByIdsCalls = 0
  async loadByIds(ids: string[]): Promise<Engram[]> {
    this.loadByIdsCalls++
    const all = await this.load()
    return all.filter(e => ids.includes(e.id))
  }
  // updateMany deliberately absent.
}

describe('a store with loadByIds but no updateMany', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-halfstore-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('does not delete the rest of the corpus on recall', async () => {
    const store = new HalfTargetedStore(join(dir, 'engrams.yaml'))
    const plur = new Plur({ path: dir, store })
    await plur.ready()

    for (let i = 0; i < 12; i++) {
      await plur.learn(`engram number ${i} about deployment and rollout`, { scope: 'global' })
    }
    const before = (await plur.list()).length
    expect(before).toBe(12)

    // An ordinary read. Recall reactivates, which is a write.
    const hits = await plur.recall('deployment', { limit: 3 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThan(before)

    const after = await plur.list()
    expect(
      after.length,
      'recall deleted every engram outside its own result page',
    ).toBe(before)
  })

  it('survives repeated recalls', async () => {
    // The failure compounds: each recall would shrink the corpus to its own
    // result set, so a second recall over a smaller corpus shrinks it further.
    const store = new HalfTargetedStore(join(dir, 'engrams.yaml'))
    const plur = new Plur({ path: dir, store })
    await plur.ready()
    for (let i = 0; i < 10; i++) {
      await plur.learn(`rollout note ${i} for the billing service`, { scope: 'global' })
    }
    for (let i = 0; i < 3; i++) await plur.recall('rollout billing', { limit: 2 })
    expect((await plur.list()).length).toBe(10)
  })

  it('still reactivates — the guard must not skip the work', async () => {
    // Without this, "never take the targeted path" would pass the tests above
    // while silently disabling activation updates.
    const store = new HalfTargetedStore(join(dir, 'engrams.yaml'))
    const plur = new Plur({ path: dir, store })
    await plur.ready()
    const e = await plur.learn('a statement about kubernetes autoscaling', { scope: 'global' })
    const freqBefore = (await plur.getById(e.id))!.activation.frequency

    await plur.recall('kubernetes autoscaling', { limit: 5 })

    const freqAfter = (await plur.getById(e.id))!.activation.frequency
    expect(freqAfter, 'recall no longer reactivates').toBeGreaterThan(freqBefore)
  })
})

describe('the capability pair is called out at attachment (#752)', () => {
  // The call-site guard makes a split store SAFE; the constructor makes it
  // VISIBLE. A store implementing exactly one of loadByIds/updateMany is
  // almost certainly an implementation mistake — the pair is used together or
  // not at all — and the implementor should hear that where they are looking,
  // not in a JSDoc they may never read.
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-pairwarn-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('warns once when exactly one of loadByIds/updateMany is supplied', () => {
    const spy = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    try {
      void new Plur({ path: dir, store: new HalfTargetedStore(join(dir, 'engrams.yaml')) })
      const pairWarnings = spy.mock.calls.filter(c => String(c[0]).includes('loadByIds'))
      expect(pairWarnings).toHaveLength(1)
      expect(String(pairWarnings[0][0])).toContain('updateMany')
    } finally {
      spy.mockRestore()
    }
  })

  it('stays silent for a store implementing neither — YAML-shaped stores are the norm', () => {
    const spy = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    try {
      void new Plur({ path: dir, store: new YamlPrimaryStore(join(dir, 'engrams.yaml')) })
      expect(spy.mock.calls.filter(c => String(c[0]).includes('loadByIds'))).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})
