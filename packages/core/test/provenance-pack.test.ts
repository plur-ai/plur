/**
 * Provenance for packs (#972) and for particular fields of work (#973).
 *
 * A pack is how engrams leave one machine and reach another, so this is where
 * provenance stops being a nicety. The recipient has our engrams and none of our
 * history, which is why these records must stand entirely on their own.
 *
 * Two rules carry most of the weight here:
 *
 *   - a record must never ship an engram the privacy scan refused
 *   - a domain may add its own fields, but never redefine a core term
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngramSchema } from '../src/schemas/engram.js'
import {
  buildProvenanceRecord,
  buildPackProvenanceRecord,
  assertDomainFields,
  type DomainExtension,
} from '../src/provenance.js'
import { exportPack } from '../src/packs.js'

const engramOf = (id: string, overrides: Record<string, unknown> = {}) =>
  EngramSchema.parse({
    id,
    statement: `Statement for ${id}`,
    type: 'behavioral',
    scope: 'global',
    status: 'active',
    // Engrams default to private visibility, and a pack export refuses anything
    // the privacy scan flags — private included. A shareable engram is public.
    visibility: 'public',
    content_hash: 'c'.repeat(64),
    ...overrides,
  })

const nodesOf = (record: any) => record['@graph'] as any[]
const nodeById = (record: any, id: string) => nodesOf(record).find(n => n['@id'] === id)

describe('a pack has provenance too (#972)', () => {
  const engrams = [
    engramOf('ENG-2026-08-21-001', { claim_class: 'asserted', temporal: { learned_at: '2026-08-01T00:00:00Z' } }),
    engramOf('ENG-2026-08-21-002', { claim_class: 'inferred', temporal: { learned_at: '2026-08-15T00:00:00Z' } }),
    engramOf('ENG-2026-08-21-003', { claim_class: 'inferred', temporal: { learned_at: '2026-08-10T00:00:00Z' } }),
  ]
  const pack = { name: 'swarm-grants', version: '1.0.0', creator: 'local:maintainer', integrity: 'sha256:deadbeef' }

  it('describes the pack as a collection with members', () => {
    const record = buildPackProvenanceRecord(pack, engrams, { now: '2026-08-21T09:00:00Z' })
    const node = nodeById(record, 'engram:pack/swarm-grants@1.0.0')
    expect(node['@type']).toContain('prov:Collection')
    expect(node['prov:hadMember']).toHaveLength(3)
    expect(node['engram:engramCount']).toBe(3)
  })

  it('says who assembled it, and when', () => {
    const record = buildPackProvenanceRecord(pack, engrams, { now: '2026-08-21T09:00:00Z' })
    const assembly = nodeById(record, 'engram:act/assemble-swarm-grants-1.0.0')
    expect(assembly['prov:generated']).toEqual({ '@id': 'engram:pack/swarm-grants@1.0.0' })
    expect(assembly['prov:wasAssociatedWith']).toEqual({ '@id': 'engram:agent/local:maintainer' })
  })

  it('lets a reader judge the pack before opening a single engram', () => {
    // Two packs of the same size are not equal. One may be direct statements
    // from a named expert; the other machine guesses from an unknown source.
    const node = nodeById(buildPackProvenanceRecord(pack, engrams), 'engram:pack/swarm-grants@1.0.0')
    expect(node['engram:claimClassCounts']).toEqual({ asserted: 1, inferred: 2 })
    expect(node['engram:licenseChosenCount']).toBe(0)
    expect(node['engram:earliestEngram']).toBe('2026-08-01T00:00:00Z')
    expect(node['engram:latestEngram']).toBe('2026-08-15T00:00:00Z')
  })

  it('counts engrams whose claim class nobody set', () => {
    const record = buildPackProvenanceRecord(pack, [engramOf('ENG-x')])
    const node = nodeById(record, 'engram:pack/swarm-grants@1.0.0')
    expect(node['engram:claimClassCounts']).toEqual({ unstated: 1 })
  })

  it('carries the pack hash, so the record commits to the pack', () => {
    // The pack's own hash covers SKILL.md and engrams.yaml only, so a
    // provenance file is not covered by it. The dependency runs the other way.
    const node = nodeById(buildPackProvenanceRecord(pack, engrams), 'engram:pack/swarm-grants@1.0.0')
    expect(node['engram:packIntegrity']).toBe('sha256:deadbeef')
  })

  it('describes every member, so nothing dangles', () => {
    const record = buildPackProvenanceRecord(pack, engrams)
    const described = new Set(nodesOf(record).map(n => n['@id']))
    for (const e of engrams) expect(described.has(`engram:${e.id}`)).toBe(true)
  })

  it('works with no creator named', () => {
    const record = buildPackProvenanceRecord({ name: 'p', version: '1.0.0' }, engrams)
    expect(nodeById(record, 'engram:pack/p@1.0.0')['prov:wasAttributedTo']).toBeUndefined()
  })
})

describe('fields for a particular field of work (#973)', () => {
  const geo: DomainExtension = {
    namespaces: { geo: 'https://example.org/geo#' },
    attributes: { 'geo:parcelId': '1234-5678', 'geo:coordinateSystem': 'EPSG:3794' },
  }

  it('adds domain fields under their own prefix', () => {
    const record = buildProvenanceRecord(engramOf('ENG-geo-1'), [], { domain: geo })
    expect((record as any)['@context'].geo).toBe('https://example.org/geo#')
    const thing = nodeById(record, 'engram:ENG-geo-1')
    expect(thing['geo:parcelId']).toBe('1234-5678')
  })

  it('leaves the core vocabulary untouched', () => {
    const record = buildProvenanceRecord(engramOf('ENG-geo-2'), [], { domain: geo })
    const context = (record as any)['@context']
    expect(context.prov).toBe('http://www.w3.org/ns/prov#')
    expect(context.engram).toBe('https://plur.ai/ns/engram#')
  })

  it('adds domain fields to a pack record too', () => {
    const record = buildPackProvenanceRecord({ name: 'geo-pack', version: '1.0.0' }, [engramOf('ENG-1')], { domain: geo })
    expect(nodeById(record, 'engram:pack/geo-pack@1.0.0')['geo:parcelId']).toBe('1234-5678')
  })

  it('refuses to let a domain claim a core prefix', () => {
    // Throwing is deliberate. A silently overwritten core term corrupts every
    // reader downstream, and a silently dropped field looks like it was recorded.
    expect(() => assertDomainFields({
      namespaces: { prov: 'https://evil.example/' },
      attributes: {},
    })).toThrow(/core vocabulary/)
  })

  it('refuses to let a domain redefine a core term', () => {
    expect(() => assertDomainFields({
      namespaces: { geo: 'https://example.org/geo#' },
      attributes: { 'engram:claimClass': 'something else' },
    })).toThrow(/core prefix/)
  })

  it('refuses an attribute with no prefix', () => {
    expect(() => assertDomainFields({
      namespaces: { geo: 'https://example.org/geo#' },
      attributes: { parcelId: '1234' },
    })).toThrow(/no prefix/)
  })

  it('refuses an attribute whose prefix was never declared', () => {
    expect(() => assertDomainFields({
      namespaces: { geo: 'https://example.org/geo#' },
      attributes: { 'med:patientId': 'x' },
    })).toThrow(/not declared/)
  })
})

describe('exporting a pack with provenance (#972)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-pack-prov-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // A licence is required to export at all now — see "export will not choose a
  // licence for you" below for why. These tests are about provenance files, so
  // they name one and move on.
  const manifest = {
    name: 'test-pack', version: '1.0.0', creator: 'local:maintainer',
    description: 'A pack', license: 'cc-by-4.0',
  }

  it('writes provenance without being asked', () => {
    // Flipped deliberately (#970 use case 2). A pack is how engrams leave one
    // machine for another, which is the one place a record defends against
    // anybody. Every software supply chain settled on the same answer: the bill
    // of materials is part of the build, not something a publisher remembers.
    const result = exportPack([engramOf('ENG-2026-08-21-001')], dir, manifest)
    expect(result.provenance_files).toHaveLength(2)
    expect(existsSync(join(dir, 'provenance'))).toBe(true)
  })

  it('can still be turned off deliberately', () => {
    const result = exportPack([engramOf('ENG-2026-08-21-001')], dir, { ...manifest, provenance: false })
    expect(result.provenance_files).toBeUndefined()
    expect(existsSync(join(dir, 'provenance'))).toBe(false)
  })

  it('writes one record for the pack and one per engram', () => {
    const engrams = [engramOf('ENG-2026-08-21-001'), engramOf('ENG-2026-08-21-002')]
    const result = exportPack(engrams, dir, { ...manifest, provenance: true })

    expect(result.provenance_files).toHaveLength(3)
    expect(existsSync(join(dir, 'provenance', 'pack.jsonld'))).toBe(true)
    expect(existsSync(join(dir, 'provenance', 'ENG-2026-08-21-001.jsonld'))).toBe(true)
    expect(existsSync(join(dir, 'provenance', 'ENG-2026-08-21-002.jsonld'))).toBe(true)
  })

  it('records the pack hash that the export actually produced', () => {
    const result = exportPack([engramOf('ENG-2026-08-21-001')], dir, { ...manifest, provenance: true })
    const record = JSON.parse(readFileSync(join(dir, 'provenance', 'pack.jsonld'), 'utf8'))
    const node = nodeById(record, 'engram:pack/test-pack@1.0.0')
    expect(node['engram:packIntegrity']).toBe(result.integrity)
  })

  it('never ships a record for an engram the privacy scan refused', () => {
    // Provenance must not become a way around a refusal the content path made.
    const safe = engramOf('ENG-2026-08-21-001')
    const secret = engramOf('ENG-2026-08-21-999', {
      statement: 'the API key is sk-abcdef1234567890abcdef1234567890abcdef12',
    })
    const result = exportPack([safe, secret], dir, { ...manifest, provenance: true })

    expect(result.engram_count).toBe(1)
    expect(existsSync(join(dir, 'provenance', 'ENG-2026-08-21-999.jsonld'))).toBe(false)

    const record = JSON.parse(readFileSync(join(dir, 'provenance', 'pack.jsonld'), 'utf8'))
    expect(JSON.stringify(record)).not.toContain('ENG-2026-08-21-999')
  })

  it('writes portable records, which carry no statement text', () => {
    const engram = engramOf('ENG-2026-08-21-001', { statement: 'A statement that should not travel' })
    exportPack([engram], dir, { ...manifest, provenance: true })
    const text = readFileSync(join(dir, 'provenance', 'ENG-2026-08-21-001.jsonld'), 'utf8')
    expect(text).not.toContain('A statement that should not travel')
  })
})

describe("a pack's own licence is a different question from its engrams'", () => {
  // A single engram is one assertion; a pack is a curated collection, and a
  // collection attracts rights in its own right — the selection, the
  // arrangement, and in the EU the sui generis database right. So the pack
  // licence is the one a recipient asks about first, and it was the one field
  // the record did not carry at all.
  const members = [
    engramOf('ENG-2026-08-21-101', { provenance: { origin: 'x', license: 'cc-by-sa-4.0' } }),
    engramOf('ENG-2026-08-21-102', { provenance: { origin: 'x', license: 'cc-by-sa-4.0' } }),
  ]
  const packNodeOf = (record: any) =>
    nodesOf(record).find(n => Array.isArray(n['@type']) && n['@type'].includes('engram:Pack'))

  it('records the licence on the collection, with a policy a machine can act on', () => {
    const record = buildPackProvenanceRecord(
      { name: 'ops', version: '1.0.0', license: 'mit' }, members, { now: '2026-08-26T00:00:00Z' })
    const pack = packNodeOf(record)
    expect(pack['engram:license']).toBe('mit')
    expect(pack['odrl:hasPolicy']['odrl:uid']).toContain('mit')
    expect(pack['odrl:hasPolicy']['engram:licenseRecognised']).toBe(true)
  })

  it('says when the pack licence and the engram licences are not the same', () => {
    // An MIT pack of share-alike engrams is an ordinary thing to assemble by
    // accident, and a reuser has to satisfy both. The record must not resolve
    // it — it has no standing to — but it must not hide it either.
    const record = buildPackProvenanceRecord(
      { name: 'ops', version: '1.0.0', license: 'mit' }, members, { now: '2026-08-26T00:00:00Z' })
    const pack = packNodeOf(record)
    expect(pack['engram:memberLicensesDiffer']).toBe(true)
    expect(String(pack['engram:note'])).toContain('satisfy both')
    expect(String(pack['engram:note'])).toContain('Neither overrides the other')
    // Both are still stated, so the reader can see what they have to satisfy.
    expect(pack['engram:licensesChosen']).toEqual(['cc-by-sa-4.0'])
  })

  it('says nothing about a difference when there is none', () => {
    const record = buildPackProvenanceRecord(
      { name: 'ops', version: '1.0.0', license: 'cc-by-sa-4.0' }, members, { now: '2026-08-26T00:00:00Z' })
    expect(packNodeOf(record)['engram:memberLicensesDiffer']).toBeUndefined()
  })

  it('omits the licence rather than inventing one when the pack has none', () => {
    const record = buildPackProvenanceRecord(
      { name: 'ops', version: '1.0.0' }, members, { now: '2026-08-26T00:00:00Z' })
    const pack = packNodeOf(record)
    expect(pack['engram:license']).toBeUndefined()
    expect(pack['odrl:hasPolicy']).toBeUndefined()
  })

  it('carries the licence from an export all the way into the record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-packlic-'))
    try {
      exportPack(members, dir, { name: 'ops', version: '1.0.0', license: 'apache-2.0' } as any)
      // Into the manifest, where it is covered by the integrity hash...
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('license: apache-2.0')
      // ...and into the record, where a machine can act on it.
      const record = JSON.parse(readFileSync(join(dir, 'provenance', 'pack.jsonld'), 'utf8'))
      expect(packNodeOf(record)['engram:license']).toBe('apache-2.0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never writes a licence nobody chose, because it never gets that far', async () => {
    // This used to assert that an unchosen licence was omitted from the
    // manifest. Omitting it was only half an answer: the schema fills in
    // cc-by-sa-4.0 on the recipient's parse, so the grant arrived anyway with
    // nobody's name on it. Export now refuses instead of shipping quietly.
    const dir = mkdtempSync(join(tmpdir(), 'plur-packlic-none-'))
    try {
      expect(() => exportPack(members, dir, { name: 'ops', version: '1.0.0' } as any))
        .toThrow(/needs a licence/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('export will not choose a licence for you', () => {
  const members = [engramOf('ENG-2026-08-26-201'), engramOf('ENG-2026-08-26-202')]
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-lic-required-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('refuses to export a pack with no licence chosen', () => {
    // Silence does not produce silence: the schema fills in cc-by-sa-4.0, so
    // leaving it blank ships a share-alike grant nobody agreed to, over other
    // people's memories, to a stranger.
    expect(() => exportPack(members, dir, { name: 'ops', version: '1.0.0' } as any))
      .toThrow(/needs a licence/)
  })

  it('explains how to stop being asked, rather than only refusing', () => {
    try {
      exportPack(members, dir, { name: 'ops', version: '1.0.0' } as any)
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e.message).toContain('provenance.default_license')
      expect(e.message).toContain('unlicensed')
      expect(e.message).toContain('cc-by-4.0')
    }
  })

  it('accepts a licence configured once, because that is still a choice', () => {
    const result = exportPack(members, dir, { name: 'ops', version: '1.0.0' } as any, 'cc0-1.0')
    expect(result.engram_count).toBe(2)
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('license: cc0-1.0')
  })

  it('lets an explicit licence beat the configured one', () => {
    exportPack(members, dir, { name: 'ops', version: '1.0.0', license: 'mit' } as any, 'cc0-1.0')
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('license: mit')
  })

  it('treats "unlicensed" as a decision, and grants nothing for it', () => {
    exportPack(members, dir, { name: 'ops', version: '1.0.0', license: 'unlicensed' } as any)
    const record = JSON.parse(readFileSync(join(dir, 'provenance', 'pack.jsonld'), 'utf8'))
    const pack = nodesOf(record).find((n: any) =>
      Array.isArray(n['@type']) && n['@type'].includes('engram:Pack'))
    expect(pack['engram:license']).toBe('unlicensed')
    // A recorded decision, so it is RECOGNISED and grants nothing. Reporting it
    // as unrecognised would say we failed to look it up, which profile §5.4
    // forbids conflating with a stated decision — and would read identically to
    // a typo. This assertion used to require `false`, which certified the
    // behaviour the profile forbids and is why the gap survived review.
    expect(pack['odrl:hasPolicy']['engram:licenseRecognised']).toBe(true)
    expect(pack['odrl:hasPolicy']['odrl:permission']).toEqual([])
    expect(String(pack['odrl:hasPolicy']['engram:note']))
      .toContain('No licence was granted')
  })

  it('gives a member with no licence the pack\'s, marked as inherited', () => {
    exportPack(members, dir, { name: 'ops', version: '1.0.0', license: 'apache-2.0' } as any)
    const rec = JSON.parse(readFileSync(join(dir, 'provenance', 'ENG-2026-08-26-201.jsonld'), 'utf8'))
    const eng = nodesOf(rec).find((n: any) =>
      Array.isArray(n['@type']) && n['@type'].includes('engram:Engram'))
    expect(eng['engram:license']).toBe('apache-2.0')
    expect(eng['engram:licenseSource']).toBe('inheritedFromPack')
    expect(String(eng['engram:licenseSourceNote'])).toContain('not this memory')
  })

  it("does not overwrite a member's own licence with the pack's", () => {
    const own = [engramOf('ENG-2026-08-26-203', { provenance: { origin: 'x', license: 'cc-by-4.0' } })]
    exportPack(own, dir, { name: 'ops', version: '1.0.0', license: 'apache-2.0' } as any)
    const rec = JSON.parse(readFileSync(join(dir, 'provenance', 'ENG-2026-08-26-203.jsonld'), 'utf8'))
    const eng = nodesOf(rec).find((n: any) =>
      Array.isArray(n['@type']) && n['@type'].includes('engram:Engram'))
    expect(eng['engram:license']).toBe('cc-by-4.0')
    expect(eng['engram:licenseSource']).toBe('chosen')
  })
})
