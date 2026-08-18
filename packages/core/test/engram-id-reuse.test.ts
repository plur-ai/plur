/**
 * #816 — a freed engram id must never be minted again.
 *
 * `generateEngramId` allocated by scanning the corpus for the highest same-day
 * suffix. The corpus was therefore the only record of what had been handed
 * out — and `compact()` REMOVES rows, so removing the highest-numbered engram
 * of a day freed exactly that id for the next `learn()`.
 *
 * The harm is not the collision itself but everything keyed by id that
 * outlives the corpus entry: `history.jsonl` narrates one life story out of
 * two, a restore diff reads a substitution as an edit, a `supersedes` edge
 * silently re-targets, and an outbox or remote row points at the wrong fact.
 * None of it is detectable afterwards — nothing records that the id changed
 * hands.
 *
 * The fix reads the append-only history log, which never forgets, rather than
 * adding new state that could drift from the corpus. It is one-directional by
 * construction: extra allocation records can only push the next suffix higher,
 * so an incomplete log degrades to the old behaviour and can never manufacture
 * a collision the old behaviour would have avoided.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { generateEngramId } from '../src/engrams.js'
import { mintedIdsWithPrefix, readHistoryForEngram } from '../src/history.js'
import type { Engram } from '../src/schemas/engram.js'

describe('engram ids are never reused after compaction (#816)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-816-')); plur = new Plur({ path: dir }) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a compacted id is not handed to the next engram', async () => {
    // The reproduction. Retire the newest engram, compact it away, and learn
    // again — the old allocator returned the id it had just freed.
    const a = await plur.learn('the first fact of the day', { scope: 'global', type: 'behavioral' })
    const b = await plur.learn('the second fact of the day', { scope: 'global', type: 'behavioral' })
    expect(b.id).not.toBe(a.id)

    await plur.forget(b.id, 'making room', { scope: 'primary', force: true })
    await plur.compact()

    const c = await plur.learn('a third, unrelated fact', { scope: 'global', type: 'behavioral' })
    expect(c.id, `reused ${b.id} — two different engrams now share one id`).not.toBe(b.id)
    expect(c.id).not.toBe(a.id)
  })

  it('history for the freed id describes one engram, not two', async () => {
    // The harm, asserted directly rather than through the id. This is what
    // `plur history <id>` reads, and it is where the interleaving showed.
    const a = await plur.learn('a fact that will be compacted away', { scope: 'global', type: 'behavioral' })
    await plur.forget(a.id, 'gone', { scope: 'primary', force: true })
    await plur.compact()
    await plur.learn('an entirely unrelated later fact', { scope: 'global', type: 'behavioral' })

    const events = readHistoryForEngram(dir, a.id)
    const creations = events.filter(e => e.event === 'engram_created')
    expect(creations, 'two creations under one id is the interleaving').toHaveLength(1)
  })

  it('survives repeated retire-compact-learn cycles', async () => {
    // One cycle can pass by luck; the allocator has to stay monotonic.
    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const e = await plur.learn(`cycle fact number ${i}`, { scope: 'global', type: 'behavioral' })
      expect(seen.has(e.id), `id ${e.id} was minted twice`).toBe(false)
      seen.add(e.id)
      await plur.forget(e.id, 'cycling', { scope: 'primary', force: true })
      await plur.compact()
    }
    expect(seen.size).toBe(5)
  })

  it('history records the allocation, which is what makes this work', async () => {
    const a = await plur.learn('a fact whose id must stay claimed', { scope: 'global', type: 'behavioral' })
    const day = new Date().toISOString().slice(0, 10)
    const minted = mintedIdsWithPrefix(dir, day.slice(0, 7), [`ENG-${day}-`])
    expect(minted, 'the allocation was not recorded — the fix has nothing to read').toContain(a.id)
  })

  it('stays monotonic even when history is unreadable', async () => {
    // The in-process claim, added with the cache. `appendHistory` is
    // best-effort at several call sites, so allocation cannot depend on the
    // log having been written — and two writes in the same tick must not both
    // read a history that neither has appended to yet.
    const a = await plur.learn('first fact before history breaks', { scope: 'global', type: 'behavioral' })
    // Make the log unreadable: a directory where the month file should be.
    const monthFile = join(dir, 'history', `${new Date().toISOString().slice(0, 7)}.jsonl`)
    rmSync(monthFile, { force: true })
    mkdirSync(monthFile, { recursive: true })

    const b = await plur.learn('second fact with history broken', { scope: 'global', type: 'behavioral' })
    const c = await plur.learn('third fact with history broken', { scope: 'global', type: 'behavioral' })

    expect(new Set([a.id, b.id, c.id]).size, 'ids collided once history stopped being readable').toBe(3)
  })

  it('two writes in the same tick get different ids', async () => {
    // Concurrent within one process: both would read the same corpus and the
    // same history, so only the in-process claim separates them.
    const [x, y] = await Promise.all([
      plur.learn('one of two simultaneous facts', { scope: 'global', type: 'behavioral' }),
      plur.learn('the other of two simultaneous facts', { scope: 'global', type: 'behavioral' }),
    ])
    expect(x.id).not.toBe(y.id)
  })

  describe('the allocator itself', () => {
    const engram = (id: string): Engram => ({ id } as unknown as Engram)
    const today = new Date().toISOString().slice(0, 10)

    it('is purely additive — extra ids can only raise the suffix', () => {
      const corpus = [engram(`ENG-${today}-001`)]
      const withoutHistory = generateEngramId(corpus)
      const withHistory = generateEngramId(corpus, [`ENG-${today}-009`])
      expect(withoutHistory).toBe(`ENG-${today}-002`)
      expect(withHistory, 'the freed id 009 must still be respected').toBe(`ENG-${today}-010`)
    })

    it('an empty or incomplete history degrades to the corpus answer', () => {
      // The safety property: a missing history record is not a new hazard, it
      // is the status quo. `appendHistory` is best-effort at several call
      // sites, so this has to hold.
      const corpus = [engram(`ENG-${today}-003`)]
      expect(generateEngramId(corpus, [])).toBe(generateEngramId(corpus))
    })

    it('ignores ids from other days', () => {
      const corpus = [engram(`ENG-${today}-001`)]
      expect(generateEngramId(corpus, ['ENG-2020-01-01-999'])).toBe(`ENG-${today}-002`)
    })
  })
})
