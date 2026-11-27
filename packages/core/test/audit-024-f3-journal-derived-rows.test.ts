/**
 * Security audit 024, finding 3: once a row is forgotten, no change-journal
 * snapshot keeps its content, including snapshots of rows derived from it.
 *
 * A consolidation creates a merged row built on one member (it copies that
 * member's rationale and body). When the consolidation is undone, the merged
 * row leaves the store, but its snapshots stay in the consolidate line and in
 * the undo line. Forgetting the member must redact those too, in both journal
 * generations, and in a redo line or a later edit of the merged row. A merged
 * row the store still holds is the owner's to forget, so its snapshots stay.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import { CHANGE_JOURNAL_FILE, CHANGE_JOURNAL_ROTATED_FILE, readChangeJournal } from '../src/change-journal.js'
import type { Engram } from '../src/schemas/engram.js'

const RATIONALE = 'Because the lockfile-otter-5521 incident broke every install'
const BODY = 'Body text kept only by the base member: heron-body-8812'
const MERGED = 'Use pnpm for every install here (merged)'

describe('audit 024 F3: forget redacts rows derived from the forgotten row', () => {
  let dir: string
  let plur: Plur
  let a: Engram
  let b: Engram
  const journalText = () => [CHANGE_JOURNAL_FILE, CHANGE_JOURNAL_ROTATED_FILE]
    .map(f => join(dir, f)).filter(p => existsSync(p)).map(p => readFileSync(p, 'utf8')).join('\n')

  beforeEach(async () => {
    delete process.env.PLUR_CHANGE_JOURNAL_MAX_BYTES
    dir = mkdtempSync(join(tmpdir(), 'plur-audit-024-f3-'))
    plur = new Plur({ path: dir, autoDiscover: false })
    a = await plur.learn('Use pnpm, not npm, in this repository', { scope: 'global', domain: 'dev', rationale: RATIONALE })
    b = await plur.learn('Always use pnpm for installs in this repo', { scope: 'global', domain: 'dev' })
    const ra = (await plur.getById(a.id))!
    await plur.updateEngramAsync({ ...ra, structured_data: { ...(ra.structured_data ?? {}), body: BODY } })
  })
  afterEach(() => {
    delete process.env.PLUR_CHANGE_JOURNAL_MAX_BYTES
    rmSync(dir, { recursive: true, force: true })
  })

  const MERGED_ID = 'ENG-2026-1127-901'

  /** A consolidation shaped like the real one: the merged row is a copy of the base member. */
  async function consolidate(): Promise<string> {
    const rec = await plur.beginChange('consolidate.merge', {
      plan_id: 'P-1', cluster_id: 'K-0001', members: [a.id, b.id], merged_statement: MERGED,
    }).apply(tx => {
      const base = tx.get(a.id)!
      tx.put({ ...base, id: MERGED_ID, statement: MERGED })
      tx.put({ ...tx.get(a.id)!, status: 'retired' })
      tx.put({ ...tx.get(b.id)!, status: 'retired' })
    })
    return rec.id
  }

  it('consolidate, undo, forget the base member: its rationale and body are gone from the journal', async () => {
    const change = await consolidate()
    await plur.undoChange(change)
    expect(await plur.getById(MERGED_ID)).toBeFalsy()
    expect(journalText()).toContain('lockfile-otter-5521')
    await plur.forget(a.id, 'privacy', { force: true })
    const text = journalText()
    expect(text).not.toContain('lockfile-otter-5521')
    expect(text).not.toContain('heron-body-8812')
    expect(text).not.toContain(a.statement)
    // The other member is untouched.
    expect(text).toContain(b.statement)
  })

  it('covers the rotated generation too', async () => {
    const change = await consolidate()
    process.env.PLUR_CHANGE_JOURNAL_MAX_BYTES = '1'
    await plur.undoChange(change) // rotation moves the consolidate line to the older generation
    delete process.env.PLUR_CHANGE_JOURNAL_MAX_BYTES
    expect(readFileSync(join(dir, CHANGE_JOURNAL_ROTATED_FILE), 'utf8')).toContain('lockfile-otter-5521')
    await plur.forget(a.id, 'privacy', { force: true })
    expect(journalText()).not.toContain('lockfile-otter-5521')
    expect(journalText()).not.toContain('heron-body-8812')
  })

  it('covers a redo line and an edit of the merged row made before the undo', async () => {
    const change = await consolidate()
    const m = (await plur.getById(MERGED_ID))!
    await plur.beginChange('test.edit').apply(tx => { tx.put({ ...tx.get(m.id)!, tags: ['edited'] }) })
    const editRec = readChangeJournal(dir).find(r => r.kind === 'test.edit')!
    await plur.undoChange(editRec.id)
    const undo = await plur.undoChange(change)
    const redo = await plur.undoChange(undo.id)
    await plur.undoChange(redo.id)
    expect(await plur.getById(MERGED_ID)).toBeFalsy()
    await plur.forget(a.id, 'privacy', { force: true })
    expect(journalText()).not.toContain('lockfile-otter-5521')
    expect(journalText()).not.toContain('heron-body-8812')
  })

  it('a merged row the store still holds keeps its snapshots (it is forgotten on its own)', async () => {
    await consolidate()
    await plur.forget(a.id, 'privacy', { force: true })
    const rec = readChangeJournal(dir).find(r => r.kind === 'consolidate.merge')!
    const merged = rec.rows.find(r => r.id === MERGED_ID)!
    expect((merged.after as Engram).statement).toBe(MERGED)
    expect(rec.rows.find(r => r.id === a.id)!.before).toMatchObject({ _redacted: true })
  })
})
