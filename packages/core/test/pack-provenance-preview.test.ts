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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import * as yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { installPack, previewPack, computePackHash, listPacks } from '../src/packs.js'

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
  /**
   * Export everything in the store, the way `plur packs export` does.
   *
   * The pack licence is deliberately NOT the same as the licence the first
   * seeded engram chose (cc-by-4.0). One engram picked its own; the other has
   * none and inherits the pack's — and telling those apart is what most of
   * these tests are about.
   */
  const exportAll = async (plur: Plur, opts: Record<string, unknown> = {}) =>
    plur.exportPack(await plur.list(), out, { name: 'testpack', version: '1.0.0', license: 'apache-2.0', ...opts } as any)

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

  it('separates a licence the author chose from one the pack supplied', async () => {
    // This is the whole point of the licence view. One engram was licensed
    // deliberately (cc-by-4.0); the other had none and takes the pack's
    // (apache-2.0) by inheritance. Presenting them alike would tell a reader
    // the author granted terms they never considered.
    const plur = await seed()
    await exportAll(plur)
    const { licences, notes } = (await plur.previewPack(out)).provenance

    expect(licences.find(l => l.name === 'cc-by-4.0')?.chosen).toBe(true)
    expect(licences.find(l => l.name === 'apache-2.0')?.chosen).toBe(false)
    expect(notes.join(' ')).toContain('never chosen')
  })

  it('says so plainly when a pack carries no provenance at all', async () => {
    const plur = await seed()
    await exportAll(plur, { provenance: false })
    const preview = await plur.previewPack(out)
    expect(preview.provenance.present).toBe(false)
    expect(preview.provenance.notes.join(' ')).toContain('no provenance')
  })

  it('declares the provenance directory in the manifest, inside the integrity hash', async () => {
    // The records themselves are NOT covered by the §5.5 hash (SKILL.md ‖
    // engrams.yaml only), so the declaration is the one part of this a reader
    // gets for free with the integrity check they already do. It is written
    // before the hash is computed, which is what puts it inside.
    const plur = await seed()
    await exportAll(plur)
    const skill = readFileSync(join(out, 'SKILL.md'), 'utf8')
    expect(skill).toContain('provenance: true')
    const hash = readFileSync(join(out, 'INTEGRITY'), 'utf8').trim()
    const { verifyPackIntegrity } = await import('../src/packs.js')
    expect(verifyPackIntegrity(out).status).toBe('ok')
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('does not declare provenance on a pack built without it', async () => {
    const plur = await seed()
    await exportAll(plur, { provenance: false })
    expect(readFileSync(join(out, 'SKILL.md'), 'utf8')).not.toContain('provenance:')
  })

  it('says a pack is damaged when it declares provenance and ships none', async () => {
    // Corruption, a broken build, or somebody stripping the directory after the
    // fact. Reporting this as an ordinary "carries no provenance" would hide the
    // one case where the absence is evidence of something.
    const plur = await seed()
    await exportAll(plur)
    rmSync(join(out, 'provenance'), { recursive: true, force: true })
    const preview = await plur.previewPack(out)
    expect(preview.provenance.present).toBe(false)
    const notes = preview.provenance.notes.join(' ')
    expect(notes).toContain('DECLARES')
    expect(notes).toContain('damaged or altered')
    // And NOT the reassuring wording used for a pack that never had any.
    expect(notes).not.toContain('That is not a fault')
  })

  it('flags a manifest that denies the records the pack actually ships', async () => {
    // Only an EXPLICIT `provenance: false` is a contradiction. It cannot come
    // out of exportPack, which omits the key instead — so this is a manifest
    // somebody wrote or edited by hand.
    const plur = await seed()
    await exportAll(plur)
    const skill = readFileSync(join(out, 'SKILL.md'), 'utf8')
    writeFileSync(join(out, 'SKILL.md'), skill.replace('provenance: true', 'provenance: false'))
    const preview = await plur.previewPack(out)
    expect(preview.provenance.present).toBe(true)
    expect(preview.provenance.notes.join(' ')).toContain('does not declare')
  })

  it('says nothing about a pack that simply predates the declaration', async () => {
    // An ABSENT field means "not declared", which is every pack built before
    // the field existed. Complaining about those would turn a new signal into
    // noise on the whole existing corpus, and a warning nobody can act on is
    // one they learn to skip past.
    const plur = await seed()
    await exportAll(plur)
    const skill = readFileSync(join(out, 'SKILL.md'), 'utf8')
    writeFileSync(join(out, 'SKILL.md'), skill.replace(/\s*provenance: true/, ''))
    const preview = await plur.previewPack(out)
    expect(preview.provenance.present).toBe(true)
    expect(preview.provenance.notes.join(' ')).not.toContain('does not declare')
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

/**
 * A pack arrives from a stranger. Everything in it is hostile until shown
 * otherwise, including the file names.
 */
describe('a pack built to mislead', () => {
  let home: string
  let out: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-packprov-evil-home-'))
    out = mkdtempSync(join(tmpdir(), 'plur-packprov-evil-out-'))
  })
  afterEach(() => {
    for (const d of [home, out]) rmSync(d, { recursive: true, force: true })
  })

  it('cannot be made to read a file outside the pack', async () => {
    // The identifier comes from a file the sender wrote. Joining it onto a path
    // unchecked would turn a preview into an arbitrary file read.
    const { readPackProvenance } = await import('../src/packs.js')
    const outside = join(tmpdir(), `plur-outside-${process.pid}.jsonld`)
    writeFileSync(outside, JSON.stringify({ '@graph': [{ '@id': 'engram:SECRET' }] }))
    mkdirSync(join(out, 'provenance'), { recursive: true })

    const hostile = [{ id: `../../${outside.replace(/^\//, '')}`, statement: 'x' }] as any
    const view = readPackProvenance(out, hostile)

    expect(view.record_count).toBe(0)
    expect(JSON.stringify(view)).not.toContain('SECRET')
    rmSync(outside, { force: true })
  })

  it('does not describe records it does not have', async () => {
    // A directory with nothing readable in it must not be reported as
    // "records for individual engrams but none for the pack".
    const { readPackProvenance } = await import('../src/packs.js')
    mkdirSync(join(out, 'provenance'), { recursive: true })
    const view = readPackProvenance(out, [] as any)
    expect(view.notes.join(' ')).toContain('no readable records')
    expect(view.notes.join(' ')).not.toContain('records for individual engrams')
  })
})

describe('the preview can tell the four licence states apart (#1019)', () => {
  // The profile replaced `engram:licenseIsDefault` with the four-state
  // `engram:licenseSource` precisely because "the author configured this once"
  // and "nobody ever chose it" are different facts. The preview read only the
  // boolean, so it collapsed them again at the one surface a recipient sees.
  let home: string
  let out: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-licsrc-home-'))
    out = mkdtempSync(join(tmpdir(), 'plur-licsrc-out-'))
  })
  afterEach(() => {
    for (const d of [home, out]) rmSync(d, { recursive: true, force: true })
  })

  /** Export a one-engram pack, then overwrite its record with the state under test. */
  const previewWith = async (record: Record<string, unknown>) => {
    const plur = new Plur({ path: home })
    await plur.learn('Pools cap at 100 on the shared tier', {
      type: 'architectural', visibility: 'public', domain: 'ops',
    })
    const engrams = await plur.list()
    plur.exportPack(engrams, out, { name: 'licsrc', version: '1.0.0', license: 'apache-2.0' } as any)
    const id = engrams[0].id
    writeFileSync(join(out, 'provenance', `${id}.jsonld`), JSON.stringify({
      '@graph': [{
        '@id': `engram:${id}`,
        '@type': ['prov:Entity', 'engram:Engram'],
        'engram:license': 'cc-by-4.0',
        ...record,
      }],
    }))
    const { licences } = (await plur.previewPack(out)).provenance
    return licences.find(l => l.name === 'cc-by-4.0')
  }

  const withSource = (source: string) => ({
    'engram:licenseSource': source,
    ...(source === 'chosen' || source === 'configuredDefault'
      ? {} : { 'engram:licenseIsDefault': true }),
  })

  it('reports a configured default as decided, and names how', async () => {
    const entry = await previewWith(withSource('configuredDefault'))
    expect(entry?.chosen).toBe(true)
    expect(entry?.sources).toContain('configuredDefault')
  })

  it('reports the schema default as nobody having decided', async () => {
    const entry = await previewWith(withSource('schemaDefault'))
    expect(entry?.chosen).toBe(false)
    expect(entry?.sources).toContain('schemaDefault')
  })

  it('separates a pack-inherited licence from one chosen for the engram', async () => {
    expect((await previewWith(withSource('inheritedFromPack')))?.chosen).toBe(false)
    expect((await previewWith(withSource('chosen')))?.chosen).toBe(true)
  })

  it('still reads a record written before the four-state field existed', async () => {
    // Records already in the wild carry only the boolean.
    const entry = await previewWith({ 'engram:licenseIsDefault': true })
    expect(entry?.chosen).toBe(false)
    expect(entry?.sources).toEqual([])
  })
})

