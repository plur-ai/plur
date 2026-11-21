/**
 * Hardening H1 and H2: what the change journal keeps after forget/compact.
 *
 * H1: a consolidation's begun line carries the merged text in
 * `meta.merged_statement`. Redacting any row of that line must take the
 * statement text out of its meta too, not only the row snapshots.
 *
 * H2: a redaction failure must reach the caller (forget's `warnings`,
 * compact's `warnings`), its tmp file must not be left behind, and a torn
 * journal line that names a redacted row must not be passed through.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, appendFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const fault = vi.hoisted(() => ({ failJournalRename: false }))
vi.mock('fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('fs')>()
  return {
    ...orig,
    renameSync: (from: import('fs').PathLike, to: import('fs').PathLike) => {
      if (fault.failJournalRename && /changes(\.1)?\.jsonl\.\d+\.tmp$/.test(String(from))) throw new Error('EIO: simulated rename failure')
      return orig.renameSync(from, to)
    },
  }
})

import { Plur } from '../src/index.js'
import { changeJournalPath, redactChangeJournal, readChangeJournal } from '../src/change-journal.js'
import type { Engram } from '../src/schemas/engram.js'

describe('change journal redaction (H1, H2)', () => {
  let dir: string
  let plur: Plur
  let a: Engram
  let b: Engram
  const journal = () => readFileSync(changeJournalPath(dir), 'utf8')

  beforeEach(async () => {
    fault.failJournalRename = false
    dir = mkdtempSync(join(tmpdir(), 'plur-harden-journal-'))
    plur = new Plur({ path: dir, autoDiscover: false })
    a = await plur.learn('Use pnpm, not npm, in this repository', { scope: 'global', domain: 'dev' })
    b = await plur.learn('Always use pnpm for installs in this repo', { scope: 'global', domain: 'dev' })
  })
  afterEach(() => {
    fault.failJournalRename = false
    rmSync(dir, { recursive: true, force: true })
  })

  const MERGED = 'Use pnpm for every install here; the token is zebra-merged-7731'

  async function mergeLike(): Promise<string> {
    const mergedId = 'ENG-2026-1121-901'
    await plur.beginChange('consolidate.merge', {
      plan_id: 'P-1', cluster_id: 'C-1', members: [a.id, b.id], merged_statement: MERGED,
    }).apply(tx => {
      const base = tx.get(a.id)!
      tx.put({ ...base, id: mergedId, statement: MERGED })
      tx.put({ ...tx.get(a.id)!, status: 'retired' })
      tx.put({ ...tx.get(b.id)!, status: 'retired' })
    })
    expect(journal()).toContain('zebra-merged-7731')
    return mergedId
  }

  it('forgetting the merged row removes meta.merged_statement from the journal (H1)', async () => {
    const mergedId = await mergeLike()
    await plur.forget(mergedId, 'privacy', { force: true })
    expect(journal()).not.toContain('zebra-merged-7731')
    const rec = readChangeJournal(dir).find(r => r.kind === 'consolidate.merge')!
    expect(rec.meta.merged_statement).toBeUndefined()
    expect(rec.meta.members).toEqual([a.id, b.id])
  })

  it('compacting away a member removes meta.merged_statement too (H1)', async () => {
    await mergeLike()
    await plur.compact()
    // The merged row itself is still in the store, so its own snapshot keeps
    // its text; the meta copy is what must go with the removed members.
    const rec = readChangeJournal(dir).find(r => r.kind === 'consolidate.merge')!
    expect(rec.meta.merged_statement).toBeUndefined()
    expect(JSON.stringify(rec.meta)).not.toContain('zebra-merged-7731')
  })

  it('any meta string quoting a redacted row\'s statement is removed (H1)', async () => {
    await plur.beginChange('test.note', { note: `was: ${a.statement}`, reason: 'kept' })
      .apply(tx => { tx.put({ ...tx.get(a.id)!, tags: ['x'] }) })
    await plur.forget(a.id, 'privacy', { force: true })
    expect(journal()).not.toContain(a.statement)
    const rec = readChangeJournal(dir).find(r => r.kind === 'test.note')!
    expect(rec.meta.reason).toBe('kept')
  })

  it('forget reports a redaction failure in its warnings (H2)', async () => {
    await plur.beginChange('test.edit').apply(tx => { tx.put({ ...tx.get(a.id)!, tags: ['x'] }) })
    mkdirSync(join(dir, 'changes.1.jsonl')) // unreadable generation: redaction throws
    const outcome = await plur.forget(a.id, 'privacy', { force: true })
    expect(outcome.warnings.join('\n')).toMatch(/change journal could not be redacted/)
  })

  it('compact reports a redaction failure in its result (H2)', async () => {
    await plur.beginChange('test.retire').apply(tx => { tx.put({ ...tx.get(b.id)!, status: 'retired' }) })
    mkdirSync(join(dir, 'changes.1.jsonl'))
    const res = await plur.compact()
    expect(res.removed).toBe(1)
    expect((res.warnings ?? []).join('\n')).toMatch(/change journal could not be redacted/)
  })

  it('a failed rename leaves no tmp file behind (H2)', async () => {
    await plur.beginChange('test.edit').apply(tx => { tx.put({ ...tx.get(a.id)!, tags: ['x'] }) })
    fault.failJournalRename = true
    expect(() => redactChangeJournal(dir, [a.id])).toThrow(/simulated rename failure/)
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('a torn line naming a redacted row is dropped and counted, not passed through (H2)', async () => {
    await plur.beginChange('test.edit').apply(tx => { tx.put({ ...tx.get(b.id)!, tags: ['x'] }) })
    appendFileSync(changeJournalPath(dir), `{"v":1,"state":"begun","id":"CHG-torn","rows":[{"id":"${a.id}","before":{"statement":"torn-secret-4410\n`)
    const n = redactChangeJournal(dir, [a.id])
    expect(n).toBeGreaterThanOrEqual(1)
    expect(journal()).not.toContain('torn-secret-4410')
    // The intact change is still there.
    expect(readChangeJournal(dir).some(r => r.kind === 'test.edit')).toBe(true)
  })
})
