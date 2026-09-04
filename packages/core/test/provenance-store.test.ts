/**
 * Storing provenance records (#965) and choosing when to write them (#966).
 *
 * Storage is deliberately separate from generation, so that enterprise can put
 * records in a database later without touching the code that builds them. These
 * tests hold that seam in place: the same assertions run against both
 * implementations, and neither knows anything about the generator.
 *
 * The setting defaults to `never`. Turning it on must change nothing except
 * that records start appearing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { FileProvenanceStore, MemoryProvenanceStore, provenanceMode, type ProvenanceStore } from '../src/provenance-store.js'
import { PlurConfigSchema } from '../src/schemas/config.js'
import { Plur } from '../src/index.js'
import { EngramSchema } from '../src/schemas/engram.js'
import { buildProvenanceRecord } from '../src/provenance.js'

describe.each([
  ['FileProvenanceStore', (dir: string): ProvenanceStore => new FileProvenanceStore(dir)],
  ['MemoryProvenanceStore', (): ProvenanceStore => new MemoryProvenanceStore()],
])('%s', (_name, make) => {
  let dir: string
  let store: ProvenanceStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-prov-store-'))
    store = make(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns a reference that reads the record back', async () => {
    const record = { '@context': {}, '@graph': [{ '@id': 'engram:ENG-1' }] }
    const ref = await store.put('ENG-1', record)
    expect(ref).toBeTruthy()
    expect(await store.get(ref)).toEqual(record)
  })

  it('keeps every record rather than overwriting', async () => {
    // A record is a snapshot of state that keeps changing. A later one does not
    // make an earlier one wrong.
    await store.put('ENG-1', { version: 1 })
    await new Promise(r => setTimeout(r, 5))
    await store.put('ENG-1', { version: 2 })
    const refs = await store.list('ENG-1')
    expect(refs).toHaveLength(2)
  })

  it('lists newest first', async () => {
    await store.put('ENG-1', { version: 1 })
    await new Promise(r => setTimeout(r, 5))
    await store.put('ENG-1', { version: 2 })
    const [newest] = await store.list('ENG-1')
    expect((await store.get(newest) as any).version).toBe(2)
  })

  it('keeps engrams apart', async () => {
    await store.put('ENG-1', { which: 'one' })
    await store.put('ENG-2', { which: 'two' })
    expect(await store.list('ENG-1')).toHaveLength(1)
    expect(await store.list('ENG-2')).toHaveLength(1)
  })

  it('returns nothing for an engram with no records', async () => {
    expect(await store.list('ENG-never-written')).toEqual([])
  })

  it('returns undefined rather than throwing for a bad reference', async () => {
    expect(await store.get('/no/such/path.jsonld')).toBeUndefined()
  })
})

describe('FileProvenanceStore on disk', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-prov-file-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes under a provenance directory, beside the history log', async () => {
    const store = new FileProvenanceStore(dir)
    const ref = await store.put('ENG-2026-08-21-001', { hello: 'world' })
    expect(ref).toContain(join('provenance', 'ENG-2026-08-21-001'))
    expect(ref.endsWith('.jsonld')).toBe(true)
    expect(existsSync(ref)).toBe(true)
  })

  it('cannot be walked out of by a strange identifier', async () => {
    const store = new FileProvenanceStore(dir)
    const ref = await store.put('../../escape', { x: 1 })
    expect(ref).toContain('provenance')
    expect(ref).not.toContain('..')
  })
})

describe('the provenance setting (#966)', () => {
  it('is never when nothing is configured', () => {
    // PlurConfigSchema is .partial(), so an absent key yields undefined rather
    // than a default. The default lives in provenanceMode, in one place.
    expect(provenanceMode(undefined)).toBe('never')
    expect(provenanceMode({})).toBe('never')
    expect(provenanceMode(PlurConfigSchema.parse({}))).toBe('never')
  })

  it('reads the configured mode', () => {
    expect(provenanceMode({ provenance: { generate: 'always' } })).toBe('always')
    expect(provenanceMode({ provenance: { generate: 'on_export' } })).toBe('on_export')
    expect(provenanceMode({ provenance: { generate: 'never' } })).toBe('never')
  })

  it('falls back to never rather than trusting an unknown value', () => {
    expect(provenanceMode({ provenance: { generate: 'sometimes' } })).toBe('never')
    expect(provenanceMode({ provenance: {} })).toBe('never')
  })

  it('accepts the three modes and rejects anything else', () => {
    for (const generate of ['never', 'on_export', 'always']) {
      expect(PlurConfigSchema.safeParse({ provenance: { generate } }).success).toBe(true)
    }
    expect(PlurConfigSchema.safeParse({ provenance: { generate: 'sometimes' } }).success).toBe(false)
  })
})

describe('building and storing through Plur', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-prov-api-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('builds a record on request', async () => {
    const engram = await plur.learn('Something worth recording', { type: 'behavioral' })
    const record = await plur.provenanceFor(engram.id) as any
    expect(record['@graph'].some((n: any) => n['@id'] === `engram:${engram.id}`)).toBe(true)
  })

  it('returns nothing for an engram that does not exist', async () => {
    expect(await plur.provenanceFor('ENG-does-not-exist')).toBeUndefined()
    expect(await plur.writeProvenance('ENG-does-not-exist')).toBeUndefined()
  })

  it('stores a record and reads it back', async () => {
    const engram = await plur.learn('Stored and read back', { type: 'behavioral' })
    const store = new MemoryProvenanceStore()
    const ref = await plur.writeProvenance(engram.id, { store })
    expect(ref).toBeTruthy()
    expect(await store.get(ref!)).toBeDefined()
  })

  it('writes no record while the setting is never', async () => {
    const engram = await plur.learn('No record should appear', { type: 'behavioral' })
    const store = new FileProvenanceStore(dir)
    expect(await store.list(engram.id)).toEqual([])
  })

  it('leaves the statement out of a record by default', async () => {
    const engram = await plur.learn('A private-sounding statement', { type: 'behavioral' })
    const record = await plur.provenanceFor(engram.id)
    expect(JSON.stringify(record)).not.toContain('A private-sounding statement')
  })

  it('includes the statement when explicitly asked', async () => {
    const engram = await plur.learn('Deliberately shared statement', { type: 'behavioral' })
    const record = await plur.provenanceFor(engram.id, { includeStatement: true })
    expect(JSON.stringify(record)).toContain('Deliberately shared statement')
  })
})

describe('the always setting', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-prov-always-'))
    writeFileSync(join(dir, 'config.yaml'), 'provenance:\n  generate: always\n', 'utf8')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes a record when an engram is created', async () => {
    const plur = new Plur({ path: dir })
    const engram = await plur.learn('This one should get a record', { type: 'behavioral' })

    // The write is deliberately not awaited by learn: a provenance record is a
    // description, and failing to write one must not fail the learn.
    await new Promise(r => setTimeout(r, 120))

    const store = new FileProvenanceStore(dir)
    const refs = await store.list(engram.id)
    expect(refs.length).toBeGreaterThan(0)
    expect(await store.get(refs[0])).toBeDefined()
  })
})

/**
 * Asking twice is not two versions (#970, tester finding).
 *
 * A tester ran the save five times and got five identical files. The series is
 * meant to record how a record CHANGED, and a directory full of duplicates
 * destroys that — you can no longer tell a real revision from a repeat.
 */
