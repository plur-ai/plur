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
    expect(node['engram:licensedCount']).toBe(0)
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

  const manifest = { name: 'test-pack', version: '1.0.0', creator: 'local:maintainer', description: 'A pack' }

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
