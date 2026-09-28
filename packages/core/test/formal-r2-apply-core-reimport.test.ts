/**
 * Decision R (owner, 2026-09-27) — "A re-run changes nothing".
 *
 * Re-importing a record that already exists is a true skip: the importer asks
 * `Plur.wouldDeduplicate` BEFORE calling learn() and leaves the existing engram
 * completely untouched — no write_count bump, no sources append, no cross-scope
 * recurrence — and reports it as skipped. The dry run and the real run still
 * agree. Replayed before the change (findings/r2-retrieval.md §4): a second run
 * left write_count 3 / sources 3, and a cross-scope re-import bumped
 * recurrence_count.
 *
 * Model: spec/formal/PlurSpec/R2CoreA.lean §6 (`rerun_changes_nothing`,
 * `dry_predicts_real_store`).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Plur } from '../src/index.js'
import { runImport, type ImportRecord } from '../src/importers/index.js'

const dirs: string[] = []
function fresh(): Plur {
  const d = mkdtempSync(join(tmpdir(), 'plur-r2apply-r-'))
  dirs.push(d)
  return new Plur({ path: d })
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const snapshot = async (p: Plur) =>
  JSON.stringify((await p.list({ include_expired: true })).map(e => ({
    id: e.id, scope: e.scope, write_count: e.write_count, recurrence_count: (e as any).recurrence_count,
    sources: (e as any).sources, commitment: e.commitment,
  })))

describe('Decision R: re-importing an existing record is a true skip', () => {
  const records: ImportRecord[] = [{ statement: 'idem one' }, { statement: 'idem two' }]

  it('a second run of the same file leaves every engram untouched', async () => {
    const plur = fresh()
    const first = await runImport(plur, records, { from: 'generic' })
    expect(first.imported).toBe(2)
    const before = await snapshot(plur)
    const second = await runImport(plur, records, { from: 'generic' })
    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(2)
    expect(second.records.map(r => r.id)).toEqual(first.records.map(r => r.id))
    expect(await snapshot(plur)).toBe(before)
  })

  it('a cross-scope re-import neither records recurrence nor graduates the engram', async () => {
    const plur = fresh()
    await runImport(plur, records, { from: 'generic' })
    const before = await snapshot(plur)
    const again = await runImport(plur, records, { from: 'generic', scope: 'project:other' })
    expect(again.skipped).toBe(2)
    expect(await snapshot(plur)).toBe(before)
    const again2 = await runImport(plur, records, { from: 'generic', scope: 'project:third' })
    expect(again2.skipped).toBe(2)
    expect(await snapshot(plur)).toBe(before)
  })

  it('in-file duplicates: the second copy does not bump the first', async () => {
    const plur = fresh()
    const res = await runImport(plur, [{ statement: 'twice in one file' }, { statement: 'twice in one file' }], { from: 'generic' })
    expect(res.records.map(r => r.action)).toEqual(['imported', 'skipped'])
    const [e] = await plur.list({})
    expect(e.write_count ?? 1).toBe(1)
  })

  it('dry run and real run still agree on a re-run (and the dry run writes nothing)', async () => {
    const a = fresh(); const b = fresh()
    await runImport(a, records, { from: 'generic' })
    await runImport(b, records, { from: 'generic' })
    const before = await snapshot(a)
    const dry = await runImport(a, [...records, { statement: 'fresh' }], { from: 'generic', dryRun: true })
    const real = await runImport(b, [...records, { statement: 'fresh' }], { from: 'generic' })
    expect(dry.records.map(r => r.action)).toEqual(real.records.map(r => r.action))
    expect(dry.records.map(r => r.action)).toEqual(['skipped', 'skipped', 'imported'])
    expect(await snapshot(a)).toBe(before)
  })
})
