/**
 * `repairContentHashes` must not destroy a concurrent write (#852, follow-up).
 *
 * The first cut of this repair lived in `plur reindex-hashes` and did
 * `loadEngrams()` → mutate → `saveEngrams()` with NO lock. The 2026-08-13
 * data-loss audit reproduced the loss 6/6 on a 4,642-engram store: a
 * correctly-locked writer appends between the load and the save, the save puts
 * the pre-append snapshot back, and the engram is gone. Silently — the shrink
 * guard cannot see it either, because the same count goes out that came in.
 *
 * So the interesting property is not "does it fix the hash". It is "does it
 * fix the hash WITHOUT reverting whatever else happened while it ran", and
 * that is only true if the load and the save are inside the same store lock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, YamlPrimaryStore, detectPlurStorage, loadEngrams, saveEngrams, computeContentHash, withAsyncLock } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'

/** A schema-valid engram whose `content_hash` matches its statement. */
function fixture(id: string): Engram {
  const statement = `deployment note for ${id}`
  return {
    id, version: 2, status: 'active', consolidated: false,
    type: 'behavioral', scope: 'global', visibility: 'private',
    statement,
    activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-08-13' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], pack: null,
    abstract: null, derived_from: null, polarity: null,
    content_hash: computeContentHash(statement),
    commitment: 'leaning', write_count: 1, injection_count: 0, sources: [], recurrence_count: 0,
    summary: 's', engram_version: 1, episode_ids: [],
    temporal: { learned_at: '2026-08-13' },
  } as unknown as Engram
}

describe('repairContentHashes (#852)', () => {
  let dir: string
  let plur: Plur
  let storePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-hash-repair-'))
    plur = new Plur({ path: dir })
    storePath = detectPlurStorage(dir).engrams
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Write a stale `content_hash` onto a stored engram, out of band. */
  function makeStale(id: string): void {
    const corpus = loadEngrams(storePath)
    const target = corpus.find(e => e.id === id)!
    ;(target as { content_hash?: string }).content_hash = computeContentHash('something else entirely')
    saveEngrams(storePath, corpus)
  }

  it('reports stale and missing separately, and writes nothing without --apply', async () => {
    const a = await plur.learn('deploy staging with docker compose', { scope: 'global', type: 'procedural' })
    makeStale(a.id)

    const before = loadEngrams(storePath)
    const report = await plur.repairContentHashes({})

    expect(report.stale.map(s => s.id)).toEqual([a.id])
    expect(report.repaired).toBe(0)
    expect(loadEngrams(storePath), 'a read-only scan must not touch the store').toEqual(before)
  })

  it('--apply rewrites the hash so it matches the statement again', async () => {
    const a = await plur.learn('rebase before pushing on this repo', { scope: 'global', type: 'behavioral' })
    makeStale(a.id)

    const report = await plur.repairContentHashes({ apply: true })
    expect(report.repaired).toBe(1)

    const fixed = loadEngrams(storePath).find(e => e.id === a.id)!
    expect((fixed as { content_hash?: string }).content_hash)
      .toBe(computeContentHash(fixed.statement))
  })

  it('does NOT destroy an engram written while the repair was in flight', async () => {
    // The discriminating case, and the one the audit measured.
    //
    // Two details are load-bearing and were both wrong in a first draft of this
    // test, which passed with the fix reverted and so proved nothing:
    //
    //  1. The corpus is 20 engrams, not 2. At 20-in / 21-on-disk the shrink
    //     guard does NOT fire (5% < the 10% tolerance) — which is precisely why
    //     the audit's loss was SILENT. A two-engram corpus is a 50% shrink, so
    //     the guard catches it and the test would be asserting the wrong thing.
    //  2. `load()` takes a beat. Parsing a real store is hundreds of
    //     milliseconds; with an instantaneous load the unlocked repair finishes
    //     its whole read-modify-write in one microtask drain and never overlaps
    //     the concurrent writer at all. The delay is what opens the window that
    //     exists in production.
    const corpus = Array.from({ length: 20 }, (_, i) => fixture(`ENG-SEED-${i}`))
    ;(corpus[0] as { content_hash?: string }).content_hash = computeContentHash('something else entirely')
    saveEngrams(storePath, corpus)

    class SlowYamlStore extends YamlPrimaryStore {
      async load(): Promise<Engram[]> {
        const rows = await super.load()
        await new Promise(resolve => setTimeout(resolve, 20))
        return rows
      }
    }
    const engine = new Plur({ path: dir, store: new SlowYamlStore(storePath) })

    // Hold the store lock, kick off the repair (which must QUEUE behind us),
    // then commit the victim before releasing. A locked repair loads after we
    // are done and sees it; an unlocked one loaded before it existed and puts
    // that stale snapshot back.
    //
    // The promise is deliberately parked in an outer binding rather than
    // returned from the callback: `withAsyncLock` awaits its callback's result,
    // so returning it would await the queued repair while still holding the
    // lock the repair is waiting for.
    let repair!: Promise<unknown>
    await withAsyncLock(storePath, async () => {
      repair = engine.repairContentHashes({ apply: true })
      await new Promise(resolve => setTimeout(resolve, 5))
      const current = loadEngrams(storePath)
      current.push(fixture('ENG-VICTIM-001'))
      saveEngrams(storePath, current)
    })
    await repair

    const after = loadEngrams(storePath)
    expect(after.map(e => e.id), 'the concurrent write must survive the repair').toContain('ENG-VICTIM-001')
    const seed = after.find(e => e.id === 'ENG-SEED-0')!
    expect((seed as { content_hash?: string }).content_hash, 'and the repair must still have happened')
      .toBe(computeContentHash(seed.statement))
  })

  it('refuses to write on a readonly engine', async () => {
    const a = await plur.learn('the fixture statement', { scope: 'global', type: 'terminological' })
    makeStale(a.id)

    const ro = new Plur({ path: dir, readonly: true })
    await expect(ro.repairContentHashes({ apply: true })).rejects.toThrow()
    // …but reporting still works, which is what the CLI's default mode uses.
    const report = await ro.repairContentHashes({})
    expect(report.stale.map(s => s.id)).toEqual([a.id])
  })
})
