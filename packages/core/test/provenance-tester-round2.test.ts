/**
 * Defects four testers found by using this cold (#970, second round).
 *
 * Each is kept as a test so it cannot come back. The theme running through all
 * of them: the readable output was corrected first and the machine-readable
 * output was left saying the opposite.
 */
import { describe, it, expect } from 'vitest'
import { EngramSchema } from '../src/schemas/engram.js'
import { buildProvenanceRecord } from '../src/provenance.js'
import { exportPack } from '../src/packs.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const engramOf = (overrides: Record<string, unknown> = {}) =>
  EngramSchema.parse({
    id: 'ENG-2026-08-23-001',
    statement: 'A statement',
    type: 'behavioral',
    scope: 'global',
    status: 'active',
    content_hash: 'a'.repeat(64),
    ...overrides,
  })

const subjectOf = (record: any) =>
  record['@graph'].find((n: any) => String(n['@id']).startsWith('engram:ENG'))

describe('the policy must not contradict the prose', () => {
  it('forbids passing on a private memory, in the record itself', () => {
    // The readable summary said "Not permission to share". The record said
    // odrl:distribute was permitted, with no prohibition anywhere. A machine
    // reading the machine-readable format would have reached the wrong answer,
    // which is the only one of the two that gets acted on without a human.
    const record = buildProvenanceRecord(engramOf({ visibility: 'private' }))
    const policy = subjectOf(record)['odrl:hasPolicy']
    const forbidden = (policy['odrl:prohibition'] ?? []).map((p: any) => p['odrl:action'])
    expect(forbidden).toContain('odrl:distribute')
  })

  it('says why it is forbidden, so the licence does not get the blame', () => {
    const record = buildProvenanceRecord(engramOf({ visibility: 'private' }))
    const stop = subjectOf(record)['odrl:hasPolicy']['odrl:prohibition']
      .find((p: any) => p['engram:reason'] === 'notShared')
    expect(stop).toBeDefined()
    expect(String(stop['engram:note'])).toContain('not permission to pass the memory on')
  })

  it('forbids it for a local memory too, whatever its visibility', () => {
    const record = buildProvenanceRecord(engramOf({ scope: 'local' }))
    const forbidden = (subjectOf(record)['odrl:hasPolicy']['odrl:prohibition'] ?? [])
      .map((p: any) => p['odrl:action'])
    expect(forbidden).toContain('odrl:distribute')
  })

  it('leaves a shareable memory alone', () => {
    const record = buildProvenanceRecord(engramOf({
      visibility: 'public', provenance: { origin: 'x', license: 'cc-by-4.0' },
    }))
    const policy = subjectOf(record)['odrl:hasPolicy']
    expect(policy['odrl:prohibition']).toBeUndefined()
    expect(subjectOf(record)['engram:maySharePlainly']).toBe(true)
  })

  it('answers the share question in one field a machine can read', () => {
    // Getting it right required reading three lines of prose, or understanding
    // a policy vocabulary. One boolean removes both requirements.
    expect(subjectOf(buildProvenanceRecord(engramOf({ visibility: 'private' })))['engram:maySharePlainly']).toBe(false)
  })

  it('keeps the licence prohibitions as well as the sharing one', () => {
    // A non-commercial licence on a private memory must forbid BOTH things.
    const record = buildProvenanceRecord(engramOf({
      visibility: 'private', provenance: { origin: 'x', license: 'cc-by-nc-4.0' },
    }))
    const forbidden = subjectOf(record)['odrl:hasPolicy']['odrl:prohibition']
      .map((p: any) => p['odrl:action'])
    expect(forbidden).toContain('odrl:commercialize')
    expect(forbidden).toContain('odrl:distribute')
  })
})

describe('identifiers in the record have to be legal', () => {
  it('does not put a raw space inside an identifier', () => {
    // "engram:agent/Platform Lead" is not a legal identifier. A strict reader is
    // entitled to reject the whole document over it.
    const record = buildProvenanceRecord(engramOf({ attribution: { asserted_by: 'Platform Lead' } }))
    const id = subjectOf(record)['prov:wasAttributedTo']['@id']
    expect(id).not.toContain(' ')
    expect(id).toBe('engram:agent/Platform%20Lead')
    // A colon is legal and stays readable: local:maintainer must NOT become local%3Acrt.
    const plain = buildProvenanceRecord(engramOf({ attribution: { asserted_by: 'local:maintainer' } }))
    expect(subjectOf(plain)['prov:wasAttributedTo']['@id']).toBe('engram:agent/local:maintainer')
  })

  it('leaves a Decentralized Identifier as its own identifier', () => {
    // A DID is already an address. Prefixing it makes a different, meaningless
    // one and throws away the property that made it worth accepting.
    const record = buildProvenanceRecord(engramOf({
      attribution: { asserted_by: 'did:example:platform-lead' },
    }))
    expect(subjectOf(record)['prov:wasAttributedTo']['@id']).toBe('did:example:platform-lead')
  })

  it('leaves a web address alone too', () => {
    const record = buildProvenanceRecord(engramOf({
      attribution: { asserted_by: 'https://example.org/people/alice' },
    }))
    expect(subjectOf(record)['prov:wasAttributedTo']['@id']).toBe('https://example.org/people/alice')
  })

  it('escapes a runtime name with awkward characters', () => {
    const record = buildProvenanceRecord(engramOf({
      attribution: { runtime: { name: 'my runtime', version: '1.0 beta' } },
    }))
    const software = record['@graph'].find((n: any) => String(n['@id']).includes('agent/software'))
    expect(software['@id']).not.toContain(' ')
  })
})

describe('a pack name must not escape its directory', () => {
  let dir: string
  const engrams = [engramOf({ visibility: 'public' })]

  it('refuses a name that walks up out of the output directory', () => {
    // This wrote a full pack into the tester's home directory.
    dir = mkdtempSync(join(tmpdir(), 'plur-packname-'))
    expect(() => exportPack(engrams, dir, { name: '../escape', version: '1.0.0' }))
      .toThrow(/not usable as a directory name/)
    rmSync(dir, { recursive: true, force: true })
  })

  it.each(['a/b', 'a\\b', '.', '..', '.hidden', '', '   '])('refuses %j', (name) => {
    dir = mkdtempSync(join(tmpdir(), 'plur-packname-'))
    expect(() => exportPack(engrams, dir, { name, version: '1.0.0' })).toThrow()
    rmSync(dir, { recursive: true, force: true })
  })

  it('still accepts an ordinary name', () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-packname-'))
    expect(() => exportPack(engrams, dir, { name: 'ops-conventions', version: '1.0.0' })).not.toThrow()
    rmSync(dir, { recursive: true, force: true })
  })
})
