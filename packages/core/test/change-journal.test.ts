/**
 * Shared change journal (overhaul W0, plan revisions D1 and R2).
 *
 * Every store operation that must be undoable — consolidation, the pin audit,
 * rescope, enrichment — goes through one primitive: a change records full
 * before-snapshots of each row it touches (and "absent" for each row it
 * creates), applies under the store lock, and can be undone exactly. Undo
 * refuses, naming the rows, when a touched row no longer holds what the change
 * wrote.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur, MemoryPrimaryStore } from '../src/index.js'
import {
  ChangeConflictError,
  ChangeNotFoundError,
  ChangeAlreadyUndoneError,
  ChangeJournalUnsupportedError,
  readChangeJournal,
  changeJournalPath,
} from '../src/change-journal.js'
import type { Engram } from '../src/schemas/engram.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('change journal', () => {
  let dir: string
  let plur: Plur
  let a: Engram
  let b: Engram
  let c: Engram

  const storeBytes = () => readFileSync(join(dir, 'engrams.yaml'), 'utf8')

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-change-journal-'))
    plur = new Plur({ path: dir, autoDiscover: false })
    a = await plur.learn('Use pnpm, not npm, in this repository', { scope: 'global', domain: 'dev' })
    b = await plur.learn('Run the full test suite before committing', { scope: 'global', domain: 'dev' })
    c = await plur.learn('Release notes name every behaviour change', { scope: 'global', domain: 'dev' })
    // Any whole-corpus write stores every row in the loader's key order; the
    // row `learn` just wrote is still in the order learn built it. Normalise
    // once so "byte for byte" compares rows, not a key-order artefact that
    // every PLUR write (not just the journal) would change.
    c = (await plur.updateEngramAsync((await plur.getById(c.id))!))!
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('records before-snapshots and undo restores the store byte for byte', async () => {
    const before = storeBytes()
    const change = plur.beginChange('test.edit', { reason: 'unit test' })
    expect(change.id).toMatch(/^CHG-/)
    const record = await change.apply(tx => {
      const ra = tx.get(a.id)!
      tx.put({ ...ra, statement: 'Use pnpm in this repository (merged)' })
      const rb = tx.get(b.id)!
      tx.put({ ...rb, status: 'retired' })
    })
    expect(record.id).toBe(change.id)
    expect(record.kind).toBe('test.edit')
    expect(record.rows.map(r => r.id).sort()).toEqual([a.id, b.id].sort())
    const snapA = record.rows.find(r => r.id === a.id)!
    expect(snapA.before).toMatchObject({ id: a.id, statement: a.statement })
    expect(snapA.after).toMatchObject({ statement: 'Use pnpm in this repository (merged)' })
    expect(storeBytes()).not.toBe(before)
    expect((await plur.getById(b.id))?.status).toBe('retired')

    await plur.undoChange(change.id)
    expect(storeBytes()).toBe(before)
    expect((await plur.getById(a.id))?.statement).toBe(a.statement)
  })

  it('refuses to undo when a touched row changed after the apply, naming the row', async () => {
    const change = plur.beginChange('test.edit')
    await change.apply(tx => {
      tx.put({ ...tx.get(a.id)!, statement: 'Changed by the change' })
      tx.put({ ...tx.get(c.id)!, tags: ['touched'] })
    })
    const current = (await plur.getById(a.id))!
    await plur.updateEngram({ ...current, statement: 'Edited later by someone else' })
    const afterEdit = storeBytes()

    let err: unknown
    try { await plur.undoChange(change.id) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ChangeConflictError)
    const conflict = err as ChangeConflictError
    expect(conflict.rows.map(r => r.id)).toEqual([a.id])
    expect(conflict.message).toContain(a.id)
    // A refused undo writes nothing.
    expect(storeBytes()).toBe(afterEdit)
    expect((await plur.getById(c.id))?.tags).toEqual(['touched'])
  })

  it('undo is not blocked by bookkeeping (recall, inject, feedback) and keeps the counts made since', async () => {
    const change = plur.beginChange('test.edit')
    await change.apply(tx => { tx.put({ ...tx.get(a.id)!, statement: 'Use pnpm in this repository, never npm' }) })
    // Ordinary use after the apply: recall (activation, co-access), inject
    // (injection_count) and feedback all touch the row.
    await plur.recall('pnpm repository test suite committing', { limit: 5 })
    await plur.inject('use pnpm in this repository and run the test suite')
    await plur.feedback(a.id, 'positive')
    const used = (await plur.getById(a.id))!
    const changeAfter = plur.getChange(change.id)!.rows[0].after!
    // Bookkeeping moved, so a strict comparison would refuse.
    expect(JSON.stringify(used.feedback_signals)).not.toBe(JSON.stringify(changeAfter.feedback_signals))

    await plur.undoChange(change.id)
    const restored = (await plur.getById(a.id))!
    expect(restored.statement).toBe(a.statement)
    expect(restored.feedback_signals).toEqual(used.feedback_signals)
    expect(restored.injection_count).toBe(used.injection_count)
    expect(restored.activation).toEqual(used.activation)
  })

  it('keeps bookkeeping written directly since the apply (counters, sources)', async () => {
    const change = plur.beginChange('test.edit')
    await change.apply(tx => { tx.put({ ...tx.get(a.id)!, statement: 'Changed by the change' }) })
    const now = (await plur.getById(a.id))!
    const bumped = {
      ...now,
      injection_count: (now.injection_count ?? 0) + 3,
      write_count: (now.write_count ?? 1) + 1,
      recurrence_count: 2,
      sources: [...(now.sources ?? []), { scope: 'global', session_id: null, stored_at: '2026-11-11T00:00:00.000Z' }],
      associations: [...(now.associations ?? []), { target_type: 'engram', target: b.id, type: 'co_accessed', strength: 0.3, updated_at: '2026-11-11' }],
    } as Engram
    // Write the row the way the bookkeeping paths do (no updated_at stamp).
    const bk = plur.beginChange('test.bookkeeping')
    await bk.apply(tx => { tx.put(bumped) })
    await plur.undoChange(change.id)
    const restored = (await plur.getById(a.id))!
    expect(restored.statement).toBe(a.statement)
    expect(restored.injection_count).toBe(bumped.injection_count)
    expect(restored.write_count).toBe(bumped.write_count)
    expect(restored.recurrence_count).toBe(2)
    expect(restored.sources).toHaveLength(bumped.sources.length)
    expect(restored.associations.filter(x => x.type === 'co_accessed').map(x => x.target)).toEqual([b.id])
  })

  it('an explicit empty ignoreFields still counts bookkeeping as drift', async () => {
    const change = plur.beginChange('test.edit')
    await change.apply(tx => { tx.put({ ...tx.get(a.id)!, statement: 'Changed by the change' }) })
    const now = (await plur.getById(a.id))!
    await plur.updateEngramAsync({ ...now, injection_count: (now.injection_count ?? 0) + 1 })
    await expect(plur.undoChange(change.id, { ignoreFields: [] })).rejects.toBeInstanceOf(ChangeConflictError)
  })

  it('history logs a change that retires a row as engram_retired, not engram_updated (finding 5)', async () => {
    const change = plur.beginChange('test.retire')
    await change.apply(tx => { tx.put({ ...tx.get(b.id)!, status: 'retired' }) })
    const events = plur.getEngramHistory(b.id).filter(e => (e.data as any)?.change_id === change.id)
    expect(events.map(e => e.event)).toEqual(['engram_retired'])
  })

  it('undoes a change that created a row by removing that row', async () => {
    const before = storeBytes()
    const newId = 'ENG-2026-1110-901'
    const change = plur.beginChange('test.create')
    const record = await change.apply(tx => {
      tx.put({ ...tx.get(a.id)!, id: newId, statement: 'A merged engram created by the change' })
    })
    expect(record.rows).toHaveLength(1)
    expect(record.rows[0].before).toBeNull()
    expect((await plur.getById(newId))?.statement).toBe('A merged engram created by the change')

    await plur.undoChange(change.id)
    expect(await plur.getById(newId)).toBeNull()
    expect(storeBytes()).toBe(before)
  })

  it('undoes a change that removed a row by putting it back in place', async () => {
    const before = storeBytes()
    const change = plur.beginChange('test.remove')
    await change.apply(tx => { tx.remove(b.id) })
    expect(await plur.getById(b.id)).toBeNull()
    await plur.undoChange(change.id)
    expect(storeBytes()).toBe(before)
  })

  it('keeps the journal across a restart: a reopened store can list and undo the change', async () => {
    const before = storeBytes()
    const change = plur.beginChange('test.edit', { batch: 1 })
    await change.apply(tx => { tx.put({ ...tx.get(a.id)!, statement: 'Persisted change' }) })
    expect(existsSync(changeJournalPath(dir))).toBe(true)

    const reopened = new Plur({ path: dir, autoDiscover: false })
    const listed = reopened.listChanges()
    expect(listed.map(r => r.id)).toContain(change.id)
    expect(reopened.getChange(change.id)?.meta).toEqual({ batch: 1 })
    await reopened.undoChange(change.id)
    expect(storeBytes()).toBe(before)

    // The journal is append-only: the undo is a new record, the original stays.
    const records = readChangeJournal(dir)
    expect(records.filter(r => r.id === change.id)).toHaveLength(1)
    const undo = records.find(r => r.kind === 'undo')!
    expect(undo.meta).toMatchObject({ undoes: change.id })
    expect(reopened.getChange(change.id)?.undone_by).toBe(undo.id)
  })

  it('refuses a second undo of the same change, and an unknown id', async () => {
    const change = plur.beginChange('test.edit')
    await change.apply(tx => { tx.put({ ...tx.get(a.id)!, statement: 'Once' }) })
    await plur.undoChange(change.id)
    await expect(plur.undoChange(change.id)).rejects.toBeInstanceOf(ChangeAlreadyUndoneError)
    await expect(plur.undoChange('CHG-does-not-exist')).rejects.toBeInstanceOf(ChangeNotFoundError)
  })

  it('a change applies once only', async () => {
    const change = plur.beginChange('test.edit')
    await change.apply(tx => { tx.put({ ...tx.get(a.id)!, statement: 'Once' }) })
    await expect(change.apply(() => {})).rejects.toThrow(/already/)
  })

  it('a throwing apply writes nothing to the store or the journal', async () => {
    const before = storeBytes()
    const change = plur.beginChange('test.edit')
    await expect(change.apply(tx => {
      tx.put({ ...tx.get(a.id)!, statement: 'Never written' })
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(storeBytes()).toBe(before)
    expect(readChangeJournal(dir).filter(r => r.id === change.id && r.state === 'committed')).toHaveLength(0)
  })

  it('serializes concurrent changes through the store lock (two instances, one store)', async () => {
    const other = new Plur({ path: dir, autoDiscover: false })
    const bump = (p: Plur) => p.beginChange('test.bump').apply(async tx => {
      const row = tx.get(a.id)!
      const n = Number((row.structured_data as any)?.counter ?? 0)
      // Yield inside the critical section: without the lock both would read 0.
      await sleep(40)
      tx.put({ ...row, structured_data: { ...(row.structured_data ?? {}), counter: n + 1 } })
    })
    const [r1, r2] = await Promise.all([bump(plur), bump(other)])
    const final = (await new Plur({ path: dir, autoDiscover: false }).getById(a.id))!
    expect((final.structured_data as any).counter).toBe(2)

    // Each change saw the other's write as its before-state, never the same base.
    const befores = [r1, r2].map(r => Number((r.rows[0].before?.structured_data as any)?.counter ?? 0)).sort()
    expect(befores).toEqual([0, 1])

    // The earlier change is now covered by the later one: its undo refuses.
    const firstSawZero = Number((r1.rows[0].before?.structured_data as any)?.counter ?? 0) === 0
    const [first, second] = firstSawZero ? [r1, r2] : [r2, r1]
    await expect(plur.undoChange(first.id)).rejects.toBeInstanceOf(ChangeConflictError)
    await plur.undoChange(second.id)
    await plur.undoChange(first.id)
    expect((await plur.getById(a.id))?.structured_data).toEqual(a.structured_data)
  })

  it('refuses a store that is not the local YAML primary', async () => {
    const memDir = mkdtempSync(join(tmpdir(), 'plur-change-journal-mem-'))
    try {
      const mem = new Plur({ path: memDir, store: new MemoryPrimaryStore(), autoDiscover: false })
      await expect(mem.beginChange('test.edit').apply(() => {})).rejects.toBeInstanceOf(ChangeJournalUnsupportedError)
    } finally {
      rmSync(memDir, { recursive: true, force: true })
    }
  })

  it('refuses rows that belong to a secondary or remote store', async () => {
    await expect(plur.beginChange('test.edit').apply(tx => {
      tx.put({ ...tx.get(a.id)!, id: 'ENG-TEAMX-2026-1110-001' })
    })).rejects.toBeInstanceOf(ChangeJournalUnsupportedError)
  })

  it('refuses on a read-only instance', async () => {
    const ro = new Plur({ path: dir, autoDiscover: false, readonly: true })
    await expect(ro.beginChange('test.edit').apply(() => {})).rejects.toThrow()
  })
})
