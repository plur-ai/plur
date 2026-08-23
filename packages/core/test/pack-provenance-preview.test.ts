/**
 * Reading a pack's origin BEFORE installing it (#970, use case 3).
 *
 * The gate belongs at the boundary. Once a pack is installed, knowing where it
 * came from changes nothing you can act on.
 *
 * The shape follows the way media provenance is shown to a reader: an
 * indicator, then a summary, then the full document for anyone who wants it.
 *
 * One rule outranks the rest, and most of these tests exist to hold it in
 * place. **Nothing in a pack is signed.** Anybody can write anything into these
 * files. So the reader is shown what the pack CLAIMS and is told plainly that
 * nobody checked it. A tick on an unverified record is worse than no tick,
 * because it turns a claim into a belief without anyone deciding to.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '../src/index.js'

describe('previewing what a pack says about its origins', () => {
  let home: string
  let out: string

  const seed = async () => {
    const plur = new Plur({ path: home })
    await plur.learn('Always run migrations before deploying', {
      type: 'behavioral', visibility: 'public', domain: 'ops', license: 'cc-by-4.0',
      claim_class: 'asserted', attribution: { asserted_by: 'local:maintainer' },
    })
    await plur.learn('Connection pools cap at 100 on the shared tier', {
      type: 'architectural', visibility: 'public', domain: 'ops',
    })
    return plur
  }

  /** Export everything in the store, the way `plur packs export` does. */
  const exportAll = async (plur: Plur, opts: Record<string, unknown> = {}) =>
    plur.exportPack(await plur.list(), out, { name: 'testpack', version: '1.0.0', ...opts } as any)

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-packprov-home-'))
    out = mkdtempSync(join(tmpdir(), 'plur-packprov-out-'))
  })
  afterEach(() => {
    for (const d of [home, out]) rmSync(d, { recursive: true, force: true })
  })

  it('ships provenance without being asked', async () => {
    // A bill of materials is produced as part of the build and travels inside
    // the artifact. It is not something a publisher has to remember.
    const plur = await seed()
    const result = await exportAll(plur)
    expect(result.provenance_files?.length).toBeGreaterThan(0)
    expect(existsSync(join(out, 'provenance', 'pack.jsonld'))).toBe(true)
  })

  it('can still be turned off deliberately', async () => {
    const plur = await seed()
    await exportAll(plur, { provenance: false })
    expect(existsSync(join(out, 'provenance'))).toBe(false)
  })

  it('never claims anything was verified, because nothing is signed', async () => {
    const plur = await seed()
    await exportAll(plur)
    const preview = await plur.previewPack(out)

    expect(preview.provenance.verified).toBe(false)
    expect(preview.provenance.verification_note).toContain('Nothing here has been verified')
    // No word anywhere that a reader could take as a guarantee.
    const shown = JSON.stringify({ ...preview.provenance, pack_record: undefined })
    expect(shown).not.toMatch(/trusted|authentic|guaranteed/i)
  })

  it('counts the records and says which engrams have none', async () => {
    const plur = await seed()
    await exportAll(plur)
    const preview = await plur.previewPack(out)
    expect(preview.provenance.present).toBe(true)
    expect(preview.provenance.record_count).toBe(2)
    expect(preview.provenance.engrams_without_record).toBe(0)
  })

  it('names who the pack says is answerable', async () => {
    const plur = await seed()
    await exportAll(plur)
    const preview = await plur.previewPack(out)
    expect(preview.provenance.asserted_by).toEqual(['local:maintainer'])
    expect(preview.provenance.attributed_count).toBe(1)
  })

  it('separates a licence the author chose from one that was never chosen', async () => {
    // This is the whole point of the licence view. One engram was licensed
    // deliberately; the other took the schema default. Presenting them alike
    // would tell a reader the author granted terms they never considered.
    const plur = await seed()
    await exportAll(plur)
    const { licences, notes } = (await plur.previewPack(out)).provenance

    expect(licences.find(l => l.name === 'cc-by-4.0')?.chosen).toBe(true)
    expect(licences.find(l => l.name === 'cc-by-sa-4.0')?.chosen).toBe(false)
    expect(notes.join(' ')).toContain('never chosen')
  })

  it('says so plainly when a pack carries no provenance at all', async () => {
    const plur = await seed()
    await exportAll(plur, { provenance: false })
    const preview = await plur.previewPack(out)
    expect(preview.provenance.present).toBe(false)
    expect(preview.provenance.notes.join(' ')).toContain('no provenance')
  })

  it('survives a pack whose provenance files are corrupt or forged', async () => {
    // These files arrive from a stranger. Unparseable JSON, a record naming an
    // engram that is not in the pack, and a missing record must all degrade to
    // a smaller claim rather than throwing during a preview.
    const plur = await seed()
    await exportAll(plur)
    const dir = join(out, 'provenance')
    writeFileSync(join(dir, 'pack.jsonld'), '{ this is not json')
    for (const f of ['ENG-2026-08-21-001.jsonld']) {
      writeFileSync(join(dir, f), JSON.stringify({ '@graph': [{ '@id': 'engram:ENG-not-in-pack' }] }))
    }
    const preview = await plur.previewPack(out)
    expect(preview.provenance.present).toBe(true)
    expect(preview.provenance.verified).toBe(false)
  })

  it('reports the engrams it could not find records for', async () => {
    const plur = await seed()
    const result = await exportAll(plur)
    // Delete one engram's record, as a truncated download would.
    const missing = result.provenance_files!.find(f => f.includes('ENG-'))!
    rmSync(join(out, missing))
    const preview = await plur.previewPack(out)
    expect(preview.provenance.engrams_without_record).toBe(1)
    expect(preview.provenance.notes.join(' ')).toContain('no record of their own')
  })
})