describe('repeated saves', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-prov-dedup-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const engram = EngramSchema.parse({
    id: 'ENG-2026-08-23-777',
    statement: 'Saved more than once',
    type: 'behavioral',
    scope: 'global',
    status: 'active',
    content_hash: 'c'.repeat(64),
  })

  it('returns the same file when nothing about the record changed', async () => {
    const store = new FileProvenanceStore(dir)
    const first = await store.put(engram.id, buildProvenanceRecord(engram, [], { now: '2026-08-23T10:00:00Z' }))
    // A LATER generation time, same substance. This is the case raw byte
    // comparison would miss, because the timestamp differs every time.
    const second = await store.put(engram.id, buildProvenanceRecord(engram, [], { now: '2026-08-23T11:00:00Z' }))
    expect(second).toBe(first)
    expect(readdirSync(join(dir, 'provenance', engram.id))).toHaveLength(1)
  })

  it('still writes a new file when the record genuinely changed', async () => {
    // The series has to keep working. A record made after a revision says
    // something different, and losing that would be worse than the duplicates.
    const store = new FileProvenanceStore(dir)
    const first = await store.put(engram.id, buildProvenanceRecord(engram))
    const second = await store.put(engram.id, buildProvenanceRecord(engram, [
      { event: 'engram_created', engram_id: engram.id, timestamp: '2026-08-23T00:00:00Z', data: {} },
    ] as any))
    expect(second).not.toBe(first)
    expect(readdirSync(join(dir, 'provenance', engram.id))).toHaveLength(2)
  })
})

/**
 * `provenance.path` cannot leave the store (#1002 review).
 *
 * The setting was sanitised by character class, which kept `.`, so `..`
 * passed through untouched and `provenance.path: ".."` wrote every record one
 * level ABOVE the store. Containment is decided on the resolved path now, the
 * way the pack installer decides it.
 */
describe('FileProvenanceStore keeps records inside the store', () => {
  let root: string
  beforeEach(() => { root = join(mkdtempSync(join(tmpdir(), 'plur-prov-contain-')), 'store'); mkdirSync(root) })
  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }))

  it.each(['..', '.', '../../..', 'a/../..', '/tmp'])('refuses %j', sub => {
    expect(() => new FileProvenanceStore(root, sub)).toThrow(/inside the store/)
  })

  it('treats a blank value as unset', async () => {
    const ref = await new FileProvenanceStore(root, '   ').put('ENG-2026-01-01-001', { x: 1 })
    expect(ref.startsWith(join(root, 'provenance') + sep)).toBe(true)
  })

  it('accepts a nested relative directory, and writes inside it', async () => {
    const store = new FileProvenanceStore(root, 'prov/records')
    const ref = await store.put('ENG-2026-01-01-001', { x: 1 })
    expect(ref.startsWith(join(root, 'prov', 'records') + sep)).toBe(true)
  })

  it('keeps the default where it always was', async () => {
    const ref = await new FileProvenanceStore(root).put('ENG-2026-01-01-001', { x: 1 })
    expect(ref.startsWith(join(root, 'provenance') + sep)).toBe(true)
  })

  it('a bad config value fails the explicit write with a clear message, not the learn', async () => {
    const plur = new Plur({ path: root })
    writeFileSync(join(root, 'config.yaml'), 'provenance:\n  path: ".."\n  generate: always\n')
    const plur2 = new Plur({ path: root })
    // A learn must never fail because provenance could not be written.
    const e = await plur2.learn('Provenance is a description, not a precondition')
    expect(e.id).toBeTruthy()
    await expect(plur2.writeProvenance(e.id)).rejects.toThrow(/inside the store/)
    expect(existsSync(join(root, '..', 'ENG-' ))).toBe(false)
    void plur
  })
})