describe('a malformed licence source does not corrupt the typed output', () => {
  // Raised in review of #1044. `license` was guarded with `typeof === 'string'`
  // and `licenseSource` was not, in a module whose stated job is packs built to
  // mislead. One record with a non-string there put whatever it contained into
  // `sources: string[]`, for every consumer downstream.
  let home: string
  let out: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-badsrc-home-'))
    out = mkdtempSync(join(tmpdir(), 'plur-badsrc-out-'))
  })
  afterEach(() => { for (const d of [home, out]) rmSync(d, { recursive: true, force: true }) })

  const previewWithSource = async (badSource: unknown) => {
    const plur = new Plur({ path: home })
    await plur.learn('Pools cap at 100 on the shared tier', {
      type: 'architectural', visibility: 'public', domain: 'ops',
    })
    const engrams = await plur.list()
    plur.exportPack(engrams, out, { name: 'badsrc', version: '1.0.0', license: 'apache-2.0' } as any)
    const id = engrams[0].id
    writeFileSync(join(out, 'provenance', `${id}.jsonld`), JSON.stringify({
      '@graph': [{
        '@id': `engram:${id}`,
        '@type': ['prov:Entity', 'engram:Engram'],
        'engram:license': 'cc-by-4.0',
        'engram:licenseSource': badSource,
      }],
    }))
    return (await plur.previewPack(out)).provenance
  }

  it('keeps sources a string array when a record carries an object', async () => {
    const { licences } = await previewWithSource({ malicious: true })
    const entry = licences.find(l => l.name === 'cc-by-4.0')
    expect(entry?.sources.every(x => typeof x === 'string')).toBe(true)
    expect(entry?.sources).toEqual([])
  })

  it('falls back to the boolean when the source is not a string', async () => {
    // With no usable source, the older `engram:licenseIsDefault` path decides —
    // and absent that too, the licence reads as chosen.
    const { licences } = await previewWithSource(42)
    expect(licences.find(l => l.name === 'cc-by-4.0')?.chosen).toBe(true)
  })

  it('still reads a well-formed source', async () => {
    const { licences } = await previewWithSource('inheritedFromPack')
    const entry = licences.find(l => l.name === 'cc-by-4.0')
    expect(entry?.sources).toContain('inheritedFromPack')
    expect(entry?.chosen).toBe(false)
  })
})

/**
 * The records survive the install (#1002 review).
 *
 * `installPack` copied top-level files only, so `provenance/` never landed,
 * and a preview of the installed copy then reported the pack as damaged —
 * "declares provenance and ships none" — about a pack that was fine.
 */
describe('provenance travels through install', () => {
  let home: string
  let out: string
  let packs: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-provinst-home-'))
    out = join(mkdtempSync(join(tmpdir(), 'plur-provinst-out-')), 'demo-pack')
    packs = mkdtempSync(join(tmpdir(), 'plur-provinst-packs-'))
  })
  afterEach(() => { for (const d of [home, out, packs]) rmSync(d, { recursive: true, force: true }) })

  const exportOne = async () => {
    const plur = new Plur({ path: home })
    const e = await plur.learn('Prefer squash merges on main', {
      visibility: 'public', license: 'cc-by-4.0', claim_class: 'asserted', attribution: { asserted_by: 'local:maintainer' },
    })
    return plur.exportPack([e], out, { name: 'demo-pack', version: '1.0.0', license: 'cc-by-4.0' })
  }

  it('an installed pack still has its records, and is not called damaged', async () => {
    const exported = await exportOne()
    expect(exported.provenance_files?.length).toBe(2)
    await installPack(packs, out)
    const installed = join(packs, basename(out))
    expect(existsSync(join(installed, 'provenance', 'pack.jsonld'))).toBe(true)
    const view = (await previewPack(installed)).provenance
    expect(view.present).toBe(true)
    expect(view.record_count).toBe(1)
    expect(view.unreadable_records).toBe(0)
    expect(view.notes.some(n => /damaged/.test(n))).toBe(false)
    expect(view.asserted_by).toContain('local:maintainer')
  })

  it('the registry hash still describes the installed content', async () => {
    await exportOne()
    const result = await installPack(packs, out)
    const installed = join(packs, basename(out))
    // The §5.5 hash covers SKILL.md and engrams.yaml only, so the records
    // change nothing about it — and the value recorded is the value the
    // installed directory hashes to.
    expect(result.registry.integrity).toBe(`sha256:${computePackHash(installed)}`)
    const listed = listPacks(packs).find(p => p.name === 'demo-pack')!
    expect(listed.integrity_ok).toBe(true)
  })

  it('copies only record files, under their own names', async () => {
    await exportOne()
    writeFileSync(join(out, 'provenance', 'stray.txt'), 'not a record')
    mkdirSync(join(out, 'provenance', 'nested'))
    writeFileSync(join(out, 'provenance', 'nested', 'deep.jsonld'), '{}')
    await installPack(packs, out)
    const installed = join(packs, basename(out), 'provenance')
    expect(existsSync(join(installed, 'stray.txt'))).toBe(false)
    expect(existsSync(join(installed, 'nested'))).toBe(false)
    expect(existsSync(join(installed, 'pack.jsonld'))).toBe(true)
  })
})

/**
 * A malformed record must not take the pack down with it (#1002 review).
 *
 * `(record['@graph'] ?? []).find(…)` assumed an array. `{"@graph": {}}`,
 * `{"@graph": "x"}` and `{"@graph": [null]}` each threw a TypeError out of
 * preview and install; the file was also read with no size cap. Every value
 * in these files was written by a stranger, so the shape is checked, one bad
 * record is counted rather than fatal, and the count is reported — a record
 * that cannot be read is a finding, not an absence.
 */
describe('a pack whose provenance records are malformed', () => {
  let dir: string
  let packs: string
  const ID = 'ENG-2026-08-23-500'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-badprov-'))
    packs = mkdtempSync(join(tmpdir(), 'plur-badprov-packs-'))
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: p5\nversion: 1.0.0\ndescription: d\nmetadata:\n  provenance: true\n---\nbody\n')
    writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({ engrams: [{
      id: ID, statement: 'ordinary', type: 'behavioral', scope: 'global', status: 'active',
      visibility: 'public', content_hash: 'a'.repeat(64),
    }] }))
    mkdirSync(join(dir, 'provenance'))
  })
  afterEach(() => { for (const d of [dir, packs]) rmSync(d, { recursive: true, force: true }) })

  const record = (body: string) => writeFileSync(join(dir, 'provenance', `${ID}.jsonld`), body)

  it.each([
    ['an object where the graph should be', '{"@graph": {}}'],
    ['a string where the graph should be', '{"@graph": "x"}'],
    ['a bare null document', 'null'],
    ['a bare string document', '"x"'],
    ['an array document', '[1,2]'],
    ['not JSON at all', '{"@graph": ['],
  ])('%s does not crash preview or install, and is counted as unreadable', async (_label, body) => {
    record(body)
    const preview = await previewPack(dir)
    expect(preview.provenance.present).toBe(true)
    expect(preview.provenance.record_count).toBe(0)
    expect(preview.provenance.unreadable_records).toBe(1)
    expect(preview.provenance.notes.some(n => /could not be read/.test(n))).toBe(true)
    await expect(installPack(packs, dir)).resolves.toBeDefined()
  })

  it.each([
    ['a null node in the graph', '{"@graph": [null]}'],
    ['a number node in the graph', '{"@graph": [1, "two"]}'],
  ])('%s does not crash preview or install; the nodes are skipped', async (_label, body) => {
    // A well-formed document whose graph holds nothing usable: read, but it
    // names no subject, so nothing is learned from it.
    record(body)
    const preview = await previewPack(dir)
    expect(preview.provenance.record_count).toBe(1)
    expect(preview.provenance.unreadable_records).toBe(0)
    expect(preview.provenance.attributed_count).toBe(0)
    await expect(installPack(packs, dir)).resolves.toBeDefined()
  })

  it('a null node beside the real one is skipped, not fatal', async () => {
    record(JSON.stringify({ '@graph': [null, 7, { '@id': `engram:${ID}`, 'engram:license': 'cc-by-4.0' }] }))
    const view = (await previewPack(dir)).provenance
    expect(view.record_count).toBe(1)
    expect(view.unreadable_records).toBe(0)
    expect(view.licences[0]?.name).toBe('cc-by-4.0')
  })

  it('a wrongly shaped attribution is ignored, not fatal', async () => {
    record(JSON.stringify({ '@graph': [{ '@id': `engram:${ID}`, 'prov:wasAttributedTo': 'not-a-node', 'engram:license': 7 }] }))
    const view = (await previewPack(dir)).provenance
    expect(view.record_count).toBe(1)
    expect(view.attributed_count).toBe(0)
    expect(view.licences).toEqual([])
  })

  it('a record too large to read is counted as unreadable, not read', async () => {
    record('{"@graph": []}')
    truncateSync(join(dir, 'provenance', `${ID}.jsonld`), 16 * 1024 * 1024 + 1)
    const view = (await previewPack(dir)).provenance
    expect(view.unreadable_records).toBe(1)
  })

  it('a malformed pack record is counted too', async () => {
    writeFileSync(join(dir, 'provenance', 'pack.jsonld'), '{"@graph": "nope"}')
    const view = (await previewPack(dir)).provenance
    expect(view.pack_record).toBeUndefined()
    expect(view.unreadable_records).toBe(1)
  })
})
